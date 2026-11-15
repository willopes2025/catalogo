import { createHash } from 'node:crypto';
import forge from 'node-forge';

/**
 * Assinatura dos arquivos do ponto (Portaria 671, art. 83/84): o AFD e o AEJ vão com uma assinatura
 * destacada (.p7s) no padrão CAdES, feita com o certificado ICP-Brasil (e-CNPJ A1) da empresa.
 *
 * O node-forge não sabe incluir o atributo signing-certificate-v2 (obrigatório no CAdES-BES),
 * então o SignedData é montado aqui, campo a campo (RFC 5652 + RFC 5035).
 */

const { asn1 } = forge;
const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsa: '1.2.840.113549.1.1.1',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  /** CNPJ no SubjectAltName (otherName) dos certificados e-CNPJ. */
  cnpjIcp: '2.16.76.1.3.3',
};

export interface Certificado {
  chave: forge.pki.rsa.PrivateKey;
  certificado: forge.pki.Certificate;
  cadeia: forge.pki.Certificate[];
  titular: string;
  cnpj: string | null;
  emissor: string;
  serie: string;
  validoDe: Date;
  validoAte: Date;
  icpBrasil: boolean;
}

const seq = (v: forge.asn1.Asn1[]) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, v);
const set = (v: forge.asn1.Asn1[]) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, v);
const oid = (o: string) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(o).getBytes());
const int = (n: number) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(n).getBytes());
const octets = (b: string) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, b);
const nulo = () => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, '');
const ctx = (n: number, v: forge.asn1.Asn1[], construido = true) => asn1.create(asn1.Class.CONTEXT_SPECIFIC, n, construido, v);
const algSha256 = () => seq([oid(OID.sha256)]);
const der = (a: forge.asn1.Asn1) => asn1.toDer(a).getBytes();
const nome = (attrs: forge.pki.CertificateField[]) => attrs.map((a) => `${a.shortName ?? a.name}=${a.value}`).join(', ');

/** Abre o .pfx/.p12 com a senha e confere que tem a chave e o certificado. */
export function lerCertificado(pfx: Buffer, senha: string): Certificado {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1.fromDer(forge.util.createBuffer(pfx.toString('binary'))), false, senha);
  } catch {
    throw new Error('Não foi possível abrir o certificado: confira o arquivo (.pfx ou .p12) e a senha.');
  }
  const chaves = [...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []), ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  const chave = chaves[0]?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!chave) throw new Error('O arquivo não tem a chave privada. Exporte o certificado A1 com a chave (arquivo .pfx).');
  // O certificado da empresa é o que casa com a chave; o resto é a cadeia (AC intermediária e raiz).
  const doTitular = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(chave.n));
  if (!doTitular) throw new Error('O certificado do titular não está no arquivo.');
  const cnpjSan = (() => {
    const san = doTitular.getExtension('subjectAltName') as { altNames?: { type: number; value: string }[] } | null;
    for (const a of san?.altNames ?? []) {
      // otherName: o valor vem em DER; o CNPJ são 14 dígitos dentro dele.
      if (a.type === 0 && typeof a.value === 'string' && a.value.includes(asn1.oidToDer(OID.cnpjIcp).getBytes())) {
        const m = a.value.match(/\d{14}/);
        if (m) return m[0];
      }
    }
    return null;
  })();
  const cn = String(doTitular.subject.getField('CN')?.value ?? '');
  return {
    chave,
    certificado: doTitular,
    cadeia: certs.filter((c) => c !== doTitular),
    titular: cn || nome(doTitular.subject.attributes),
    cnpj: cnpjSan ?? cn.match(/(\d{14})\s*$/)?.[1] ?? null,
    emissor: String(doTitular.issuer.getField('CN')?.value ?? nome(doTitular.issuer.attributes)),
    serie: doTitular.serialNumber,
    validoDe: doTitular.validity.notBefore,
    validoAte: doTitular.validity.notAfter,
    icpBrasil: /ICP-Brasil/i.test(nome(doTitular.issuer.attributes)) || doTitular.issuer.attributes.some((a) => /ICP-Brasil/i.test(String(a.value))),
  };
}

/** Partes do certificado tiradas do próprio DER (emissor e número de série exatamente como foram assinados). */
function partes(c: forge.pki.Certificate) {
  const a = forge.pki.certificateToAsn1(c);
  const bytes = der(a);
  const tbs = (a.value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
  const i = tbs[0].tagClass === asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  return { asn1: a, bytes, serial: tbs[i], emissor: tbs[i + 2] };
}

/** Assinatura CAdES-BES destacada (o .p7s não leva o conteúdo do arquivo, só a assinatura dele). */
export function assinarCades(conteudo: Buffer, c: Pick<Certificado, 'chave' | 'certificado' | 'cadeia'>, quando = new Date()): Buffer {
  const titular = partes(c.certificado);
  const resumo = createHash('sha256').update(conteudo).digest().toString('binary');
  const hashCert = createHash('sha256').update(Buffer.from(titular.bytes, 'binary')).digest().toString('binary');
  const issuerSerial = seq([seq([ctx(4, [titular.emissor])]), titular.serial]);
  const atributos = [
    seq([oid(OID.contentType), set([oid(OID.data)])]),
    seq([oid(OID.signingTime), set([asn1.create(asn1.Class.UNIVERSAL, asn1.Type.UTCTIME, false, asn1.dateToUtcTime(quando))])]),
    seq([oid(OID.messageDigest), set([octets(resumo)])]),
    // ESSCertIDv2 com SHA-256 (algoritmo padrão, por isso omitido) e o emissor + série.
    seq([oid(OID.signingCertificateV2), set([seq([seq([seq([octets(hashCert), issuerSerial])])])])]),
  ]
    // DER: os elementos de um SET OF vão em ordem crescente da codificação.
    .map((x) => ({ x, d: der(x) }))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    .map((x) => x.x);
  // A assinatura é sobre os atributos codificados como SET (tag 0x31), não como [0].
  const md = forge.md.sha256.create();
  md.update(der(set(atributos)));
  const assinatura = c.chave.sign(md);
  const signerInfo = seq([
    int(1),
    seq([titular.emissor, titular.serial]),
    algSha256(),
    ctx(0, atributos),
    seq([oid(OID.rsa), nulo()]),
    octets(assinatura),
  ]);
  const signedData = seq([
    int(1),
    set([algSha256()]),
    seq([oid(OID.data)]),
    ctx(0, [titular.asn1, ...c.cadeia.map((x) => forge.pki.certificateToAsn1(x))]),
    set([signerInfo]),
  ]);
  return Buffer.from(der(seq([oid(OID.signedData), ctx(0, [signedData])])), 'binary');
}
