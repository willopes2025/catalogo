import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CONJUNTOS, montarConsulta } from './dados';

const base = { modo: 'resumo' as const, metricas: [], agruparPor: [], filtros: [], ordem: 'desc' as const, limite: 10 };
const texto = (c: ReturnType<typeof montarConsulta>) => new PgDialect().sqlToQuery(c.consulta);

describe('motor de consultas do assistente', () => {
  it('recusa nomes que não são do conjunto (nada de SQL vindo da IA)', () => {
    expect(() => montarConsulta({ ...base, conjunto: 'usuarios' })).toThrow(/Conjunto desconhecido/);
    expect(() => montarConsulta({ ...base, conjunto: 'vendas_itens', agruparPor: ['senha_hash'] })).toThrow(/não é dimensão/);
    expect(() => montarConsulta({ ...base, conjunto: 'vendas_itens', metricas: ['1; drop table vendas'] })).toThrow(/não é métrica/);
    expect(() => montarConsulta({ ...base, conjunto: 'comissoes', de: '2026-01-01' })).toThrow(/não tem período/);
  });
  it('valores de filtro e datas vão como parâmetros', () => {
    const q = texto(montarConsulta({ ...base, conjunto: 'vendas_itens', agruparPor: ['produto'], filtros: [{ campo: 'vendedor', operador: 'contem', valor: "x' or 1=1 --" }], de: '2026-11-01', ate: '2026-11-30' }));
    expect(q.sql).not.toContain("1=1");
    expect(q.params).toEqual(expect.arrayContaining(["%x' or 1=1 --%", '2026-11-01', '2026-11-30', 10]));
  });
  it('limite máximo de 200 linhas', () => {
    expect(texto(montarConsulta({ ...base, conjunto: 'estoque', modo: 'lista', limite: 5000 })).params).toContain(200);
  });
  it('nenhum conjunto expõe colunas sensíveis', () => {
    const tudo = JSON.stringify(CONJUNTOS);
    for (const proibido of ['senha', 'token', 'link_token', 'cpf', 'documento', 'salario', 'valor_cifrado', 'pix_copia']) expect(tudo).not.toContain(proibido);
  });
});
