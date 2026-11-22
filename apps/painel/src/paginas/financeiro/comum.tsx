import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';

export interface ContaPlano { id: string; codigo: string; nome: string; paiId: string | null; grupo: string; calculada: boolean; chave: string | null; ativo: boolean; titulos: number; nivel: number }
export interface Plano { grupos: { chave: string; nome: string }[]; contas: ContaPlano[] }

export const usePlano = () => useQuery({ queryKey: ['plano-contas'], queryFn: () => api<Plano>('/financeiro/plano-contas'), staleTime: 30_000 });

/** Contas em ordem de árvore (cada conta seguida das suas subcontas). */
export function emArvore(contas: ContaPlano[]): ContaPlano[] {
  const saida: ContaPlano[] = [];
  const cmp = (a: ContaPlano, b: ContaPlano) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true });
  const descer = (paiId: string | null) => contas.filter((c) => c.paiId === paiId).sort(cmp).forEach((c) => { saida.push(c); descer(c.id); });
  descer(null);
  return saida;
}

/** Escolha da conta do plano: grupos como títulos, contas calculadas e desativadas de fora. */
export function SeletorPlano({ valor, mudar, tipo, vazio = 'Sem classificação', autoFocus }: { valor: string; mudar: (id: string) => void; tipo?: 'receber' | 'pagar'; vazio?: string; autoFocus?: boolean }) {
  const q = usePlano();
  const contas = q.data?.contas ?? [];
  const raizes = emArvore(contas).filter((c) => !c.paiId);
  // Para despesa, os grupos de receita ficam no fim (e vice-versa), sem esconder nada.
  const peso = (g: string) => (tipo === 'pagar' ? (g === 'receita' ? 2 : 0) : tipo === 'receber' ? (['receita', 'financeiro', 'outras', 'fora'].includes(g) ? 0 : 2) : 0);
  const ordenadas = [...raizes].sort((a, b) => peso(a.grupo) - peso(b.grupo));
  const filhos = (id: string, nivel: number): { c: ContaPlano; nivel: number }[] => emArvore(contas).filter((c) => c.paiId === id).flatMap((c) => [{ c, nivel }, ...filhos(c.id, nivel + 1)]);
  return (
    <select value={valor} onChange={(e) => mudar(e.target.value)} autoFocus={autoFocus} aria-label="Conta do plano de contas">
      <option value="">{vazio}</option>
      {ordenadas.map((r) => (
        <optgroup key={r.id} label={`${r.codigo} ${r.nome}`}>
          {filhos(r.id, 0).filter(({ c }) => !c.calculada && (c.ativo || c.id === valor)).map(({ c, nivel }) => <option key={c.id} value={c.id}>{'  '.repeat(nivel)}{c.codigo} {c.nome}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export const mesAtual = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
export const somarMeses = (mes: string, n: number) => {
  const d = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const NOMES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const nomeMes = (mes: string) => `${NOMES[Number(mes.slice(5)) - 1]}/${mes.slice(2, 4)}`;
