import type { Db } from '../comum/db.module';
import { iaAgentes } from '../db/schema';

/** Cópia de um especialista: nasce desligada, com chave "<chave>_copia" (ou _copia2…) e nome "(cópia)", se não vierem outros. */
export async function duplicarEspecialista(db: Db, o: typeof iaAgentes.$inferSelect, novo: { funcao?: string; nome?: string } = {}) {
  const existentes = new Set((await db.select({ f: iaAgentes.funcao }).from(iaAgentes)).map((x) => x.f));
  let funcao = novo.funcao ?? `${o.funcao}_copia`.slice(0, 30);
  if (novo.funcao && existentes.has(funcao)) throw new Error(`Já existe um especialista com a chave "${funcao}".`);
  for (let n = 2; existentes.has(funcao); n++) funcao = `${o.funcao.slice(0, 22)}_copia${n}`;
  const [a] = await db.insert(iaAgentes).values({ funcao, nome: (novo.nome ?? `${o.nome} (cópia)`).slice(0, 60), quando: o.quando, instrucoes: o.instrucoes, conhecimento: o.conhecimento, ativo: false, ordem: o.ordem + 1 }).returning();
  return a;
}

/** Especialistas sugeridos para começar (a equipe edita, desliga ou cria outros). */
export const ESPECIALISTAS_SUGERIDOS = [
  {
    funcao: 'vendas',
    nome: 'Vendas',
    ordem: 1,
    quando: 'Cliente final querendo comprar ou conhecer peças: preço, modelos, materiais, banho, garantia da peça, disponibilidade, catálogo, como comprar, entrega e retirada.',
    instrucoes:
      'Ajude a pessoa a encontrar a peça certa: pergunte para quem é, a ocasião e a preferência (dourado ou prateado, delicado ou marcante). Quando ela mandar foto, descreva o que vê e diga que vai confirmar se tem igual. Preço e estoque só com o que estiver no conhecimento; se não estiver, diga que vai confirmar. Quando ela quiser fechar, passe para a equipe.',
    conhecimento: '',
  },
  {
    funcao: 'recrutamento',
    nome: 'Quero revender',
    ordem: 2,
    quando: 'Pessoa interessada em revender ou trabalhar com a empresa: como funciona a maleta (consignado), revenda, afiliada, ganhos, requisitos, como se cadastrar.',
    instrucoes:
      'Explique os modelos de trabalho com o que estiver no conhecimento, sem prometer ganho. Descubra a cidade da pessoa, se já vende algo e como prefere trabalhar. Para se cadastrar, mande o link do formulário de candidatas se estiver no conhecimento; senão, diga que a equipe vai entrar em contato e passe a conversa.',
    conhecimento: '',
  },
  {
    funcao: 'revendedora',
    nome: 'Revendedora',
    ordem: 3,
    quando: 'Quem já é revendedora falando da maleta, do acerto, de reposição de peças, do limite, de pontos, prêmios ou comissão, ou pedindo ajuda para vender.',
    instrucoes:
      'Trate como parceira da empresa. Use o que o sistema sabe dela (maleta, data do acerto, parcelas) para responder sem perguntar o que já se sabe. Dúvidas de como vender e de como funciona o acerto você responde; pedido de nova maleta, troca de peças, mudança de limite e qualquer valor a pagar você passa para a equipe com o motivo.',
    conhecimento: '',
  },
];
