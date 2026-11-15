import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { assinarCades, lerCertificado } from './assinatura';

/** Certificado de teste parecido com um e-CNPJ (CN "NOME:CNPJ", emitido por uma "AC" de teste). */
function pfxDeTeste(senha: string) {
  const ac = forge.pki.rsa.generateKeyPair(2048);
  const acCert = forge.pki.createCertificate();
  acCert.publicKey = ac.publicKey;
  acCert.serialNumber = '01';
  acCert.validity.notBefore = new Date('2026-01-01');
  acCert.validity.notAfter = new Date('2030-01-01');
  const acNome = [{ shortName: 'CN', value: 'AC Teste' }, { shortName: 'O', value: 'ICP-Brasil' }];
  acCert.setSubject(acNome);
  acCert.setIssuer(acNome);
  acCert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  acCert.sign(ac.privateKey, forge.md.sha256.create());
  const k = forge.pki.rsa.generateKeyPair(2048);
  const c = forge.pki.createCertificate();
  c.publicKey = k.publicKey;
  c.serialNumber = '00a1b2c3d4';
  c.validity.notBefore = new Date('2026-01-01');
  c.validity.notAfter = new Date('2027-06-30');
  c.setSubject([{ shortName: 'CN', value: 'ARITANA SEMIJOIAS LTDA:11222333000181' }, { shortName: 'O', value: 'ICP-Brasil' }]);
  c.setIssuer(acNome);
  c.sign(ac.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(k.privateKey, [c, acCert], senha, { algorithm: '3des' });
  return { pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'), acPem: forge.pki.certificateToPem(acCert) };
}

describe('assinatura CAdES do AFD/AEJ', () => {
  const { pfx, acPem } = pfxDeTeste('senha-teste');

  it('lê o certificado: titular, CNPJ, emissor e validade; recusa senha errada', () => {
    const c = lerCertificado(pfx, 'senha-teste');
    expect(c.titular).toBe('ARITANA SEMIJOIAS LTDA:11222333000181');
    expect(c.cnpj).toBe('11222333000181');
    expect(c.emissor).toBe('AC Teste');
    expect(c.icpBrasil).toBe(true);
    expect(c.validoAte.toISOString().slice(0, 10)).toBe('2027-06-30');
    expect(c.cadeia).toHaveLength(1);
    expect(() => lerCertificado(pfx, 'errada')).toThrow(/senha/);
  });

  it('gera .p7s destacado que o OpenSSL confere (assinatura, conteúdo e cadeia)', () => {
    const c = lerCertificado(pfx, 'senha-teste');
    const afd = Buffer.from('0000000001100000000000000000000000000000000000000000000Aritana João\r\n999999999\r\n', 'latin1');
    const p7s = assinarCades(afd, c);
    const dir = mkdtempSync(join(tmpdir(), 'p7s-'));
    writeFileSync(join(dir, 'afd.txt'), afd);
    writeFileSync(join(dir, 'afd.p7s'), p7s);
    writeFileSync(join(dir, 'ac.pem'), acPem);
    const saida = execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', join(dir, 'afd.p7s'), '-content', join(dir, 'afd.txt'), '-CAfile', join(dir, 'ac.pem'), '-purpose', 'any', '-out', '/dev/null'], { stdio: 'pipe' });
    expect(saida).toBeDefined();
    // conteúdo alterado: a verificação falha
    writeFileSync(join(dir, 'afd.txt'), Buffer.concat([afd, Buffer.from('x')]));
    expect(() => execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', join(dir, 'afd.p7s'), '-content', join(dir, 'afd.txt'), '-CAfile', join(dir, 'ac.pem'), '-purpose', 'any', '-out', '/dev/null'], { stdio: 'pipe' })).toThrow();
    // atributo signing-certificate-v2 presente (CAdES-BES)
    const texto = execFileSync('openssl', ['cms', '-cmsout', '-print', '-inform', 'DER', '-in', join(dir, 'afd.p7s')]).toString();
    expect(texto).toMatch(/id-smime-aa-signingCertificateV2/);
    expect(texto).toMatch(/signingTime/);
  });
});
