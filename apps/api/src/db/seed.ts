/**
 * Dados iniciais. Cria a estrutura real (empresas, locais, grupos, níveis, regras)
 * e, com SEED_EXEMPLOS=1, produtos e representantes FICTÍCIOS para testar.
 * Nenhum dado real de representante ou cliente entra aqui: esses vêm da migração do Jueri.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { REGRAS_PADRAO } from '@aritana/regras';
import { criarConexao, schema as s } from './client';
import { MODELOS_INICIAIS } from './modelos-iniciais';

async function main() {
  const { db, pool } = criarConexao();

  const jaExiste = await db.select().from(s.empresas).limit(1);
  if (jaExiste.length) {
    console.log('Banco já tem dados; seed ignorado.');
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    const [matriz] = await tx
      .insert(s.empresas)
      .values({ nome: 'Aritana Semijoias (Matriz)', tipo: 'matriz', cidade: '', uf: 'ES' })
      .returning();
    const [loja] = await tx
      .insert(s.empresas)
      .values({ nome: 'Aritana Joias e Semi Joias (Loja)', tipo: 'loja', uf: 'ES' })
      .returning();

    await tx.insert(s.locaisEstoque).values([
      { empresaId: matriz.id, nome: 'Depósito da matriz', tipo: 'deposito' },
      { empresaId: loja.id, nome: 'Loja', tipo: 'loja' },
    ]);

    const [diretoria] = await tx
      .insert(s.grupos)
      .values([
        { nome: 'Diretoria', permissoes: { '*': ['*'] } },
        {
          nome: 'Gerência comercial',
          permissoes: {
            inicio: ['ver'], rede: ['ver', 'criar', 'editar', 'exportar'], cadastros: ['ver', 'criar', 'editar'],
            produtos: ['ver'], estoque: ['ver'], maletas: ['ver', 'criar', 'editar', 'exportar'], relatorios: ['ver', 'exportar'],
          },
        },
        {
          nome: 'Estoque e expedição',
          permissoes: { inicio: ['ver'], produtos: ['ver', 'criar', 'editar'], estoque: ['ver', 'criar', 'editar'], maletas: ['ver', 'criar', 'editar'] },
        },
        {
          nome: 'Financeiro',
          permissoes: { inicio: ['ver'], financeiro: ['ver', 'criar', 'editar', 'exportar'], maletas: ['ver'], rede: ['ver'], fiscal: ['ver', 'criar'], relatorios: ['ver', 'exportar'] },
        },
        { nome: 'Loja', permissoes: { inicio: ['ver'], lojas: ['ver', 'criar'], produtos: ['ver'], cadastros: ['ver', 'criar'] } },
      ])
      .returning();

    const email = process.env.ADMIN_EMAIL ?? 'admin@aritana.local';
    const senha = process.env.ADMIN_SENHA ?? randomBytes(9).toString('base64url');
    await tx.insert(s.usuarios).values({ nome: 'Administrador', email, senhaHash: await bcrypt.hash(senha, 10), grupoId: diretoria.id });
    if (!process.env.ADMIN_SENHA) console.log(`\nUsuário inicial: ${email}\nSenha inicial:   ${senha}\nTroque a senha no primeiro acesso.\n`);

    await tx.insert(s.niveis).values([
      { nome: 'Bronze', ordem: 1, metaMensal: 100000 },
      { nome: 'Prata', ordem: 2, metaMensal: 250000 },
      { nome: 'Ouro', ordem: 3, metaMensal: 500000 },
      { nome: 'Líder', ordem: 4, metaMensal: 800000 },
    ]);

    await tx.insert(s.configuracoes).values({ chave: 'regras_consignado', valor: REGRAS_PADRAO });
    await tx.insert(s.modelosDocumento).values(MODELOS_INICIAIS);

    await tx.insert(s.contas).values([
      { empresaId: matriz.id, nome: 'Caixa', tipo: 'caixa' },
      { empresaId: matriz.id, nome: 'Asaas Matriz', tipo: 'banco' },
      { empresaId: matriz.id, nome: 'Sicoob Matriz', tipo: 'banco' },
      { empresaId: loja.id, nome: 'Caixa da loja', tipo: 'caixa' },
    ]);

    const cats = await tx
      .insert(s.categorias)
      .values(['Brincos', 'Colares', 'Anéis', 'Pulseiras', 'Conjuntos', 'Tornozeleiras'].map((nome) => ({ nome })))
      .returning();

    if (process.env.SEED_EXEMPLOS !== '1') return;

    // ───── Exemplos fictícios para testes ─────
    const [fornecedor] = await tx
      .insert(s.pessoas)
      .values({ tipo: 'fornecedor', tipoDocumento: 'cnpj', nome: 'Fornecedor Exemplo Ltda', cidade: 'Limeira', uf: 'SP' })
      .returning();
    await tx.insert(s.pessoas).values([
      { tipo: 'cliente', nome: 'Cliente Exemplo', telefone1: '27900000010', cidade: 'Vitória', uf: 'ES', consentimentoLgpd: true },
      { tipo: 'transportadora', tipoDocumento: 'cnpj', nome: 'Transportadora Exemplo', cidade: 'Serra', uf: 'ES' },
      { tipo: 'assistencia', tipoDocumento: 'cnpj', nome: 'Assistência Técnica Exemplo', cidade: 'Vila Velha', uf: 'ES' },
    ]);

    const nomes: Record<string, string[]> = {
      Brincos: ['Argola lisa', 'Ponto de luz', 'Ear cuff trançado', 'Gota cravejada', 'Argola com zircônia'],
      Colares: ['Choker riviera', 'Corrente veneziana', 'Gargantilha coração', 'Colar medalha', 'Choker pérolas'],
      Anéis: ['Anel solitário', 'Aparador cravejado', 'Anel falange', 'Anel trançado'],
      Pulseiras: ['Pulseira riviera', 'Bracelete liso', 'Pulseira elos', 'Pulseira berloque'],
      Conjuntos: ['Conjunto gota', 'Conjunto coração'],
      Tornozeleiras: ['Tornozeleira estrelas'],
    };
    const prods: (typeof s.produtos.$inferInsert)[] = [];
    let seq = 1;
    for (const c of cats) {
      for (const n of nomes[c.nome] ?? []) {
        for (const banho of ['Ouro 18k', 'Ródio']) {
          const preco = 4990 + ((seq * 1730) % 15000);
          prods.push({
            codigoBarras: `789${String(1000000000 + seq).slice(1)}`,
            referencia: `AR${String(seq).padStart(4, '0')}`,
            descricao: `${n} ${banho}`,
            categoriaId: c.id,
            cor: banho === 'Ródio' ? 'Prata' : 'Dourado',
            pesoBanho: banho,
            milesimos: '10',
            fornecedorId: fornecedor.id,
            custo: Math.round(preco * 0.28),
            preco,
            precoAtacado: Math.round(preco * 0.6),
            estoqueMinimo: 3,
          });
          seq++;
        }
      }
    }
    const inseridos = await tx.insert(s.produtos).values(prods).returning();
    const [deposito] = await tx.select().from(s.locaisEstoque).where(eq(s.locaisEstoque.tipo, 'deposito'));
    const [localLoja] = await tx.select().from(s.locaisEstoque).where(eq(s.locaisEstoque.tipo, 'loja'));
    for (const p of inseridos) {
      await tx.insert(s.movimentos).values({ produtoId: p.id, destinoId: deposito.id, quantidade: 20, tipo: 'entrada', motivo: 'Estoque inicial (exemplo)' });
      await tx.insert(s.saldos).values({ produtoId: p.id, localId: deposito.id, quantidade: 20 });
      await tx.insert(s.movimentos).values({ produtoId: p.id, destinoId: localLoja.id, quantidade: 4, tipo: 'entrada', motivo: 'Estoque inicial (exemplo)' });
      await tx.insert(s.saldos).values({ produtoId: p.id, localId: localLoja.id, quantidade: 4 });
    }

    const [bronze] = await tx.select().from(s.niveis).where(eq(s.niveis.nome, 'Bronze'));
    const [lider] = await tx.select().from(s.niveis).where(eq(s.niveis.nome, 'Líder'));
    const [ana] = await tx
      .insert(s.pessoas)
      .values({
        tipo: 'representante', nome: 'Representante Exemplo 1 (líder)', slug: 'representante-exemplo-1', email: 'exemplo1@exemplo.com', telefone1: '27900000001', cidade: 'Vila Velha', uf: 'ES',
        modeloTrabalho: 'consignado', nivelId: lider.id, limiteCredito: 500000, praca: 'Vila Velha',
      })
      .returning();
    await tx.insert(s.pessoas).values([
      { tipo: 'representante', nome: 'Representante Exemplo 2', slug: 'representante-exemplo-2', email: 'exemplo2@exemplo.com', documento: '52998224725', telefone1: '27900000002', cidade: 'Serra', uf: 'ES', modeloTrabalho: 'consignado', nivelId: bronze.id, liderId: ana.id, limiteCredito: 150000, praca: 'Serra' },
      { tipo: 'representante', nome: 'Representante Exemplo 3', slug: 'representante-exemplo-3', telefone1: '27900000003', cidade: 'Cariacica', uf: 'ES', modeloTrabalho: 'revenda', nivelId: bronze.id, liderId: ana.id, limiteCredito: 150000, praca: 'Cariacica' },
      { tipo: 'representante', nome: 'Candidata Exemplo', slug: 'candidata-exemplo', telefone1: '27900000004', cidade: 'Vitória', uf: 'ES', status: 'triagem', modeloTrabalho: 'consignado' },
    ]);
  });

  await pool.end();
  console.log('Seed concluído.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
