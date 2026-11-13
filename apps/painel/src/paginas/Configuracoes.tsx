import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, pode } from '../api';
import { centavosParaTexto, paraCentavos } from '../formato';
import { Abas, Campo, Carregando, Erro, Topo } from '../componentes/ui';
import { Usuarios, Grupos, Modelos, Integracoes, Empresas } from './ConfiguracoesOutras';
import { Importacao } from './Importacao';
import { AvisosERegras } from './ConfiguracoesAvisos';
import { Link } from 'react-router-dom';

type Regras = Record<string, number | boolean>;

/** Campos em pontos-base aparecem como % na tela. */
const PCT = ['comissaoAvistaPb', 'comissaoPrazoPb', 'multaAtrasoPb', 'jurosMesPb', 'aumentoLimitePb', 'metaMinimaVendidaPb'];
const DIN = ['limiteInicial', 'limiteMaximo'];

const CAMPOS: [string, string, string][] = [
  ['prazoAcertoDias', 'Prazo do acerto (dias)', 'Contado a partir da retirada'],
  ['comissaoAvistaPb', 'Comissão à vista (%)', 'Quando o acerto é pago à vista'],
  ['comissaoPrazoPb', 'Comissão a prazo (%)', 'Boleto ou cartão parcelado'],
  ['parcelasMaximas', 'Parcelas máximas', 'No acerto a prazo'],
  ['multaAtrasoPb', 'Multa por atraso (%)', 'Cobrada uma vez'],
  ['jurosMesPb', 'Juros por mês (%)', 'Proporcional aos dias'],
  ['carenciaDias', 'Carência (dias)', 'Tolerância antes da multa'],
  ['diasParaBloquear', 'Dias de atraso para bloquear', 'Impede nova maleta'],
  ['limiteInicial', 'Limite da 1ª maleta (R$)', ''],
  ['limiteMaximo', 'Limite máximo (R$)', ''],
  ['aumentoLimitePb', 'Aumento após acerto bom (%)', 'Em dia e com a meta batida'],
  ['metaMinimaVendidaPb', 'Meta mínima vendida (%)', 'Do valor da maleta'],
  ['maletasSimultaneas', 'Maletas abertas ao mesmo tempo', 'Por representante'],
];

type Aba = 'regras' | 'avisos' | 'empresas' | 'usuarios' | 'grupos' | 'modelos' | 'integracoes' | 'importacao';

export function Configuracoes() {
  const [aba, setAba] = useState<Aba>('regras');
  return (
    <>
      <Topo eb="Configurações" titulo={{ regras: 'Regras do consignado', avisos: 'Avisos, etiquetas e outras regras', empresas: 'Empresas', usuarios: 'Usuários', grupos: 'Grupos e permissões', modelos: 'Modelos de documento', integracoes: 'Integrações', importacao: 'Importar planilhas' }[aba]} acoes={<Link to="/auditoria" className="botao claro">Auditoria</Link>} />
      <Abas ativa={aba} mudar={setAba} abas={[['regras', 'Regras do consignado'], ['avisos', 'Avisos e regras'], ['empresas', 'Empresas'], ['usuarios', 'Usuários'], ['grupos', 'Grupos e permissões'], ['modelos', 'Modelos de documento'], ['integracoes', 'Integrações'], ['importacao', 'Importar planilhas']]} />
      {aba === 'regras' && <Regras />}
      {aba === 'avisos' && <AvisosERegras />}
      {aba === 'empresas' && <Empresas />}
      {aba === 'usuarios' && <Usuarios />}
      {aba === 'grupos' && <Grupos />}
      {aba === 'modelos' && <Modelos />}
      {aba === 'integracoes' && <Integracoes />}
      {aba === 'importacao' && <Importacao />}
    </>
  );
}

