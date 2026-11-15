import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { pct, reais } from '../../formato';
import { BarrasTempo, Cartao, COR, mesCurto, Tabela } from './comum';
import './indicadores.css';

interface Linha { mes: string; jueri: number; plataforma: number; total: number; acertos: number; pecas_vendidas: number; pecas_acertadas: number; sell_through_pb: number; consultoras: number }
interface Resp { linhas: Linha[]; jueri: { acertos: number; de: string | null; ate: string | null; vendido: number }; produtos?: any[] }
const br = (d: string | null) => (d ? d.split('-').reverse().join('/') : '');

/** Venda da rede mês a mês, juntando o histórico do Jueri com os acertos feitos aqui. */
export function HistoricoRede({ pessoaId, i = 0 }: { pessoaId?: string; i?: number }) {
  const q = useQuery({ queryKey: ['indicadores', 'historico', pessoaId ?? 'rede'], queryFn: () => api<Resp>(pessoaId ? `/indicadores/historico/pessoa/${pessoaId}` : '/indicadores/historico') });
  if (!q.data) return null;
  const d = q.data;
  // Corta os meses vazios do começo para o gráfico não ficar com uma rampa de zeros.
  const primeiro = d.linhas.findIndex((l) => l.total > 0);
  if (primeiro < 0) return pessoaId ? null : <Cartao i={i} titulo="Venda da rede mês a mês" sub="últimos 24 meses"><p className="muted">Sem acertos ainda. Para ver os meses antes da plataforma, importe o histórico do Jueri em Configurações › Importar.</p></Cartao>;
  const linhas = d.linhas.slice(Math.max(0, Math.min(primeiro, d.linhas.length - 6)));
  const temJueri = d.jueri.acertos > 0;
  const ult12 = d.linhas.slice(-12).reduce((a, l) => a + l.total, 0);
  const ant12 = d.linhas.slice(-24, -12).reduce((a, l) => a + l.total, 0);
  return (
    <>
      <Cartao i={i} titulo={pessoaId ? 'Vendas mês a mês' : 'Venda da rede mês a mês'} sub={temJueri ? `com o histórico do Jueri (${br(d.jueri.de)} a ${br(d.jueri.ate)})` : 'acertos feitos na plataforma'}>
        <BarrasTempo
          pontos={linhas.map((l) => ({ rotulo: mesCurto(l.mes), valores: { jueri: l.jueri, plataforma: l.plataforma }, extra: `${l.acertos} acerto(s) · ${pct(l.sell_through_pb)} vendido${pessoaId ? '' : ` · ${l.consultoras} consultora(s)`}` }))}
          rotuloACada={linhas.length > 14 ? 3 : linhas.length > 8 ? 2 : 1}
          series={temJueri ? [['jueri', 'No Jueri', COR.neutro], ['plataforma', 'Na plataforma', COR.rede]] : [['plataforma', 'Na plataforma', COR.rede]]}
        />
        {ant12 > 0 && (
          <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            Últimos 12 meses: <b>{reais(ult12)}</b> contra {reais(ant12)} nos 12 anteriores ({ult12 >= ant12 ? '+' : ''}{pct(Math.round(((ult12 - ant12) * 10000) / ant12))}).
          </p>
        )}
      </Cartao>
      {!pessoaId && temJueri && d.produtos && d.produtos.length > 0 && (
        <Cartao i={i + 1} titulo="O que a rede mais vendia no Jueri" sub="últimos 12 meses do histórico">
          <Tabela nome="historico-produtos-jueri" linhas={d.produtos} limite={15} colunas={[['referencia', 'Ref.'], ['descricao', 'Produto'], ['vendidas', 'Vendidas', 'num'], ['vendido', 'Vendido', 'dinheiro'], ['sell_through_pb', '% vendido', 'pct']]} />
        </Cartao>
      )}
    </>
  );
}
