import type { crmCanais } from '../db/schema';
import { dentroDaJanela, proximaAbertura } from './fila-envio.service';

type Canal = Pick<typeof crmCanais.$inferSelect, 'atendimentoAtivo' | 'atendimentoInicio' | 'atendimentoFim' | 'atendimentoDias'>;

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const FUSO_MS = 3 * 3600_000;

export const MENSAGEM_FORA_HORARIO_PADRAO = 'Oi! Recebemos sua mensagem 💛 Nosso atendimento é {{horario}}. A equipe responde {{retorno}}.';

const janela = (c: Canal) => ({ envioInicio: c.atendimentoInicio, envioFim: c.atendimentoFim, envioDias: c.atendimentoDias, envioIntervaloMinS: 0, envioIntervaloMaxS: 0 });

/** "de segunda a sexta, das 09:00 às 18:00" */
export function descreverHorario(c: Canal) {
  const d = [...c.atendimentoDias].sort();
  const seguidos = d.length > 2 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const dias = d.length === 7 ? 'todos os dias' : seguidos ? `de ${DIAS[d[0]]} a ${DIAS[d.at(-1)!]}` : d.map((x) => DIAS[x]).join(', ').replace(/, ([^,]*)$/, ' e $1');
  return `${dias}, das ${c.atendimentoInicio} às ${c.atendimentoFim}`;
}

/** Fora do horário do atendimento humano? Devolve quando a equipe volta ("amanhã a partir das 09:00"). Null = dentro ou sem horário. */
export function foraDoHorario(c: Canal, agora = new Date()): { horario: string; retorno: string; volta: Date | null } | null {
  if (!c.atendimentoAtivo || !c.atendimentoDias.length) return null;
  const j = janela(c);
  if (dentroDaJanela(j, agora)) return null;
  const volta = proximaAbertura(j, agora);
  let retorno = 'no próximo horário de atendimento';
  if (volta) {
    const dia = (t: Date) => Math.floor((t.getTime() - FUSO_MS) / 86_400_000);
    const dif = dia(volta) - dia(agora);
    const sem = new Date(volta.getTime() - FUSO_MS).getUTCDay();
    const quando = dif === 0 ? 'hoje' : dif === 1 ? 'amanhã' : sem === 0 ? 'no domingo' : sem === 6 ? 'no sábado' : `na ${DIAS[sem]}-feira`;
    retorno = `${quando} a partir das ${c.atendimentoInicio}`;
  }
  return { horario: descreverHorario(c), retorno, volta };
}

export function mensagemForaHorario(modelo: string, f: { horario: string; retorno: string }) {
  return (modelo.trim() || MENSAGEM_FORA_HORARIO_PADRAO).replace(/\{\{\s*horario\s*\}\}/g, f.horario).replace(/\{\{\s*retorno\s*\}\}/g, f.retorno);
}
