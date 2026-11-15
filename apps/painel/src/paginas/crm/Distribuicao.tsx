import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../../api';
import { dataHora } from '../../formato';
import { Campo, Carregando, Erro } from '../../componentes/ui';
import { usarCanais } from './comum';

interface Config { ativo: boolean; destino: 'consultoras' | 'lideres'; raioKm: number; prazoMinutos: number; maxTentativas: number; maxAbertos: number; soComMaleta: boolean; avisarWhatsapp: boolean; canalId: string | null }
const PADRAO: Config = { ativo: false, destino: 'consultoras', raioKm: 50, prazoMinutos: 60, maxTentativas: 3, maxAbertos: 10, soComMaleta: false, avisarWhatsapp: true, canalId: null };

/** CRM › Configurar › Distribuição: por funil, para quem e com que regras o lead novo é entregue. */
export function Distribuicao() {
  const q = useQuery({ queryKey: ['crm', 'distribuicao'], queryFn: () => api<{ funil: { id: string; nome: string; tipo: string }; config: Config | null }[]>('/crm/distribuicao') });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  return (
    <div className="coluna" style={{ gap: 14 }}>
      <p className="muted" style={{ margin: 0 }}>
        O lead novo do funil vai para a consultora (ou líder) ativa mais perto, pela cidade dele (do formulário, da candidatura ou do card; sem cidade, pela região do DDD).
        Ela recebe o aviso no WhatsApp e aceita no portal; só depois de aceitar vê o telefone. Sem aceite no prazo, passa para a próxima; esgotadas as tentativas, volta para a equipe com a etiqueta "Sem consultora".
      </p>
      {q.data!.map((x) => <FunilDistribuicao key={x.funil.id} funil={x.funil} config={x.config} />)}
    </div>
  );
}

function FunilDistribuicao({ funil, config }: { funil: { id: string; nome: string; tipo: string }; config: Config | null }) {
  const qc = useQueryClient();
  const canais = usarCanais();
  const editar = pode('crm', 'editar');
  const [c, setC] = useState<Config>(config ?? { ...PADRAO, destino: funil.tipo === 'recrutamento' ? 'lideres' : 'consultoras' });
  useEffect(() => { if (config) setC(config); }, [config]);
  const salvar = useMutation({ mutationFn: () => api(`/crm/distribuicao/${funil.id}`, { metodo: 'PUT', corpo: c }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'distribuicao'] }) });
  const n = (k: keyof Config) => (e: React.ChangeEvent<HTMLInputElement>) => setC({ ...c, [k]: Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0) });
  return (
    <div className="cartao">
      <div className="flex entre" style={{ gap: 10, alignItems: 'center' }}>
        <div><b>{funil.nome}</b> {config?.ativo ? <span className="etiqueta ok">Distribuindo</span> : <span className="etiqueta">Desligado</span>}</div>
        <label className="check"><input type="checkbox" disabled={!editar} checked={c.ativo} onChange={(e) => setC({ ...c, ativo: e.target.checked })} /> Distribuir por localização</label>
      </div>
      {c.ativo && (
        <div className="form" style={{ marginTop: 10 }}>
          <Campo rotulo="Para quem vai" className="l2"><select disabled={!editar} value={c.destino} onChange={(e) => setC({ ...c, destino: e.target.value as Config['destino'] })}><option value="consultoras">Consultoras (revendedoras ativas)</option><option value="lideres">Só líderes (quem tem equipe)</option></select></Campo>
          <Campo rotulo="Distância máxima (km)" ajuda="Mais longe que isso, fica com a equipe."><input disabled={!editar} inputMode="numeric" value={c.raioKm} onChange={n('raioKm')} /></Campo>
          <Campo rotulo="Prazo para aceitar (min)"><input disabled={!editar} inputMode="numeric" value={c.prazoMinutos} onChange={n('prazoMinutos')} /></Campo>
          <Campo rotulo="Tentativas" ajuda="Quantas pessoas recebem antes de voltar para a equipe."><input disabled={!editar} inputMode="numeric" value={c.maxTentativas} onChange={n('maxTentativas')} /></Campo>
          <Campo rotulo="Máximo em aberto por pessoa" ajuda="Quem já tem isso tudo em aberto não recebe mais."><input disabled={!editar} inputMode="numeric" value={c.maxAbertos} onChange={n('maxAbertos')} /></Campo>
          <div className="campo l2"><label>&nbsp;</label>
            <label className="check"><input type="checkbox" disabled={!editar} checked={c.soComMaleta} onChange={(e) => setC({ ...c, soComMaleta: e.target.checked })} /> Só quem está com maleta aberta</label>
            <label className="check"><input type="checkbox" disabled={!editar} checked={c.avisarWhatsapp} onChange={(e) => setC({ ...c, avisarWhatsapp: e.target.checked })} /> Avisar pelo WhatsApp</label>
          </div>
          {c.avisarWhatsapp && (
            <Campo rotulo="Avisar pelo número" className="l2" ajuda="Prefira um número por QR code: o oficial só manda texto livre dentro de 24 h da última mensagem da consultora.">
              <select disabled={!editar} value={c.canalId ?? ''} onChange={(e) => setC({ ...c, canalId: e.target.value || null })}><option value="">Escolher sozinho</option>{canais.data?.filter((x) => x.ativo).map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}</select>
            </Campo>
          )}
        </div>
      )}
      {salvar.error && <Erro erro={salvar.error} />}
      {editar && <div style={{ marginTop: 10 }}><button className="botao pequeno" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Salvar</button>{salvar.isSuccess && <span className="muted" style={{ marginLeft: 8 }}>Salvo.</span>}</div>}
    </div>
  );
}

