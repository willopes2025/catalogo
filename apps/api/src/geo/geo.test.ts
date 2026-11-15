import { describe, expect, it } from 'vitest';
import { dddDoTelefone, distanciaKm, localizar, siglaUf } from './geo';

describe('localização pela cidade e pelo DDD', () => {
  it('acha a cidade com e sem acento, com UF junto e por extenso', () => {
    expect(localizar({ cidade: 'Vila Velha', uf: 'ES' })).toMatchObject({ cidade: 'Vila Velha', uf: 'ES', origem: 'cidade' });
    expect(localizar({ cidade: 'vitoria', uf: 'espírito santo' })).toMatchObject({ cidade: 'Vitória', uf: 'ES' });
    expect(localizar({ cidade: 'Serra - ES' })).toMatchObject({ cidade: 'Serra', uf: 'ES' });
    expect(siglaUf('São Paulo')).toBe('SP');
  });
  it('cidade com nome repetido em outros estados: o DDD desempata', () => {
    // Há "Serra" só no ES, mas "Bom Jesus" existe em vários estados.
    expect(localizar({ cidade: 'Bom Jesus', telefone: '5589999990000' })?.uf).toBe('PI');
    expect(localizar({ cidade: 'Bom Jesus', telefone: '5586999990000' })?.uf).toBe('PI'); // DDD 86 é do PI, mesmo não sendo o da cidade
    expect(localizar({ cidade: 'Bom Jesus', telefone: '5554999990000' })?.uf).toBe('RS');
  });
  it('sem cidade, usa a região do DDD', () => {
    expect(dddDoTelefone('+55 (27) 99999-0000')).toBe(27);
    expect(localizar({ telefone: '27999990000' })).toMatchObject({ uf: 'ES', origem: 'ddd' });
    expect(localizar({ cidade: 'Cidade Inventada' })).toBeNull();
  });
  it('distância entre Vitória e Vila Velha é curta; até Linhares é longe', () => {
    const vix = localizar({ cidade: 'Vitória', uf: 'ES' })!;
    expect(distanciaKm(vix, localizar({ cidade: 'Vila Velha', uf: 'ES' })!)).toBeLessThan(15);
    expect(distanciaKm(vix, localizar({ cidade: 'Linhares', uf: 'ES' })!)).toBeGreaterThan(100);
  });
});
