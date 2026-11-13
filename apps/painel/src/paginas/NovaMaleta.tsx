import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, pode } from '../api';
import { reais } from '../formato';
import { Campo, Erro, Topo } from '../componentes/ui';
import { Leitor, type ItemLido } from '../componentes/Leitor';

interface Situacao {
  representante: { id: string; nome: string; status: string; modeloTrabalho: string | null };
  limite: number; emMaletas: number; creditoLivre: number; maletasAbertas: number; maiorAtrasoDias: number; titulosVencidos: number; saldoCredito: number; bloqueado: boolean; motivoBloqueio: string | null;
}

export function NovaMaleta() {
  const [params] = useSearchParams();
  const navegar = useNavigate();
  const [repId, setRepId] = useState(params.get('representante') ?? '');
  const [buscaRep, setBuscaRep] = useState('');
  const [origemId, setOrigemId] = useState('');
  const [entrega, setEntrega] = useState<'retirada' | 'envio'>('retirada');
  const [obs, setObs] = useState('');
  const [itens, setItens] = useState<ItemLido[]>([]);
  const [excecao, setExcecao] = useState(false);

  const reps = useQuery({ queryKey: ['reps-ativas', buscaRep], queryFn: () => api<{ itens: any[] }>(`/pessoas?tipo=representante&status=ativo&busca=${encodeURIComponent(buscaRep)}`) });
  const locais = useQuery({ queryKey: ['locais'], queryFn: () => api<any[]>('/estoque/locais') });
  const sit = useQuery({ queryKey: ['situacao', repId], queryFn: () => api<Situacao>(`/maletas/situacao/${repId}`), enabled: !!repId });
  useEffect(() => {
    if (!origemId && locais.data?.length) setOrigemId(locais.data.find((l) => l.tipo === 'deposito')?.id ?? locais.data[0].id);
  }, [locais.data, origemId]);

  const valor = itens.reduce((a, i) => a + i.preco * i.quantidade, 0);
  const s = sit.data;
  const motivos: string[] = [];
  if (s) {
    if (s.bloqueado) motivos.push(`Bloqueada: ${s.motivoBloqueio ?? 'sem motivo informado'}`);
    if (s.maletasAbertas > 0) motivos.push(`Já tem ${s.maletasAbertas} maleta aberta.`);
    if (s.maiorAtrasoDias > 0) motivos.push(`Pendência com ${s.maiorAtrasoDias} dias de atraso.`);
    if (valor > s.creditoLivre) motivos.push(`Passa ${reais(valor - s.creditoLivre)} do crédito livre.`);
    if (s.representante.modeloTrabalho !== 'consignado') motivos.push(`Modelo de trabalho: ${s.representante.modeloTrabalho}.`);
  }
  const podeExcecao = pode('configuracoes', 'editar');

  const criar = useMutation({
    mutationFn: () => api<{ id: string }>('/maletas', { corpo: { representanteId: repId, origemId, entrega, observacao: obs || null, itens: itens.map((i) => ({ codigoBarras: i.codigoBarras, quantidade: i.quantidade })), liberarExcecao: excecao } }),
    onSuccess: (m) => navegar(`/maletas/${m.id}`),
  });

  return (
    <>
      <Topo eb="Maletas · Nova" titulo="Montar maleta" />
      <div className="grade" style={{ gridTemplateColumns: '1fr 340px', alignItems: 'start' }}>
        <div className="coluna">
          <div className="cartao form">
            <div className="secao">1. Representante e retirada</div>
            <Campo rotulo="Buscar representante" className="l2"><input placeholder="Nome ou cidade" value={buscaRep} onChange={(e) => setBuscaRep(e.target.value)} /></Campo>
            <Campo rotulo="Representante" className="l2">
              <select value={repId} onChange={(e) => setRepId(e.target.value)}>
                <option value="">Escolha</option>
                {reps.data?.itens.map((r) => <option key={r.id} value={r.id}>{r.nome}{r.cidade ? ` · ${r.cidade}` : ''}</option>)}
              </select>
            </Campo>
            <Campo rotulo="Peças saem de"><select value={origemId} onChange={(e) => setOrigemId(e.target.value)}>{locais.data?.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select></Campo>
            <Campo rotulo="Entrega"><select value={entrega} onChange={(e) => setEntrega(e.target.value as 'retirada')}><option value="retirada">Retirada presencial</option><option value="envio">Envio (Correios ou motoboy)</option></select></Campo>
            <Campo rotulo="Observação para a representante" className="l2"><input value={obs} onChange={(e) => setObs(e.target.value)} /></Campo>
          </div>
          <div className="cartao">
            <div className="secao" style={{ marginBottom: 12 }}>2. Peças</div>
            <Leitor itens={itens} mudar={setItens} />
          </div>
        </div>
        <div className="coluna" style={{ position: 'sticky', top: 20 }}>
          <div className="cartao">
            <h3 style={{ marginBottom: 10 }}>3. Conferência</h3>
            {!s ? <p className="muted">Escolha a representante para ver o crédito.</p> : (
              <>
                <div className="resumo-linha"><span>Limite</span><b>{reais(s.limite)}</b></div>
                <div className="resumo-linha"><span>Já em maletas</span><span>{reais(s.emMaletas)}</span></div>
                <div className="resumo-linha"><span>Crédito livre</span><b>{reais(s.creditoLivre)}</b></div>
                <div className="resumo-linha"><span>Esta maleta</span><b style={{ color: valor > s.creditoLivre ? 'var(--erro)' : undefined }}>{reais(valor)}</b></div>
                <div className="resumo-linha"><span>Peças</span><span>{itens.reduce((a, i) => a + i.quantidade, 0)}</span></div>
                {s.saldoCredito > 0 && <div className="resumo-linha"><span>Créditos a usar no acerto</span><span>{reais(s.saldoCredito)}</span></div>}
              </>
            )}
          </div>
          {motivos.length > 0 && (
            <div className="aviso alerta">
              <b>Não liberada pelas regras:</b>
              <ul>{motivos.map((m) => <li key={m}>{m}</li>)}</ul>
              {podeExcecao && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={excecao} onChange={(e) => setExcecao(e.target.checked)} /> Liberar como exceção (fica registrado)</label>}
            </div>
          )}
          {criar.error && <Erro erro={criar.error} />}
          <button className="botao" disabled={!repId || !origemId || !itens.length || criar.isPending || (motivos.length > 0 && !excecao)} onClick={() => criar.mutate()}>
            {criar.isPending ? 'Criando…' : 'Criar maleta e baixar do estoque'}
          </button>
          <p className="muted">Ao criar, as peças saem do estoque de origem e passam a ficar na maleta da representante. O prazo do acerto é contado a partir de hoje.</p>
        </div>
      </div>
    </>
  );
}
