import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { urlPublica } from '../comum/url';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { PlanoContasService } from '../financeiro/plano.service';
import { candidaturaNotas, candidaturas, empresas, indicacoes, indicadores, pessoas, titulos, usuarios } from '../db/schema';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const soDigitos = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
/** Telefone sem o 55 do Brasil, para comparar cadastros. */
const tel = (v: string | null | undefined) => soDigitos(v).replace(/^55(?=\d{10,11}$)/, '');
const hojeSP = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const somaDias = (iso: string, dias: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + dias * 86400_000).toISOString().slice(0, 10);

/** Nome que quem indicou vê: só o primeiro nome e a cidade da indicada. */
const primeiroNome = (nome: string) => nome.trim().split(/\s+/)[0] ?? nome;

/**
 * Indique e ganhe: toda pessoa que usa o sistema (consultora no portal ou alguém da equipe no painel)
 * tem um link de indicação. Quem se cadastra por ele vira uma indicação; aprovada como consultora e com o
 * primeiro pedido pago, o prêmio é liberado e vira conta a pagar no Financeiro.
 */
@Injectable()
export class IndicacoesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Indicações');
  private relogio?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: ConfiguracoesService,
    private readonly plano: PlanoContasService,
    private readonly auditoria: AuditoriaService,
  ) {}

  onModuleInit() {
    if (process.env.AVISOS_AUTOMATICOS === '0') return;
    this.relogio = setInterval(() => void this.verificar().catch((e) => this.log.warn(`Verificação falhou: ${(e as Error).message}`)), 30 * 60_000);
    this.relogio.unref?.();
  }

  onModuleDestroy() {
    if (this.relogio) clearInterval(this.relogio);
  }

  regras() {
    return this.config.ler('indicacao');
  }

  /** O código de indicação de uma consultora ou de alguém da equipe (cria na primeira vez). */
  async codigoDe(dono: { pessoaId: string } | { usuarioId: string }): Promise<string> {
    const filtro = 'pessoaId' in dono ? eq(indicadores.pessoaId, dono.pessoaId) : eq(indicadores.usuarioId, dono.usuarioId);
    const [ja] = await this.db.select({ codigo: indicadores.codigo }).from(indicadores).where(filtro);
    if (ja) return ja.codigo;
    for (let i = 0; i < 8; i++) {
      const codigo = Array.from({ length: 7 }, () => LETRAS[randomInt(LETRAS.length)]).join('');
      const [novo] = await this.db.insert(indicadores).values({ codigo, ...dono }).onConflictDoNothing().returning({ codigo: indicadores.codigo });
      if (novo) return novo.codigo;
      // Conflito: ou o código já existe (tenta outro) ou o dono ganhou um código agora mesmo em outra aba.
      const [outro] = await this.db.select({ codigo: indicadores.codigo }).from(indicadores).where(filtro);
      if (outro) return outro.codigo;
    }
    throw new Error('Não deu para gerar o código de indicação.');
  }

  link(codigo: string) {
    return `${urlPublica()}/i/${codigo}`;
  }

  /** Quem é o dono de um código (para o convite e para registrar a indicação). */
  async dono(codigo: string) {
    const c = codigo.trim().toUpperCase();
    if (!/^[A-Z0-9]{5,12}$/.test(c)) return null;
    const [r] = await this.db
      .select({
        id: indicadores.id,
        pessoaId: indicadores.pessoaId,
        usuarioId: indicadores.usuarioId,
        nome: sql<string>`coalesce(${pessoas.nome}, ${usuarios.nome})`,
        cpf: pessoas.documento,
        telefones: sql<string[]>`array_remove(array[${pessoas.telefone1}, ${pessoas.telefone2}, ${pessoas.telefone3}], null)`,
        email: sql<string | null>`coalesce(${pessoas.email}, ${usuarios.email})`,
        ativo: sql<boolean>`coalesce(${usuarios.ativo}, ${pessoas.status} = 'ativo')`,
      })
      .from(indicadores)
      .leftJoin(pessoas, eq(pessoas.id, indicadores.pessoaId))
      .leftJoin(usuarios, eq(usuarios.id, indicadores.usuarioId))
      .where(eq(indicadores.codigo, c));
    return r ?? null;
  }

  /**
   * Uma candidatura chegou com um código de indicação. Vale a primeira indicação (quem trouxe primeiro).
   * Não vale: indicar a si mesmo, ou indicar quem já é (ou já foi) consultora.
   */
  async registrar(candidaturaId: string, codigo: string | null | undefined, porQuem?: string | null) {
    if (!codigo) return null;
    const regras = await this.regras();
    if (!regras.ativo) return null;
    const ind = await this.dono(codigo);
    if (!ind || !ind.ativo) return null;
    const [c] = await this.db.select().from(candidaturas).where(eq(candidaturas.id, candidaturaId));
    if (!c) return null;
    const mesmo =
      (ind.cpf && c.cpf && soDigitos(ind.cpf) === soDigitos(c.cpf)) ||
      (ind.email && c.email && ind.email.toLowerCase() === c.email.toLowerCase()) ||
      (ind.telefones ?? []).some((t) => tel(t) && tel(t) === tel(c.telefone));
    if (mesmo) return null;
    const [jaConsultora] = await this.db
      .select({ id: pessoas.id })
      .from(pessoas)
      .where(and(eq(pessoas.tipo, 'representante'), sql`(${c.cpf ? sql`regexp_replace(coalesce(${pessoas.documento}, ''), '\\D', '', 'g') = ${soDigitos(c.cpf)}` : sql`false`} or regexp_replace(coalesce(${pessoas.telefone1}, ''), '\\D', '', 'g') in (${tel(c.telefone)}, ${'55' + tel(c.telefone)}))`));
    if (jaConsultora) return null;
    const [nova] = await this.db.insert(indicacoes).values({ indicadorId: ind.id, candidaturaId, status: c.etapa === 'recusada' ? 'recusada' : 'candidata' }).onConflictDoNothing().returning();
    if (!nova) return null;
    // O card do recrutamento mostra quem indicou.
    if (!c.indicadaPor) await this.db.update(candidaturas).set({ indicadaPor: `${ind.nome} (link de indicação)` }).where(eq(candidaturas.id, candidaturaId));
    await this.db.insert(candidaturaNotas).values({ candidaturaId, usuarioId: porQuem ?? null, texto: `Veio pelo link de indicação de ${ind.nome}.` });
    return nova;
  }

  /** A candidata foi aprovada: a indicação passa a esperar o primeiro pedido pago. */
  async aoAprovar(candidaturaId: string, pessoaId: string, tx: Tx | Db = this.db) {
    await tx.update(indicacoes).set({ status: 'aprovada', indicadaPessoaId: pessoaId, aprovadaEm: new Date() }).where(and(eq(indicacoes.candidaturaId, candidaturaId), inArray(indicacoes.status, ['candidata', 'recusada'])));
  }

  /** Candidata recusada (ou reaberta depois de recusada). */
  async aoMudarEtapa(candidaturaId: string, etapa: string) {
    if (etapa === 'recusada') await this.db.update(indicacoes).set({ status: 'recusada' }).where(and(eq(indicacoes.candidaturaId, candidaturaId), eq(indicacoes.status, 'candidata')));
    else if (etapa !== 'aprovada') await this.db.update(indicacoes).set({ status: 'candidata' }).where(and(eq(indicacoes.candidaturaId, candidaturaId), eq(indicacoes.status, 'recusada')));
  }

  /**
   * Libera os prêmios das indicadas que já pagaram o primeiro pedido (uma conta a receber dela paga, ou, para a
   * afiliada, o primeiro pedido pelo link faturado) e expira as que passaram do prazo.
   */
  async verificar() {
    const regras = await this.regras();
    const abertas = await this.db
      .select({ i: indicacoes, indicadorPessoaId: indicadores.pessoaId, indicadorUsuarioId: indicadores.usuarioId, indicadorNome: sql<string>`coalesce(${pessoas.nome}, ${usuarios.nome})`, indicadaNome: sql<string>`(select nome from pessoas x where x.id = ${indicacoes.indicadaPessoaId})` })
      .from(indicacoes)
      .innerJoin(indicadores, eq(indicadores.id, indicacoes.indicadorId))
      .leftJoin(pessoas, eq(pessoas.id, indicadores.pessoaId))
      .leftJoin(usuarios, eq(usuarios.id, indicadores.usuarioId))
      .where(eq(indicacoes.status, 'aprovada'));
    let liberadas = 0;
    let expiradas = 0;
    for (const a of abertas) {
      if (!a.i.indicadaPessoaId || !a.i.aprovadaEm) continue;
      const desde = a.i.aprovadaEm.toISOString().slice(0, 10);
      const pago = (
        await this.db.execute<{ motivo: string }>(sql`
          select 'Primeiro pagamento: ' || descricao as motivo from titulos
          where pessoa_id = ${a.i.indicadaPessoaId} and tipo = 'receber' and status = 'pago' and coalesce(valor_pago, valor) > 0 and pago_em >= ${desde}::date
          union all
          select 'Primeiro pedido pelo link faturado: nº ' || p.numero from pedidos_link p join vendas v on v.id = p.venda_id
          where p.pessoa_id = ${a.i.indicadaPessoaId} and v.status = 'concluida' and p.criado_em >= ${a.i.aprovadaEm}
          limit 1`)
      ).rows[0];
      if (!pago) {
        if (Date.now() - a.i.aprovadaEm.getTime() > regras.validadeDias * 86400_000) {
          await this.db.update(indicacoes).set({ status: 'expirada' }).where(and(eq(indicacoes.id, a.i.id), eq(indicacoes.status, 'aprovada')));
          expiradas++;
        }
        continue;
      }
      const daEquipe = !!a.indicadorUsuarioId;
      const valor = daEquipe && regras.valorEquipe !== null ? regras.valorEquipe : regras.valor;
      await this.db.transaction(async (tx) => {
        // Trava a linha: duas verificações ao mesmo tempo não liberam o prêmio duas vezes.
        const [atual] = await tx.select({ status: indicacoes.status }).from(indicacoes).where(eq(indicacoes.id, a.i.id)).for('update');
        if (atual?.status !== 'aprovada') return;
        let tituloId: string | null = null;
        if (regras.lancarNoFinanceiro && valor > 0) {
          const [matriz] = await tx.select({ id: empresas.id }).from(empresas).where(eq(empresas.tipo, 'matriz')).limit(1);
          if (matriz) {
            const [t] = await tx
              .insert(titulos)
              .values({
                empresaId: matriz.id,
                tipo: 'pagar',
                pessoaId: a.indicadorPessoaId,
                descricao: `Prêmio por indicação · ${a.indicadorNome} indicou ${a.indicadaNome ?? 'nova consultora'}${daEquipe ? ' (equipe)' : ''}`,
                categoria: 'Prêmios por indicação',
                ...(await this.plano.daChave('indicacoes')),
                valor,
                vencimento: somaDias(hojeSP(), regras.prazoPagamentoDias),
                origemTipo: 'indicacao',
                origemId: a.i.id,
              })
              .returning({ id: titulos.id });
            tituloId = t.id;
          }
        }
        await tx.update(indicacoes).set({ status: 'liberada', valor, liberadaEm: new Date(), motivoLiberacao: pago.motivo.slice(0, 300), tituloId }).where(eq(indicacoes.id, a.i.id));
      });
      liberadas++;
    }
    if (liberadas || expiradas) this.log.log(`${liberadas} prêmio(s) liberado(s), ${expiradas} indicação(ões) expirada(s).`);
    return { liberadas, expiradas };
  }

  /** O que quem indicou vê: o link e as próprias indicações, sem dados pessoais da indicada além do primeiro nome e da cidade. */
  async meu(dono: { pessoaId: string } | { usuarioId: string }) {
    const regras = await this.regras();
    const codigo = await this.codigoDe(dono);
    const lista = await this.db
      .select({ i: indicacoes, nome: candidaturas.nome, cidade: candidaturas.cidade, uf: candidaturas.uf, tituloStatus: titulos.status })
      .from(indicacoes)
      .innerJoin(indicadores, eq(indicadores.id, indicacoes.indicadorId))
      .innerJoin(candidaturas, eq(candidaturas.id, indicacoes.candidaturaId))
      .leftJoin(titulos, eq(titulos.id, indicacoes.tituloId))
      .where(eq(indicadores.codigo, codigo))
      .orderBy(desc(indicacoes.criadoEm))
      .limit(200);
    const itens = lista.map((l) => ({
      id: l.i.id,
      nome: primeiroNome(l.nome),
      cidade: [l.cidade, l.uf].filter(Boolean).join('/'),
      status: l.i.status === 'liberada' && l.tituloStatus === 'pago' ? 'paga' : l.i.status,
      valor: l.i.valor,
      criadoEm: l.i.criadoEm,
      liberadaEm: l.i.liberadaEm,
    }));
    const daEquipe = 'usuarioId' in dono;
    return {
      ativo: regras.ativo,
      codigo,
      link: this.link(codigo),
      mensagem: regras.mensagemConvite,
      premio: daEquipe && regras.valorEquipe !== null ? regras.valorEquipe : regras.valor,
      validadeDias: regras.validadeDias,
      itens,
      totais: {
        indicadas: itens.length,
        aprovadas: itens.filter((i) => ['aprovada', 'liberada', 'paga'].includes(i.status)).length,
        aReceber: itens.filter((i) => i.status === 'liberada').reduce((a, i) => a + (i.valor ?? 0), 0),
        recebido: itens.filter((i) => i.status === 'paga').reduce((a, i) => a + (i.valor ?? 0), 0),
      },
    };
  }

  /** Cancela uma indicação (ex.: fraude, cadastro duplicado). O prêmio ainda não pago é cancelado no Financeiro. */
  async cancelar(id: string, motivo: string, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [i] = await tx.select().from(indicacoes).where(eq(indicacoes.id, id)).for('update');
      if (!i) return { erro: 'Indicação não encontrada.' };
      if (['cancelada', 'expirada'].includes(i.status)) return { erro: 'Esta indicação já está encerrada.' };
      if (i.tituloId) {
        const [t] = await tx.select({ status: titulos.status }).from(titulos).where(eq(titulos.id, i.tituloId));
        if (t?.status === 'pago') return { erro: 'O prêmio já foi pago; não dá para cancelar.' };
        await tx.update(titulos).set({ status: 'cancelado' }).where(and(eq(titulos.id, i.tituloId), eq(titulos.status, 'aberto')));
      }
      await tx.update(indicacoes).set({ status: 'cancelada', motivoCancelamento: motivo }).where(eq(indicacoes.id, id));
      await this.auditoria.registrar({ usuarioId, acao: 'cancelar', entidade: 'indicacao', entidadeId: id, dados: { motivo, statusAnterior: i.status } }, tx);
      return { ok: true };
    });
  }
}
