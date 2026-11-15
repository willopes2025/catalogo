import { describe, expect, it } from 'vitest';
import { crc16, dh, gerarAfd, hashMarcacao } from './arquivos-ponto';

describe('arquivos do ponto (Portaria 671)', () => {
  it('CRC-16/KERMIT confere com o valor de checagem', () => expect(crc16('123456789')).toBe('2189'));
  it('data e hora no formato do leiaute', () => expect(dh(new Date('2021-04-27T19:44:31Z'))).toBe('2021-04-27T16:44:00-0300'));
  it('AFD: tamanhos fixos, hash encadeado, trailer e assinatura', () => {
    const m1 = { nsr: 2, marcadoEm: new Date('2026-11-16T11:00:00Z'), cpf: '39053344705', gravadoEm: new Date('2026-11-16T11:00:02Z'), coletor: '02', online: true };
    const h1 = hashMarcacao(m1, null);
    const m2 = { ...m1, nsr: 3, marcadoEm: new Date('2026-11-16T15:00:00Z'), gravadoEm: new Date('2026-11-16T15:00:01Z') };
    const h2 = hashMarcacao(m2, h1);
    expect(h2).not.toBe(hashMarcacao(m2, null));
    const buf = gerarAfd({
      empregador: { cnpj: '12.345.678/0001-90', razaoSocial: 'Aritana Semijoias Ltda', local: 'Vila Velha' },
      inpi: '', desenvolvedor: { documento: '11222333000181', nome: 'Wide', email: 'a@b.c', programa: 'Plataforma Aritana', versao: '1' },
      de: '2026-11-01', ate: '2026-11-30',
      registros: [
        { nsr: 1, tipo: 5, gravadoEm: new Date('2026-11-01T12:00:00Z'), cpf: '39053344705', dados: { operacao: 'I', nome: 'Maria da Silva', responsavelCpf: '11122233344' } },
        { ...m1, tipo: 7, hash: h1, dados: {} },
        { ...m2, tipo: 7, hash: h2, dados: {} },
      ],
    });
    const linhas = buf.toString('latin1').split('\r\n').filter(Boolean);
    expect(linhas[0].length).toBe(302);
    expect(linhas[1].length).toBe(118);
    expect(linhas[2].length).toBe(137);
    expect(linhas[2].slice(73)).toBe(h1);
    expect(linhas[3].slice(0, 9)).toBe('000000003');
    expect(linhas[4]).toBe('999999999' + '000000000'.repeat(3) + '000000001' + '000000000' + '000000002' + '9');
    expect(linhas[5].trim()).toBe('ASSINATURA_DIGITAL_EM_ARQUIVO_P7S');
    expect(linhas[5].length).toBe(100);
    // CRC do cabeçalho confere com o próprio conteúdo
    expect(crc16(linhas[0].slice(0, 298))).toBe(linhas[0].slice(298));
  });
});