const SITUACAO: Record<string, [string, string]> = {
  aguardando: ['Aguardando aceite', 'alerta'],
  aceito: ['Em atendimento pela consultora', 'ok'],
  concluido: ['Atendido pela consultora', 'ok'],
  sem_consultora: ['Ninguém perto', 'erro'],
  devolvido: ['Voltou para a equipe', 'erro'],
};

/** Bloco no card do lead: com quem está, desde quando, e as consultoras mais perto para escolher. */
export function BlocoDistribuicao({ lead }: { lead: any }) {
  const qc = useQueryClient();
  const editar = pode('crm', 'editar');
  const [ver, setVer] = useState(false);
  const perto = useQuery({ queryKey: ['crm', 'lead', lead.id, 'perto'], queryFn: () => api<any>(`/crm/leads/${lead.id}/perto`), enabled: ver });
  const acao = useMutation({
    mutationFn: ({ rota, corpo }: { rota: string; corpo?: unknown }) => api<any>(`/crm/leads/${lead.id}/${rota}`, { corpo: corpo ?? {} }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm', 'lead', lead.id] }); qc.invalidateQueries({ queryKey: ['crm', 'leads'] }); setVer(false); },
  });
  const sit = lead.distribuicao ? SITUACAO[lead.distribuicao] : null;
  if (lead.status !== 'aberto' && !lead.consultora) return null;
  return (
    <div className="bloco">
      <h3>Consultora perto</h3>
      {sit && <div style={{ marginBottom: 6 }}><span className={`etiqueta ${sit[1]}`}>{sit[0]}</span></div>}
      {lead.consultora && (
        <>
          <div className="par"><span>Com</span><span><Link to={`/rede/${lead.consultora.id}`}>{lead.consultora.nome}</Link></span></div>
          {lead.consultora.cidade && <div className="par"><span>De</span><span>{lead.consultora.cidade}{lead.distanciaKm != null ? (lead.distanciaKm < 1 ? ' · mesma cidade' : ` · ${String(lead.distanciaKm).replace('.', ',')} km`) : ''}</span></div>}
          {lead.distribuidoEm && <div className="par"><span>Recebeu</span><span>{dataHora(lead.distribuidoEm)}</span></div>}
          {lead.aceitoEm && <div className="par"><span>Aceitou</span><span>{dataHora(lead.aceitoEm)}</span></div>}
        </>
      )}
      {editar && lead.status === 'aberto' && (
        <div className="flex" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ rota: 'distribuir' })}>{lead.consultora ? 'Passar para a próxima' : 'Distribuir agora'}</button>
          <button className="botao claro pequeno" onClick={() => setVer(!ver)}>Escolher</button>
          {lead.consultora && <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ rota: 'devolver' })}>Tirar dela</button>}
        </div>
      )}
      {acao.error && <Erro erro={acao.error} />}
      {acao.data && 'distribuido' in acao.data && !acao.data.distribuido && <p className="muted" style={{ fontSize: 13 }}>Ninguém livre perto: veja o motivo no histórico.</p>}
      {ver && (
        perto.isLoading ? <Carregando /> : perto.error ? <Erro erro={perto.error} /> : !perto.data.local ? <p className="muted" style={{ fontSize: 13 }}>Não deu para saber a cidade deste lead. Preencha o campo "Cidade" no card.</p> : (
          <div style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Perto de {perto.data.local.cidade}/{perto.data.local.uf}{perto.data.local.origem === 'ddd' ? ' (pela região do telefone)' : ''}</div>
            {perto.data.lista.map((p: any) => (
              <button key={p.id} className="lc-opcao" disabled={acao.isPending} onClick={() => acao.mutate({ rota: 'distribuir', corpo: { pessoaId: p.id } })}>
                <b>{p.nome}</b>
                <span className="muted">{p.cidade} · {p.distanciaKm < 1 ? 'mesma cidade' : `${String(p.distanciaKm).replace('.', ',')} km`} · {p.abertos} em aberto{p.jaRecebeu ? ' · já recebeu' : ''}</span>
              </button>
            ))}
            {!perto.data.lista.length && <p className="muted" style={{ fontSize: 13 }}>Nenhuma {perto.data.destino === 'lideres' ? 'líder' : 'consultora'} ativa com cidade cadastrada.</p>}
          </div>
        )
      )}
    </div>
  );
}