function Regras() {
  const q = useQuery({ queryKey: ['regras'], queryFn: () => api<Regras>('/configuracoes/regras-consignado') });
  const [t, setT] = useState<Record<string, string>>({});
  const [perdida, setPerdida] = useState(true);
  useEffect(() => {
    if (!q.data) return;
    setT(Object.fromEntries(CAMPOS.map(([k]) => [k, PCT.includes(k) ? String((q.data![k] as number) / 100).replace('.', ',') : DIN.includes(k) ? centavosParaTexto(q.data![k] as number) : String(q.data![k])])));
    setPerdida(!!q.data.perdidaPeloCusto);
  }, [q.data]);
  const salvar = useMutation({
    mutationFn: () => {
      const corpo: Regras = { perdidaPeloCusto: perdida };
      for (const [k] of CAMPOS) corpo[k] = PCT.includes(k) ? Math.round(Number(t[k].replace(',', '.')) * 100) : DIN.includes(k) ? paraCentavos(t[k]) : Number(t[k]);
      return api('/configuracoes/regras-consignado', { metodo: 'PUT', corpo });
    },
  });
  if (q.isLoading) return <Carregando />;
  const editavel = pode('configuracoes', 'editar');
  return (
    <>
      <div className="flex entre" style={{ marginBottom: 12 }}>
        <p className="muted">Valores provisórios até a Aritana confirmar os percentuais. Mudanças valem para os próximos acertos e entram nos novos contratos.</p>
        {editavel && <button className="botao" onClick={() => salvar.mutate()} disabled={salvar.isPending}>Salvar regras</button>}
      </div>
      {salvar.isSuccess && <div className="aviso ok" style={{ marginBottom: 12 }}>Regras salvas.</div>}
      {salvar.error && <div style={{ marginBottom: 12 }}><Erro erro={salvar.error} /></div>}
      <div className="cartao form">
        {CAMPOS.map(([k, r, a]) => (
          <Campo key={k} rotulo={r} ajuda={a}><input value={t[k] ?? ''} onChange={(e) => setT({ ...t, [k]: e.target.value })} inputMode="decimal" disabled={!editavel} /></Campo>
        ))}
        <div className="campo"><label>Peça perdida ou quebrada</label><select value={perdida ? 'custo' : 'preco'} onChange={(e) => setPerdida(e.target.value === 'custo')} disabled={!editavel}><option value="custo">Cobrada pelo custo</option><option value="preco">Cobrada pelo preço de venda</option></select></div>
        <p className="muted l4">A comissão de cada nível (Bronze, Prata, Ouro, Líder) pode substituir a comissão padrão, em Rede › Níveis e metas.</p>
      </div>
      <RegrasVenda />
    </>
  );
}

function RegrasVenda() {
  const q = useQuery({ queryKey: ['regras-venda'], queryFn: () => api<Record<string, number>>('/configuracoes/regras-venda') });
  const [t, setT] = useState<Record<string, string>>({});
  useEffect(() => { if (q.data) setT({ descontoMaximoPb: String(q.data.descontoMaximoPb / 100).replace('.', ','), prazoTrocaDias: String(q.data.prazoTrocaDias), prazoDebitoDias: String(q.data.prazoDebitoDias), prazoCreditoDias: String(q.data.prazoCreditoDias) }); }, [q.data]);
  const salvar = useMutation({ mutationFn: () => api('/configuracoes/regras-venda', { metodo: 'PUT', corpo: { descontoMaximoPb: Math.round(Number((t.descontoMaximoPb ?? '0').replace(',', '.')) * 100), prazoTrocaDias: Number(t.prazoTrocaDias), prazoDebitoDias: Number(t.prazoDebitoDias), prazoCreditoDias: Number(t.prazoCreditoDias) } }) });
  const editavel = pode('configuracoes', 'editar');
  const campo = (k: string, r: string, a: string) => <Campo rotulo={r} ajuda={a}><input value={t[k] ?? ''} onChange={(e) => setT({ ...t, [k]: e.target.value })} inputMode="decimal" disabled={!editavel} /></Campo>;
  return (
    <div className="cartao form" style={{ marginTop: 14 }}>
      <div className="secao">Regras de venda (loja, eventos e vendas avulsas)</div>
      {campo('descontoMaximoPb', 'Desconto máximo (%)', 'Acima disso, só a gerência')}
      {campo('prazoTrocaDias', 'Prazo de troca (dias)', 'Devolução depois da compra')}
      {campo('prazoDebitoDias', 'Débito cai em (dias)', 'Previsão no financeiro')}
      {campo('prazoCreditoDias', 'Crédito cai em (dias)', 'Por parcela')}
      <div className="l4">{salvar.isSuccess && <span className="muted">Salvo. </span>}{salvar.error && <Erro erro={salvar.error} />}{editavel && <button className="botao claro" onClick={() => salvar.mutate()} disabled={salvar.isPending}>Salvar regras de venda</button>}</div>
    </div>
  );
}
