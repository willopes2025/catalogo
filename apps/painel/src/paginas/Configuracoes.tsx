import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, pode } from '../api';
import { centavosParaTexto, paraCentavos } from '../formato';
import { Campo, Carregando, Erro, Topo } from '../componentes/ui';

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

export function Configuracoes() {
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
      <Topo eb="Configurações" titulo="Regras do consignado" sub="Valores provisórios até a Aritana confirmar os percentuais. Mudanças valem para os próximos acertos." acoes={editavel && <button className="botao" onClick={() => salvar.mutate()} disabled={salvar.isPending}>Salvar regras</button>} />
      {salvar.isSuccess && <div className="aviso ok" style={{ marginBottom: 12 }}>Regras salvas.</div>}
      {salvar.error && <div style={{ marginBottom: 12 }}><Erro erro={salvar.error} /></div>}
      <div className="cartao form">
        {CAMPOS.map(([k, r, a]) => (
          <Campo key={k} rotulo={r} ajuda={a}><input value={t[k] ?? ''} onChange={(e) => setT({ ...t, [k]: e.target.value })} inputMode="decimal" disabled={!editavel} /></Campo>
        ))}
        <div className="campo"><label>Peça perdida ou quebrada</label><select value={perdida ? 'custo' : 'preco'} onChange={(e) => setPerdida(e.target.value === 'custo')} disabled={!editavel}><option value="custo">Cobrada pelo custo</option><option value="preco">Cobrada pelo preço de venda</option></select></div>
        <p className="muted l4">A comissão de cada nível (Bronze, Prata, Ouro, Líder) pode substituir a comissão padrão: isso será configurado na tela de Níveis.</p>
      </div>
    </>
  );
}
