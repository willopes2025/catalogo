import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, lerSessao, pode } from '../../api';
import { Link } from 'react-router-dom';
import { Abas, Campo, Carregando, Erro, camposComErro } from '../../componentes/ui';
import { Distribuicao } from './Distribuicao';
import { NOME_TIPO_CANAL, NovoCampo, TIPOS_CAMPO, usarAtendentes, usarCampos, usarUsuariosDoCrm, usarCanais, usarFunis, useMidia, variavelDoCampo, type CampoDef, type Canal, type Template, type TipoCanal } from './comum';
import { TextoComVariaveis } from '../../componentes/TextoComVariaveis';

type Sub = 'numeros' | 'funis' | 'distribuicao' | 'campos' | 'templates' | 'respostas' | 'ia' | 'ramais';
const sel = { padding: 7, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' } as const;

export function Configurar() {
  const [sub, setSub] = useState<Sub>('numeros');
  const abas: [Sub, string][] = [['numeros', 'Números de WhatsApp'], ['funis', 'Funis e etapas'], ['distribuicao', 'Distribuição por localização'], ['campos', 'Campos personalizados'], ['templates', 'Templates'], ['respostas', 'Respostas rápidas'], ['ia', 'Agente de IA'], ...(pode('configuracoes', 'editar') ? ([['ramais', 'Ramais (softphone)']] as [Sub, string][]) : [])];
  return (
    <div>
      <Abas ativa={sub} mudar={setSub} abas={abas} />
      {sub === 'numeros' && <Numeros />}
      {sub === 'funis' && <Funis />}
      {sub === 'distribuicao' && <Distribuicao />}
      {sub === 'campos' && <Campos />}
      {sub === 'templates' && <Templates />}
      {sub === 'respostas' && <Respostas />}
      {sub === 'ia' && <AgenteIa />}
      {sub === 'ramais' && <Ramais />}
    </div>
  );
}

// ───────────── Números ─────────────

function Numeros() {
  const canais = usarCanais();
  const opcoes = useQuery({ queryKey: ['crm', 'canais-opcoes'], queryFn: () => api<{ qrcodeProprio: boolean }>('/crm/canais-opcoes'), staleTime: 60_000 });
  const [novo, setNovo] = useState<TipoCanal | 'evolution-token' | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const [recemCriado, setRecemCriado] = useState<string | null>(null);
  const admin = pode('configuracoes', 'editar');
  if (canais.isLoading) return <Carregando />;
  const qrProprio = !!opcoes.data?.qrcodeProprio;
  return (
    <div className="coluna" style={{ gap: 10 }}>
      {admin && !novo && (
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="botao" disabled={!qrProprio} title={qrProprio ? undefined : 'O servidor de WhatsApp por QR code ainda não foi instalado nesta VPS'} onClick={() => setNovo('evolution')}>+ Evolution API por QR code</button>
          <button className="botao" title="Para uma instância que já existe no seu servidor Evolution: endereço, nome da instância e token" onClick={() => setNovo('evolution-token')}>+ Evolution API com token</button>
          <button className="botao claro" onClick={() => setNovo('oficial')}>+ WhatsApp oficial (Meta)</button>
          <button className="botao claro" title="Direct do Instagram pela API oficial da Meta" onClick={() => setNovo('instagram')}>+ Instagram (Direct)</button>
          <button className="botao claro" title="Só para quem já tem conta paga na Z-API. O normal é usar o QR code (Evolution API)." onClick={() => setNovo('qrcode')}>+ Z-API (só se já tiver conta)</button>
          {opcoes.data && !qrProprio && <span className="muted" style={{ fontSize: 13 }}>A Evolution por QR code fica disponível depois de rodar o instalador da VPS de novo. Com token já funciona.</span>}
        </div>
      )}
      {novo && <FormCanal tipo={novo === 'evolution-token' ? 'evolution' : novo} porToken={novo === 'evolution-token'} fechar={(id) => { setNovo(null); if (id) setRecemCriado(id); }} />}
      {canais.error && <Erro erro={canais.error} />}
      {!canais.data?.length && !novo && <div className="cartao vazio">Nenhum número ligado. A Evolution API liga qualquer celular (da empresa ou de uma atendente) de dois jeitos: por QR code, no servidor do próprio sistema, ou com o token de uma instância que você já tem. O oficial serve para disparos em massa com templates aprovados pela Meta.</div>}
      {canais.data?.map((c) => (editando === c.id ? <FormCanal key={c.id} tipo={c.tipo} canal={c} fechar={() => setEditando(null)} /> : <CartaoCanal key={c.id} canal={c} destaque={recemCriado === c.id} editar={() => setEditando(c.id)} />))}
    </div>
  );
}

function CartaoCanal({ canal: c, editar, destaque }: { canal: Canal; editar: () => void; destaque?: boolean }) {
  const qc = useQueryClient();
  const admin = pode('configuracoes', 'editar');
  const sit = useQuery({ queryKey: ['crm', 'canal', c.id, 'situacao'], queryFn: () => api<{ conectado: boolean; detalhe: string; qrcode?: string | null }>(`/crm/canais/${c.id}/situacao`), refetchInterval: (q) => (q.state.data && !q.state.data.conectado && c.tipo !== 'oficial' && c.tipo !== 'instagram' ? (c.tipo === 'evolution' ? 3000 : 5000) : 60_000) });
  const acao = useMutation({ mutationFn: (a: string) => api<any>(`/crm/canais/${c.id}/${a}`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }) });
  const [copiado, setCopiado] = useState(false);
  const [historico, setHistorico] = useState(false);
  const excluir = useMutation({ mutationFn: () => api<{ apagado: boolean }>(`/crm/canais/${c.id}`, { metodo: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }) });
  const confirmarExclusao = () =>
    window.confirm(
      `Excluir o número "${c.nome}"?\n\n` +
        (c.tipo === 'oficial' ? 'Ele para de mandar e receber mensagens por este sistema (na Meta o número continua existindo).' : 'O celular é desconectado e o número para de mandar e receber mensagens por aqui.') +
        '\nAs conversas que já existem continuam no histórico para consulta.',
    ) && excluir.mutate();
  return (
    <div className="cartao" style={destaque ? { borderColor: 'var(--dourado)', boxShadow: '0 0 0 3px rgba(137,111,75,.15)' } : undefined}>
      <div className="flex entre" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div>
          <b>{c.nome}</b> <span className="tag">{c.tipo === 'evolution' && c.config?.servidor ? 'Evolution (token)' : (NOME_TIPO_CANAL[c.tipo] ?? c.tipo)}</span> {!c.ativo && <span className="etiqueta erro">Desativado</span>}
          <div className="muted" style={{ fontSize: 13 }}>
            <span className={`ponto ${sit.data?.conectado ? 'on' : ''}`} />
            {sit.isLoading ? 'Verificando…' : sit.data?.detalhe}
            {c.numero ? ` · ${c.numero}` : ''}
          </div>
          {/* Para conferir se as mensagens estão chegando. */}
          <div className="muted" style={{ fontSize: 12 }}>
            {c.ultimoWebhookEm ? `Último aviso do WhatsApp para o sistema: ${new Date(c.ultimoWebhookEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : c.tipo === 'oficial' ? 'O WhatsApp ainda não avisou o sistema de nenhuma mensagem por este número: confira o webhook no app da Meta.' : 'O WhatsApp ainda não avisou o sistema de nenhuma mensagem por este número. Se já mandaram mensagem para ele, clique em "Mensagens não chegam? Reiniciar".'}
          </div>
        </div>
        {admin && (
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            {c.tipo === 'oficial' && pode('crm', 'excluir') && <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate('templates')}>Sincronizar templates</button>}
            {c.tipo !== 'oficial' && c.tipo !== 'instagram' && <button className="botao claro pequeno" title="Use se as mensagens recebidas pararam de chegar: reaponta o aviso para o sistema e reinicia a conexão com o WhatsApp, sem pedir QR" disabled={acao.isPending} onClick={() => acao.mutate('webhook')}>Mensagens não chegam? Reiniciar</button>}
            {c.tipo !== 'oficial' && c.tipo !== 'instagram' && sit.data?.conectado && <button className="botao claro pequeno" onClick={() => window.confirm('Desconectar este celular do sistema?') && acao.mutate('desconectar')}>Desconectar</button>}
            {c.tipo === 'evolution' && <button className="botao claro pequeno" title="Trazer as conversas antigas deste número, pelo período que você escolher" onClick={() => setHistorico((v) => !v)}>{historico ? 'Fechar histórico' : 'Importar histórico'}</button>}
            <button className="botao claro pequeno" onClick={editar}>Editar</button>
            <button className="botao claro pequeno perigo" disabled={excluir.isPending} onClick={confirmarExclusao}>{excluir.isPending ? 'Excluindo…' : 'Excluir'}</button>
          </div>
        )}
      </div>
      {historico && c.tipo === 'evolution' && <ImportarHistorico canal={c} />}
      {acao.data?.total !== undefined && <div className="aviso ok" style={{ marginTop: 8 }}>{acao.data.total} template(s) na Meta, {acao.data.aprovados} aprovado(s).</div>}
      {(acao.error || excluir.error) && <Erro erro={acao.error ?? excluir.error} />}
      {c.tipo !== 'oficial' && sit.data && !sit.data.conectado && sit.data.qrcode && (
        <div className="flex" style={{ gap: 18, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <img src={sit.data.qrcode} alt="QR code para conectar" style={{ width: 240, height: 240, background: '#fff', padding: 8, borderRadius: 8, border: '1px solid var(--linha)' }} />
          <ol className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, maxWidth: 380 }}>
            <li>Abra o WhatsApp no celular deste número.</li>
            <li>Toque em <b>⋮</b> (ou Configurações no iPhone) › <b>Aparelhos conectados</b>.</li>
            <li>Toque em <b>Conectar um aparelho</b> e aponte para este código.</li>
            <li>Pronto: a bolinha fica verde sozinha. O código se renova a cada poucos segundos.</li>
          </ol>
        </div>
      )}
      {admin && c.webhook && c.tipo !== 'evolution' && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8, wordBreak: 'break-all' }}>
          Webhook: <code>{c.webhook}</code>{' '}
          <button className="botao claro pequeno" onClick={async () => { try { await navigator.clipboard.writeText(c.webhook!); setCopiado(true); } catch { window.prompt('Webhook:', c.webhook); } }}>{copiado ? 'Copiado' : 'Copiar'}</button>
          {c.tipo === 'instagram' && <div>No app da Meta (Instagram › Webhooks, ou Messenger › Configurações do Instagram), cole este endereço como URL de retorno e use como token de verificação o final do endereço (depois da última barra). Assine os campos "messages" (e "messaging_postbacks"). O Instagram precisa ser profissional e estar ligado à página do Facebook do app.</div>}
          {c.tipo === 'oficial' && <div>No app da Meta (WhatsApp › Configuração), cole este endereço como URL de retorno e use como token de verificação o final do endereço (depois da última barra). Assine os campos "messages".</div>}
        </div>
      )}
    </div>
  );
}

type Importacao = { id: string; de: string; ate: string; midias: boolean; status: 'aguardando_qr' | 'recebendo' | 'importando' | 'concluida' | 'erro'; mensagens: number; conversas: number; detalhe: string | null; criadoEm: string; concluidoEm: string | null; conectadoEm: string | null };
const STATUS_IMPORTACAO: Record<Importacao['status'], [string, string]> = {
  aguardando_qr: ['Aguardando ler o QR', 'alerta'],
  recebendo: ['Recebendo do WhatsApp', 'alerta'],
  importando: ['Importando', 'alerta'],
  concluida: ['Concluída', 'ok'],
  erro: ['Não concluída', 'erro'],
};
const diaBr = (d: string) => d.split('-').reverse().join('/');

/** Importa as conversas antigas do número pelo período escolhido. */
function ImportarHistorico({ canal: c }: { canal: Canal }) {
  const qc = useQueryClient();
  const proprio = !c.config?.servidor;
  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const [de, setDe] = useState(new Date(Date.now() - 3 * 3600_000 - 15 * 86400_000).toISOString().slice(0, 10));
  const [ate, setAte] = useState(hoje);
  const [midias, setMidias] = useState(false);
  // Mesma consulta do cartão do número (compartilha o cache): só importa com o celular conectado.
  const sit = useQuery({ queryKey: ['crm', 'canal', c.id, 'situacao'], queryFn: () => api<{ conectado: boolean; detalhe: string; qrcode?: string | null }>(`/crm/canais/${c.id}/situacao`), refetchInterval: (q) => (q.state.data && !q.state.data.conectado ? 3000 : 60_000) });
  const conectado = !proprio || !!sit.data?.conectado;
  const lista = useQuery({
    queryKey: ['crm', 'canal', c.id, 'historico'],
    queryFn: () => api<Importacao[]>(`/crm/canais/${c.id}/historico`),
    refetchInterval: (q) => (q.state.data?.some((i) => !['concluida', 'erro'].includes(i.status)) ? 5000 : false),
  });
  const andamento = lista.data?.find((i) => !['concluida', 'erro'].includes(i.status));
  const importar = useMutation({
    mutationFn: (reconectar: boolean) => api<Importacao>(`/crm/canais/${c.id}/historico`, { corpo: { de, ate, midias, reconectar } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'canal', c.id] }),
  });
  const conferir = useMutation({ mutationFn: () => api('/crm/importacoes/conferir', { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'canal', c.id] }) });
  const cancelar = useMutation({ mutationFn: (id: string) => api(`/crm/importacoes/${id}/cancelar`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'canal', c.id] }) });
  const pedirDeNovo = () => {
    if (!window.confirm('O celular deste número vai ser desconectado e você lê o QR code de novo neste cartão. Ao conectar, o WhatsApp manda as conversas antigas e o sistema grava as do período.\n\nEnquanto não ler, o número fica sem mandar e receber mensagens pelo sistema. Continuar?')) return;
    importar.mutate(true);
  };
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--linha)' }} className="coluna">
      <b>Importar histórico de conversas</b>
      {!conectado && !andamento ? (
        <div className="aviso">Conecte o número primeiro (leia o QR code deste cartão). Assim que a bolinha ficar verde, escolha o período aqui e importe.</div>
      ) : (
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>
          Escolha o período e clique em Importar. As conversas entram como resolvidas (não vão para a fila), sem criar card e sem acionar a IA. Mensagens que já estão no sistema não se repetem.
        </div>
      )}
      {!andamento && conectado && (
        <>
          <div className="flex" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
            <Campo rotulo="De"><input id={`hist-de-${c.id}`} type="date" value={de} max={ate} onChange={(e) => setDe(e.target.value)} /></Campo>
            <Campo rotulo="Até"><input id={`hist-ate-${c.id}`} type="date" value={ate} min={de} max={hoje} onChange={(e) => setAte(e.target.value)} /></Campo>
            <label className="check" title="Mais lento e ocupa espaço no servidor. O WhatsApp costuma apagar as mídias antigas: algumas podem não vir."><input type="checkbox" checked={midias} onChange={(e) => setMidias(e.target.checked)} /> Baixar fotos, áudios e documentos</label>
            <button className="botao pequeno" disabled={!de || !ate || importar.isPending} onClick={() => importar.mutate(false)}>{importar.isPending && !importar.variables ? 'Importando…' : 'Importar'}</button>
          </div>
          {proprio && (
            <div className="muted" style={{ fontSize: 12 }}>
              Faltou conversa? <button className="link" disabled={importar.isPending} onClick={pedirDeNovo}>Pedir o histórico de novo ao WhatsApp</button> (desconecta e pede para ler o QR outra vez).
            </div>
          )}
        </>
      )}
      {importar.error && <Erro erro={importar.error} />}
      {andamento?.status === 'aguardando_qr' && (
        <div className="aviso">
          Leia o QR code deste cartão com o celular do número <b>{c.nome}</b> (WhatsApp › Aparelhos conectados › Conectar um aparelho). Ao conectar, a importação continua sozinha.
          {' '}<button className="link" disabled={cancelar.isPending} onClick={() => cancelar.mutate(andamento.id)}>Desistir desta importação</button>
        </div>
      )}
      {!!lista.data?.length && (
        <div style={{ overflowX: 'auto' }}>
          <table className="tabela">
            <thead><tr><th>Período</th><th>Situação</th><th style={{ textAlign: 'right' }}>Mensagens</th><th style={{ textAlign: 'right' }}>Conversas</th><th>Detalhe</th><th /></tr></thead>
            <tbody>
              {lista.data.map((i) => (
                <tr key={i.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{diaBr(i.de)} a {diaBr(i.ate)}{i.midias ? ' · com mídias' : ''}</td>
                  <td><span className={`etiqueta ${STATUS_IMPORTACAO[i.status][1]}`}>{STATUS_IMPORTACAO[i.status][0]}</span></td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{i.mensagens}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{i.status === 'concluida' ? i.conversas : '—'}</td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 360 }}>{i.detalhe}</td>
                  <td>{!['concluida', 'erro'].includes(i.status) && <div className="flex" style={{ gap: 6 }}><button className="botao claro pequeno" title="O sistema confere sozinho a cada minuto; este botão confere agora" disabled={conferir.isPending} onClick={() => conferir.mutate()}>{conferir.isPending ? 'Conferindo…' : 'Conferir agora'}</button><button className="botao claro pequeno" disabled={cancelar.isPending} onClick={() => cancelar.mutate(i.id)}>Cancelar</button></div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FormCanal({ tipo, canal, fechar, porToken: novoPorToken }: { tipo: TipoCanal; canal?: Canal; fechar: (criadoId?: string) => void; porToken?: boolean }) {
  // Evolution ligada pelo token de uma instância que já existe (em vez do QR code criado pelo sistema).
  const porToken = tipo === 'evolution' && (canal ? !!canal.config?.servidor : !!novoPorToken);
  const qc = useQueryClient();
  const atendentes = usarUsuariosDoCrm();
  const funis = usarFunis();
  const [f, setF] = useState({ nome: canal?.nome ?? '', config: { ...(canal?.config ?? {}) } as Record<string, string>, atendentes: canal?.atendentes ?? [], usuarioId: canal?.usuarioId ?? '', funilEntradaId: canal?.funilEntradaId ?? '', ativo: canal?.ativo ?? true });
  const [envio, setEnvio] = useState({ min: String((canal?.envioIntervaloMinS ?? 180) / 60).replace('.', ','), max: String((canal?.envioIntervaloMaxS ?? 360) / 60).replace('.', ','), inicio: canal?.envioInicio ?? '08:00', fim: canal?.envioFim ?? '18:00', dias: canal?.envioDias ?? [1, 2, 3, 4, 5, 6] });
  const seg = (t: string) => Math.round(Number((t || '0').replace(',', '.')) * 60);
  const salvar = useMutation({
    mutationFn: () => {
      const corpo = { nome: f.nome, config: f.config, atendentes: f.atendentes, usuarioId: f.usuarioId || null, funilEntradaId: f.funilEntradaId || null, ...(canal ? { ativo: f.ativo, envioIntervaloMinS: seg(envio.min), envioIntervaloMaxS: seg(envio.max), envioInicio: envio.inicio, envioFim: envio.fim, envioDias: envio.dias } : { tipo }) };
      return canal ? api<{ id: string }>(`/crm/canais/${canal.id}`, { metodo: 'PATCH', corpo }) : api<{ id: string }>('/crm/canais', { corpo });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['crm'] });
      fechar(canal ? undefined : r?.id);
    },
  });
  const cfg = (k: string, rotulo: string, ajuda?: string, secreto?: boolean) => (
    <Campo rotulo={rotulo} ajuda={ajuda} className="l2">
      <input type={secreto ? 'password' : 'text'} autoComplete="off" value={f.config[k] ?? ''} placeholder={secreto && canal ? 'Deixe como está para não mudar' : ''} onChange={(e) => setF({ ...f, config: { ...f.config, [k]: e.target.value } })} />
    </Campo>
  );
  return (
    <div className="cartao form">
      <div className="secao" style={{ gridColumn: '1 / -1', marginTop: 0 }}>{canal ? `Editar ${canal.nome}` : tipo === 'instagram' ? 'Novo Instagram (Direct pela API da Meta)' : tipo === 'oficial' ? 'Novo WhatsApp oficial (API Cloud da Meta)' : porToken ? 'Evolution API com token (instância que já existe)' : tipo === 'evolution' ? 'Evolution API por QR code' : 'Novo WhatsApp pela Z-API (ID da instância e token)'}</div>
      {porToken && !canal && <p className="muted l4" style={{ margin: 0 }}>Para um número que já está numa instância do seu servidor Evolution. O sistema confere os dados, aponta o webhook da instância para cá e não cria nem apaga nada no seu servidor. Se a instância estiver desconectada, o QR code aparece aqui.</p>}
      {tipo === 'evolution' && !porToken && !canal && <p className="muted l4" style={{ margin: 0 }}>Só dê um nome ao número e salve. O QR code aparece na hora: é ler com o celular e pronto, sem digitar nenhum código.</p>}
      <Campo rotulo="Nome do número" className="l2"><input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder={tipo === 'oficial' ? 'Matriz oficial' : 'Celular da Ana'} /></Campo>
      {tipo === 'instagram' ? (
        <>
          {cfg('igId', 'ID da conta do Instagram (IG User ID)', 'Meta for Developers › Instagram › Configuração da API (ou Graph API: página › instagram_business_account)')}
          {cfg('token', 'Token de acesso', 'Token da página ligada ao Instagram (ou do login do Instagram, começa com IG), com instagram_manage_messages', true)}
          {cfg('appSecret', 'App Secret (recomendado)', 'Confere que o aviso veio mesmo da Meta', true)}
          <p className="muted l4" style={{ margin: 0 }}>Responde as mensagens do Direct pelo CRM, com o mesmo funil e as mesmas filas do WhatsApp. Por enquanto vai só texto, e só dá para responder até 24 horas depois da última mensagem da pessoa (regra da Meta).</p>
        </>
      ) : tipo === 'oficial' ? (
        <>
          {cfg('phoneNumberId', 'Phone Number ID', 'Meta for Developers › WhatsApp › Configuração da API')}
          {cfg('wabaId', 'WhatsApp Business Account ID (WABA)')}
          {cfg('token', 'Token de acesso permanente', 'Usuário do sistema no Gerenciador de Negócios', true)}
          {cfg('appSecret', 'App Secret (recomendado)', 'Confere que o aviso veio mesmo da Meta', true)}
        </>
      ) : porToken ? (
        <>
          {cfg('servidor', 'Endereço do servidor Evolution', 'Ex.: https://evolution.suaempresa.com.br')}
          {cfg('instancia', 'Nome da instância', 'Igual ao do painel da Evolution (maiúsculas e minúsculas contam)')}
          {cfg('token', 'Token da instância (API key)', 'No painel da Evolution, dentro da instância', true)}
        </>
      ) : tipo === 'evolution' ? null : (
        <>
          {cfg('instancia', 'ID da instância', 'Painel da Z-API › Instâncias')}
          {cfg('token', 'Token da instância', undefined, true)}
          {cfg('clientToken', 'Client-Token da conta', 'Z-API › Segurança', true)}
        </>
      )}
      <Campo rotulo="Card novo entra no funil" className="l2" ajuda="Quem escreve pela primeira vez vira card aqui">
        <select value={f.funilEntradaId} onChange={(e) => setF({ ...f, funilEntradaId: e.target.value })}><option value="">Não criar card</option>{funis.data?.map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}</select>
      </Campo>
      {tipo !== 'oficial' && tipo !== 'instagram' && (
        <Campo rotulo="Dono do número (opcional)" className="l2" ajuda="Celular de uma atendente">
          <select value={f.usuarioId} onChange={(e) => setF({ ...f, usuarioId: e.target.value })}><option value="">Número da empresa</option>{atendentes.data?.map((a) => <option key={a.id} value={a.id}>{a.nome} · {a.grupo}{a.semCrm ? ' (sem acesso ao CRM)' : ''}</option>)}</select>
        </Campo>
      )}
      <div className="l4">
        <label className="muted" style={{ fontSize: 13, fontWeight: 600 }}>Quem atende por este número (nenhum marcado = toda a equipe do CRM)</label>
        <div className="flex" style={{ gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
          {atendentes.data?.map((a) => <label key={a.id} className="check"><input type="checkbox" checked={f.atendentes.includes(a.id)} onChange={(e) => setF({ ...f, atendentes: e.target.checked ? [...f.atendentes, a.id] : f.atendentes.filter((x) => x !== a.id) })} /> {a.nome}{a.semCrm && <span className="muted" style={{ fontSize: 12 }}> (sem acesso ao CRM)</span>}</label>)}
        </div>
        {(() => {
          const sem = atendentes.data?.filter((a) => a.semCrm && (a.id === f.usuarioId || f.atendentes.includes(a.id))) ?? [];
          return sem.length ? <div className="aviso" style={{ marginTop: 8 }}>{sem.map((a) => a.nome).join(', ')} ainda não {sem.length > 1 ? 'têm' : 'tem'} acesso ao CRM e não vai ver as conversas deste número. Dê a permissão "CRM › editar" ao grupo em Configurações › Grupos e permissões (ou mude a pessoa para um grupo que já tenha).</div> : null;
        })()}
      </div>
      {canal && (
        <>
          <div className="secao" style={{ gridColumn: '1 / -1' }}>Envio em massa (envio em lote e trilha de cobrança)</div>
          <p className="muted l4" style={{ margin: 0 }}>As mensagens saem uma por vez, com uma espera sorteada entre o mínimo e o máximo, e só nos dias e horários marcados. O que não sair hoje continua no próximo dia permitido. Conversas normais do chat não seguem esta regra.</p>
          <Campo rotulo="Intervalo mínimo (minutos)"><input inputMode="decimal" value={envio.min} onChange={(e) => setEnvio({ ...envio, min: e.target.value })} /></Campo>
          <Campo rotulo="Intervalo máximo (minutos)"><input inputMode="decimal" value={envio.max} onChange={(e) => setEnvio({ ...envio, max: e.target.value })} /></Campo>
          <Campo rotulo="Das"><input type="time" value={envio.inicio} onChange={(e) => setEnvio({ ...envio, inicio: e.target.value })} /></Campo>
          <Campo rotulo="Até"><input type="time" value={envio.fim} onChange={(e) => setEnvio({ ...envio, fim: e.target.value })} /></Campo>
          <div className="l4 flex" style={{ gap: 12, flexWrap: 'wrap' }}>
            {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d, i) => (
              <label key={d} className="check"><input type="checkbox" checked={envio.dias.includes(i)} onChange={(e) => setEnvio({ ...envio, dias: e.target.checked ? [...envio.dias, i].sort() : envio.dias.filter((x) => x !== i) })} /> {d}</label>
            ))}
          </div>
          <label className="check l4"><input type="checkbox" checked={f.ativo} onChange={(e) => setF({ ...f, ativo: e.target.checked })} /> Número ativo</label>
        </>
      )}
      {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
      <div className="flex l4">
        <button className="botao" disabled={!f.nome.trim() || salvar.isPending || (porToken && !canal && !(f.config.servidor?.trim() && f.config.instancia?.trim() && f.config.token?.trim()))} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Preparando…' : porToken ? (canal ? 'Salvar' : 'Conferir e conectar') : tipo === 'evolution' && !canal ? 'Salvar e mostrar o QR code' : 'Salvar'}</button>
        <button className="botao claro" onClick={() => fechar()}>Voltar</button>
      </div>
      {canal && tipo === 'evolution' && <div className="l4"><ImportarHistorico canal={canal} /></div>}
    </div>
  );
}

// ───────────── Funis ─────────────

function Funis() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['crm', 'funis', 'todos'], queryFn: () => api<any[]>('/crm/funis?todos=1') });
  const [novoFunil, setNovoFunil] = useState('');
  const [novaEtapa, setNovaEtapa] = useState<Record<string, string>>({});
  const gestor = pode('crm', 'excluir');
  const ok = () => qc.invalidateQueries({ queryKey: ['crm', 'funis'] });
  const m = useMutation({ mutationFn: ({ rota, metodo, corpo }: { rota: string; metodo?: string; corpo?: unknown }) => api(rota, { metodo, corpo: corpo ?? {} }), onSuccess: ok });
  if (q.isLoading) return <Carregando />;
  return (
    <div className="coluna" style={{ gap: 12 }}>
      {m.error && <Erro erro={m.error} />}
      {q.data?.map((f) => (
        <div key={f.id} className="cartao" style={{ opacity: f.ativo ? 1 : 0.6 }}>
          <div className="flex entre" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input defaultValue={f.nome} disabled={!gestor} onBlur={(e) => e.target.value.trim() && e.target.value !== f.nome && m.mutate({ rota: `/crm/funis/${f.id}`, metodo: 'PATCH', corpo: { nome: e.target.value.trim() } })} style={{ ...sel, fontWeight: 700, minWidth: 260 }} />
            <span className="muted" style={{ fontSize: 13 }}>{f.tipo !== 'outro' ? 'Alimentado sozinho pelo sistema' : ''}</span>
            {gestor && <label className="check"><input type="checkbox" checked={f.ativo} onChange={(e) => m.mutate({ rota: `/crm/funis/${f.id}`, metodo: 'PATCH', corpo: { ativo: e.target.checked } })} /> Ativo</label>}
          </div>
          <table className="tabela" style={{ marginTop: 10 }}>
            <thead><tr><th>Ordem</th><th>Etapa</th><th>Cor</th><th>Tipo</th><th className="num">Cards</th><th></th></tr></thead>
            <tbody>
              {f.etapas.map((e: any, i: number) => (
                <tr key={e.id}>
                  <td>
                    {gestor && (
                      <>
                        <button className="botao claro pequeno" disabled={i === 0} onClick={() => { const ids = f.etapas.map((x: any) => x.id); [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; m.mutate({ rota: `/crm/funis/${f.id}/ordem`, corpo: { ids } }); }}>↑</button>{' '}
                        <button className="botao claro pequeno" disabled={i === f.etapas.length - 1} onClick={() => { const ids = f.etapas.map((x: any) => x.id); [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; m.mutate({ rota: `/crm/funis/${f.id}/ordem`, corpo: { ids } }); }}>↓</button>
                      </>
                    )}
                  </td>
                  <td><input defaultValue={e.nome} disabled={!gestor} onBlur={(ev) => ev.target.value.trim() && ev.target.value !== e.nome && m.mutate({ rota: `/crm/etapas/${e.id}`, metodo: 'PATCH', corpo: { nome: ev.target.value.trim() } })} style={sel} /></td>
                  <td><input type="color" defaultValue={e.cor} disabled={!gestor} onBlur={(ev) => ev.target.value !== e.cor && m.mutate({ rota: `/crm/etapas/${e.id}`, metodo: 'PATCH', corpo: { cor: ev.target.value } })} /></td>
                  <td>
                    <select value={e.tipo} disabled={!gestor || !!e.chave} onChange={(ev) => m.mutate({ rota: `/crm/etapas/${e.id}`, metodo: 'PATCH', corpo: { tipo: ev.target.value } })} style={sel}>
                      <option value="aberta">Em andamento</option><option value="ganho">Ganho</option><option value="perdido">Perdido</option>
                    </select>
                  </td>
                  <td className="num">{e.leads}</td>
                  <td>{gestor && !e.chave && <button className="botao perigo pequeno" onClick={() => window.confirm(`Apagar a etapa "${e.nome}"?`) && m.mutate({ rota: `/crm/etapas/${e.id}`, metodo: 'DELETE' })}>Apagar</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {gestor && (
            <div className="flex" style={{ gap: 6, marginTop: 8 }}>
              <input placeholder="Nova etapa" value={novaEtapa[f.id] ?? ''} onChange={(e) => setNovaEtapa({ ...novaEtapa, [f.id]: e.target.value })} style={sel} />
              <button className="botao claro pequeno" disabled={!novaEtapa[f.id]?.trim()} onClick={() => { m.mutate({ rota: `/crm/funis/${f.id}/etapas`, corpo: { nome: novaEtapa[f.id].trim() } }); setNovaEtapa({ ...novaEtapa, [f.id]: '' }); }}>Adicionar etapa</button>
            </div>
          )}
        </div>
      ))}
      {gestor && (
        <div className="cartao flex" style={{ gap: 6 }}>
          <input placeholder="Nome do novo funil (ex.: Eventos e feiras)" value={novoFunil} onChange={(e) => setNovoFunil(e.target.value)} style={{ ...sel, flex: 1 }} />
          <button className="botao" disabled={!novoFunil.trim()} onClick={() => { m.mutate({ rota: '/crm/funis', corpo: { nome: novoFunil.trim() } }); setNovoFunil(''); }}>Criar funil</button>
        </div>
      )}
    </div>
  );
}

// ───────────── Campos ─────────────

function Campos() {
  const qc = useQueryClient();
  const campos = usarCampos();
  const funis = usarFunis();
  const [criando, setCriando] = useState<'contato' | 'lead' | null>(null);
  const m = useMutation({ mutationFn: ({ rota, metodo, corpo }: { rota: string; metodo?: string; corpo?: unknown }) => api(rota, { metodo, corpo: corpo ?? {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'campos'] }) });
  const gestor = pode('crm', 'excluir');
  if (campos.isLoading) return <Carregando />;
  const mover = (lista: CampoDef[], i: number, d: -1 | 1) => {
    const ids = lista.map((c) => c.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    m.mutate({ rota: '/crm/campos/ordem', corpo: { ids } });
  };
  return (
    <div className="coluna" style={{ gap: 12 }}>
      <p className="muted" style={{ margin: 0 }}>
        <b>Contato</b> é a pessoa (vale em todos os cards dela). <b>Card</b> é o negócio dentro do funil (pode valer só para um funil). Também dá para criar campos direto no card do lead, em “+ Adicionar campo”.
        Nas mensagens e templates, use o valor do campo com a variável mostrada abaixo, por exemplo <code>{'{{campo_cidade}}'}</code>.
      </p>
      {m.error && <Erro erro={m.error} />}
      {(['contato', 'lead'] as const).map((ent) => {
        const lista = campos.data?.filter((c) => c.entidade === ent) ?? [];
        return (
          <div key={ent} className="cartao">
            <div className="secao" style={{ marginTop: 0 }}>{ent === 'contato' ? 'Campos do contato' : 'Campos do card'}</div>
            {lista.length === 0 ? <p className="muted">Nenhum campo ainda.</p> : (
              <table className="tabela">
                <thead><tr><th style={{ width: 60 }}>Ordem</th><th>Campo</th><th>Tipo</th>{ent === 'lead' && <th>Funil</th>}<th>No quadro</th><th>Variável</th><th></th></tr></thead>
                <tbody>
                  {lista.map((c, i) => (
                    <tr key={c.id}>
                      <td>
                        {gestor && (
                          <span className="flex" style={{ gap: 2 }}>
                            <button className="botao claro pequeno" disabled={i === 0 || m.isPending} onClick={() => mover(lista, i, -1)} title="Subir">↑</button>
                            <button className="botao claro pequeno" disabled={i === lista.length - 1 || m.isPending} onClick={() => mover(lista, i, 1)} title="Descer">↓</button>
                          </span>
                        )}
                      </td>
                      <td><input defaultValue={c.nome} disabled={!gestor} onBlur={(e) => e.target.value.trim() && e.target.value !== c.nome && m.mutate({ rota: `/crm/campos/${c.id}`, metodo: 'PATCH', corpo: { nome: e.target.value.trim() } })} style={sel} /></td>
                      <td>
                        {TIPOS_CAMPO[c.tipo] ?? c.tipo}
                        {(c.tipo === 'lista' || c.tipo === 'multipla') && (
                          <input defaultValue={c.opcoes.join(', ')} disabled={!gestor} title="Opções separadas por vírgula" onBlur={(e) => { const op = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); if (op.join(',') !== c.opcoes.join(',')) m.mutate({ rota: `/crm/campos/${c.id}`, metodo: 'PATCH', corpo: { opcoes: op } }); }} style={{ ...sel, display: 'block', marginTop: 4, width: '100%' }} />
                        )}
                      </td>
                      {ent === 'lead' && (
                        <td>
                          <select value={c.funilId ?? ''} disabled={!gestor} onChange={(e) => m.mutate({ rota: `/crm/campos/${c.id}`, metodo: 'PATCH', corpo: { funilId: e.target.value || null } })} style={sel}>
                            <option value="">Todos</option>
                            {funis.data?.map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}
                          </select>
                        </td>
                      )}
                      <td><input type="checkbox" checked={!!c.noQuadro} disabled={!gestor} onChange={(e) => m.mutate({ rota: `/crm/campos/${c.id}`, metodo: 'PATCH', corpo: { noQuadro: e.target.checked } })} /></td>
                      <td><code style={{ fontSize: 12 }}>{`{{${variavelDoCampo(c.nome)}}}`}</code></td>
                      <td>{gestor && <button className="botao perigo pequeno" onClick={() => window.confirm(`Apagar o campo "${c.nome}"? Os valores já preenchidos continuam guardados no cadastro.`) && m.mutate({ rota: `/crm/campos/${c.id}`, metodo: 'DELETE' })}>Apagar</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {gestor && (criando === ent ? <NovoCampo entidade={ent} cancelar={() => setCriando(null)} aoCriar={() => setCriando(null)} /> : <button className="mais-campo" onClick={() => setCriando(ent)}>+ Novo campo {ent === 'contato' ? 'do contato' : 'do card'}</button>)}
          </div>
        );
      })}
    </div>
  );
}

// ───────────── Templates ─────────────

const FONTES_FIXAS = [['primeiro_nome', 'Primeiro nome'], ['nome', 'Nome completo'], ['telefone', 'Telefone'], ['etapa', 'Etapa do card'], ['funil', 'Funil']];

function Templates() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['crm', 'templates', 'todos'], queryFn: () => api<Template[]>('/crm/templates') });
  const canais = usarCanais();
  const [f, setF] = useState({ nome: '', texto: '' });
  const m = useMutation({ mutationFn: ({ rota, metodo, corpo }: { rota: string; metodo?: string; corpo?: unknown }) => api(rota, { metodo, corpo: metodo === 'DELETE' ? undefined : (corpo ?? {}) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'templates'] }) });
  const gestor = pode('crm', 'excluir');
  const campos = usarCampos();
  const FONTES = [...FONTES_FIXAS, ...(campos.data ?? []).map((c) => [variavelDoCampo(c.nome), `Campo: ${c.nome}`])];
  if (q.isLoading) return <Carregando />;
  const meta = q.data?.filter((t) => t.tipo === 'meta') ?? [];
  const livres = q.data?.filter((t) => t.tipo === 'livre') ?? [];
  return (
    <div className="coluna" style={{ gap: 12 }}>
      {m.error && <Erro erro={m.error} />}
      <div className="cartao">
        <div className="secao" style={{ marginTop: 0 }}>Templates da Meta (número oficial)</div>
        <p className="muted" style={{ fontSize: 13 }}>Criados e aprovados no Gerenciador do WhatsApp da Meta; aqui só sincroniza (Números › Sincronizar templates) e escolhe de onde vem cada variável.</p>
        {!meta.length && <p className="muted">Nenhum template sincronizado.</p>}
        {meta.map((t) => (
          <div key={t.id} style={{ padding: '8px 0', borderBottom: '1px dashed var(--linha)' }}>
            <b>{t.nome}</b> <span className={`etiqueta ${t.status === 'APPROVED' ? 'ok' : t.status === 'REJECTED' ? 'erro' : 'alerta'}`}>{t.status === 'APPROVED' ? 'Aprovado' : t.status === 'REJECTED' ? 'Recusado' : 'Em análise'}</span> <span className="muted">· {canais.data?.find((c) => c.id === t.canalId)?.nome} · {t.categoria}</span>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, margin: '4px 0' }}>{t.texto}</div>
            {t.variaveis.map((v, i) => (
              <span key={i} style={{ marginRight: 10, fontSize: 13 }}>
                {`{{${i + 1}}}`} ={' '}
                <select value={FONTES.some(([k]) => k === v) ? v : ''} disabled={!gestor} onChange={(e) => m.mutate({ rota: `/crm/templates/${t.id}`, metodo: 'PATCH', corpo: { variaveis: t.variaveis.map((x, j) => (j === i ? e.target.value : x)) } })} style={sel}>
                  <option value="">Texto fixo…</option>
                  {FONTES.map(([k, r]) => <option key={k} value={k}>{r}</option>)}
                </select>
                {!FONTES.some(([k]) => k === v) && <input defaultValue={v} disabled={!gestor} placeholder="texto" onBlur={(e) => m.mutate({ rota: `/crm/templates/${t.id}`, metodo: 'PATCH', corpo: { variaveis: t.variaveis.map((x, j) => (j === i ? e.target.value : x)) } })} style={{ ...sel, width: 120, marginLeft: 4 }} />}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="cartao">
        <div className="secao" style={{ marginTop: 0 }}>Modelos livres</div>
        <p className="muted" style={{ fontSize: 13 }}>Para o QR code e para o oficial dentro das 24h. Use {'{{primeiro_nome}}'}, {'{{nome}}'}, {'{{etapa}}'} e os campos personalizados, como {'{{campo_cidade}}'} (lista completa em Campos personalizados).</p>
        {livres.map((t) => (
          <div key={t.id} className="flex entre" style={{ padding: '8px 0', borderBottom: '1px dashed var(--linha)', gap: 10 }}>
            <div><b>{t.nome}</b><div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{t.texto}</div></div>
            {gestor && <button className="botao perigo pequeno" onClick={() => window.confirm(`Apagar "${t.nome}"?`) && m.mutate({ rota: `/crm/templates/${t.id}`, metodo: 'DELETE' })}>Apagar</button>}
          </div>
        ))}
        {gestor && (
          <div className="coluna" style={{ gap: 6, marginTop: 10 }}>
            <input placeholder="Nome do modelo" value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} style={sel} />
            <TextoComVariaveis linhas={3} placeholder="Oi {{primeiro_nome}}, … (digite { para as variáveis)" value={f.texto} onChange={(t) => setF({ ...f, texto: t })} variaveis={FONTES.map(([n, r]) => ({ nome: n, rotulo: r }))} style={sel} />
            <div><button className="botao claro" disabled={!f.nome.trim() || !f.texto.trim()} onClick={() => { m.mutate({ rota: '/crm/templates', corpo: f }); setF({ nome: '', texto: '' }); }}>Criar modelo</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────── Respostas rápidas ─────────────

type RespostaRapida = { id: string; atalho: string; texto: string; midia: string | null; midiaMime: string | null; midiaNome: string | null };
const tipoMidia = (mime?: string | null) => (mime?.startsWith('image/') ? 'Foto' : mime?.startsWith('video/') ? 'Vídeo' : mime?.startsWith('audio/') ? 'Áudio' : null);
const lerBase64 = (f: Blob) => new Promise<string>((ok, erro) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => erro(new Error('Não foi possível ler o arquivo.')); r.readAsDataURL(f); });

function PreviaResposta({ r }: { r: RespostaRapida }) {
  const url = useMidia(r.midia);
  if (!r.midia) return null;
  if (!url) return <span className="muted">Carregando…</span>;
  if (r.midiaMime?.startsWith('image/')) return <img src={url} alt={r.midiaNome ?? 'foto'} style={{ maxWidth: 120, maxHeight: 90, borderRadius: 8, display: 'block' }} />;
  if (r.midiaMime?.startsWith('video/')) return <video src={url} controls style={{ maxWidth: 180, maxHeight: 120, borderRadius: 8, display: 'block' }} />;
  return <audio src={url} controls style={{ maxWidth: 240, display: 'block' }} />;
}

function Respostas() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['crm', 'respostas'], queryFn: () => api<RespostaRapida[]>('/crm/respostas') });
  const [f, setF] = useState({ atalho: '', texto: '' });
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [erroArquivo, setErroArquivo] = useState<string | null>(null);
  const campoArquivo = useRef<HTMLInputElement>(null);
  const m = useMutation({ mutationFn: ({ rota, metodo, corpo }: { rota: string; metodo?: string; corpo?: unknown }) => api(rota, { metodo, corpo: corpo ?? {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'respostas'] }) });
  const adicionar = useMutation({
    mutationFn: async () => api('/crm/respostas', { corpo: { atalho: f.atalho, texto: f.texto, midia: arquivo ? { nome: arquivo.name, mime: arquivo.type || 'application/octet-stream', base64: await lerBase64(arquivo) } : null } }),
    onSuccess: () => { setF({ atalho: '', texto: '' }); setArquivo(null); qc.invalidateQueries({ queryKey: ['crm', 'respostas'] }); },
  });
  const gestor = pode('crm', 'excluir');
  const escolher = (a: File | undefined) => {
    setErroArquivo(null);
    if (!a) return setArquivo(null);
    if (!/^(image|video|audio)\//.test(a.type)) return setErroArquivo('Escolha uma foto, um vídeo ou um áudio.');
    if (a.size > 16_000_000) return setErroArquivo('Arquivo maior que 16 MB.');
    setArquivo(a);
  };
  if (q.isLoading) return <Carregando />;
  return (
    <div className="cartao">
      <p className="muted" style={{ marginTop: 0 }}>No chat, digite "/" e o atalho. O texto entra no campo e a foto, o vídeo ou o áudio fica anexado, pronto para enviar (o texto vira a legenda).</p>
      {(m.error || adicionar.error) && <Erro erro={m.error ?? adicionar.error} />}
      <div style={{ overflowX: 'auto' }}>
        <table className="tabela">
          <thead><tr><th>Atalho</th><th>Texto</th><th>Mídia</th><th></th></tr></thead>
          <tbody>{q.data?.map((r) => (
            <tr key={r.id}>
              <td><code>/{r.atalho}</code></td>
              <td style={{ whiteSpace: 'pre-wrap' }}>{r.texto || <span className="muted">(sem texto)</span>}</td>
              <td>{r.midia ? <div className="coluna" style={{ gap: 4 }}><span className="tag">{tipoMidia(r.midiaMime)}</span><PreviaResposta r={r} /></div> : <span className="muted">—</span>}</td>
              <td>{gestor && <button className="botao perigo pequeno" onClick={() => m.mutate({ rota: `/crm/respostas/${r.id}`, metodo: 'DELETE' })}>Apagar</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {gestor && (
        <div className="coluna" style={{ gap: 8, marginTop: 10 }}>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            <input id="resposta-atalho" placeholder="atalho" value={f.atalho} onChange={(e) => setF({ ...f, atalho: e.target.value })} style={{ ...sel, width: 140 }} />
            <textarea id="resposta-texto" placeholder={arquivo ? 'Legenda (opcional)' : 'Texto da resposta'} value={f.texto} rows={2} onChange={(e) => setF({ ...f, texto: e.target.value })} style={{ ...sel, flex: 1, minWidth: 240, resize: 'vertical' }} />
          </div>
          <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="botao claro pequeno" onClick={() => campoArquivo.current?.click()}>{arquivo ? 'Trocar arquivo' : '📎 Foto, vídeo ou áudio (opcional)'}</button>
            <input ref={campoArquivo} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,audio/*" onChange={(e) => { escolher(e.target.files?.[0]); e.target.value = ''; }} />
            {arquivo && <span className="muted" style={{ fontSize: 13 }}>{tipoMidia(arquivo.type)}: {arquivo.name} <button className="botao claro pequeno" onClick={() => setArquivo(null)}>Tirar</button></span>}
            <button className="botao" disabled={!f.atalho.trim() || (!f.texto.trim() && !arquivo) || adicionar.isPending} onClick={() => adicionar.mutate()}>{adicionar.isPending ? 'Salvando…' : 'Adicionar'}</button>
          </div>
          {erroArquivo && <div className="aviso erro">{erroArquivo}</div>}
        </div>
      )}
    </div>
  );
}

// ───────────── Ramais do softphone ─────────────

function Ramais() {
  const qc = useQueryClient();
  const atendentes = usarAtendentes();
  const q = useQuery({ queryKey: ['crm', 'ramais'], queryFn: () => api<any[]>('/crm/ramais') });
  const [f, setF] = useState({ usuarioId: '', servidor: '', usuarioSip: '', senha: '', nomeExibicao: '', prefixo: '' });
  const m = useMutation({ mutationFn: () => api('/crm/ramais', { corpo: { ...f, senha: f.senha || undefined, nomeExibicao: f.nomeExibicao || null, prefixo: f.prefixo || null } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm', 'ramais'] }); setF({ usuarioId: '', servidor: '', usuarioSip: '', senha: '', nomeExibicao: '', prefixo: '' }); } });
  if (q.isLoading) return <Carregando />;
  return (
    <div className="coluna" style={{ gap: 12 }}>
      <p className="muted" style={{ margin: 0 }}>O softphone liga pelo navegador (WebRTC) usando um ramal SIP com WebSocket seguro (wss), como o servidor de voz do Widezap (FreeSWITCH/Asterisk). Cada atendente com ramal vê o telefone no canto da tela.</p>
      {(q.error || m.error) && <Erro erro={q.error ?? m.error} />}
      {q.data?.length ? (
        <table className="tabela">
          <thead><tr><th>Atendente</th><th>Ramal</th><th>Servidor</th><th>Situação</th><th></th></tr></thead>
          <tbody>{q.data.map((r) => <tr key={r.usuarioId}><td>{r.nome}</td><td>{r.usuarioSip}</td><td>{r.servidor}</td><td>{r.ativo ? <span className="etiqueta ok">Ativo</span> : <span className="etiqueta neutra">Desligado</span>}</td><td><button className="botao claro pequeno" onClick={() => setF({ usuarioId: r.usuarioId, servidor: r.servidor, usuarioSip: r.usuarioSip, senha: '', nomeExibicao: r.nomeExibicao ?? '', prefixo: r.prefixo ?? '' })}>Editar</button></td></tr>)}</tbody>
        </table>
      ) : null}
      <div className="cartao form">
        <div className="secao" style={{ gridColumn: '1 / -1', marginTop: 0 }}>Ramal de um atendente</div>
        <Campo rotulo="Atendente" className="l2"><select value={f.usuarioId} onChange={(e) => setF({ ...f, usuarioId: e.target.value })}><option value="">Escolha…</option>{atendentes.data?.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}</select></Campo>
        <Campo rotulo="Servidor WebSocket" className="l2"><input value={f.servidor} placeholder="wss://voz.wideic.com:7443" onChange={(e) => setF({ ...f, servidor: e.target.value })} /></Campo>
        <Campo rotulo="Usuário SIP" className="l2"><input value={f.usuarioSip} placeholder="sip:1001@voz.wideic.com" onChange={(e) => setF({ ...f, usuarioSip: e.target.value })} /></Campo>
        <Campo rotulo="Senha do ramal" className="l2"><input type="password" autoComplete="new-password" value={f.senha} placeholder="Em branco = não muda" onChange={(e) => setF({ ...f, senha: e.target.value })} /></Campo>
        <Campo rotulo="Nome exibido (opcional)" className="l2"><input value={f.nomeExibicao} onChange={(e) => setF({ ...f, nomeExibicao: e.target.value })} /></Campo>
        <Campo rotulo="Prefixo para ligar para fora (opcional)" className="l2"><input value={f.prefixo} onChange={(e) => setF({ ...f, prefixo: e.target.value })} placeholder="Ex.: 0" /></Campo>
        <div className="l4"><button className="botao" disabled={!f.usuarioId || !f.servidor || !f.usuarioSip || m.isPending} onClick={() => m.mutate()}>Salvar ramal</button></div>
      </div>
    </div>
  );
}

// ───────────── Agente de IA ─────────────

interface Especialista { id: string; funcao: string; nome: string; quando: string; instrucoes: string; conhecimento: string; ativo: boolean; ordem: number; canais?: string[] }
interface OpcaoVoz { id: string; nome: string }
interface ConfigAgente { ativo: boolean; canais: string[]; instrucoes: string; conhecimento: string; maxRespostas: number; nome: string; maxTransferencias: number; ligada: boolean; especialistas: Especialista[]; respostaAudio: 'nunca' | 'espelhar' | 'sempre'; vozProvedor: 'automatica' | 'elevenlabs' | 'openai'; vozElevenlabs: string; vozOpenai: string; audioComTexto: boolean; ferramentas: { segundaVia: boolean; promessa: boolean; promessaMaxDias: number; estoque: boolean; candidatura: boolean; comprovante: boolean; acordo: boolean; fecharAcordo: boolean; agendar?: boolean; agendaResponsavelId?: string | null; agendaTipo?: 'entrevista' | 'reuniao' | 'outro' }; memoriaClientes: boolean; esperaMinS?: number; esperaMaxS?: number; reserva?: boolean; reservaMin?: number; voz?: { disponivel: 'elevenlabs' | 'openai' | null; elevenlabs: boolean; openai: boolean; opcoes: { elevenlabs: OpcaoVoz[]; openai: OpcaoVoz[] } } }

/** O agente que atende no WhatsApp enquanto ninguém da equipe pegou a conversa. */
function AgenteIa() {
  const qc = useQueryClient();
  const admin = pode('configuracoes', 'editar');
  const q = useQuery({ queryKey: ['crm', 'ia-agente'], queryFn: () => api<ConfigAgente>('/crm/ia-agente') });
  const canais = usarCanais();
  const [f, setF] = useState<ConfigAgente | null>(null);
  useEffect(() => { if (q.data && !f) setF(q.data); }, [q.data, f]);
  const salvar = useMutation({ mutationFn: () => api<ConfigAgente>('/crm/ia-agente', { metodo: 'PUT', corpo: { ativo: f!.ativo, canais: f!.canais, instrucoes: f!.instrucoes, conhecimento: f!.conhecimento, maxRespostas: f!.maxRespostas, nome: f!.nome, maxTransferencias: f!.maxTransferencias, respostaAudio: f!.respostaAudio, vozProvedor: f!.vozProvedor, vozElevenlabs: f!.vozElevenlabs, vozOpenai: f!.vozOpenai, audioComTexto: f!.audioComTexto, ferramentas: f!.ferramentas, memoriaClientes: f!.memoriaClientes ?? true, esperaMinS: f!.esperaMinS ?? 7, esperaMaxS: f!.esperaMaxS ?? 7, reserva: f!.reserva ?? false, reservaMin: f!.reservaMin ?? 5 } }), onSuccess: (r) => { setF({ ...f!, ...r }); qc.invalidateQueries({ queryKey: ['crm', 'ia-agente'] }); } });
  if (q.isLoading || !f) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  return (
    <div className="coluna" style={{ gap: 12 }}>
      <div className="aviso">Dica: em <Link to="/assistente">Assistente</Link> você vê todos os agentes numa lista (os do WhatsApp e os agendados) e pode pedir para ele montar ou ajustar um agente conversando, inclusive a voz.</div>
      <TestarIa f={f} especialistas={q.data?.especialistas ?? []} />
      {!f.ligada && <div className="aviso alerta">A inteligência artificial ainda não está ligada. Cole a chave do Claude em Configurações › Integrações › Inteligência artificial. Sem a chave, o agente não atende e os botões de IA do chat ficam escondidos.</div>}
      <div className="cartao form">
        <div className="secao" style={{ gridColumn: '1 / -1', marginTop: 0 }}>Agente que atende no WhatsApp</div>
        <p className="muted l4" style={{ margin: 0 }}>Quando alguém escreve e ninguém da equipe pegou a conversa, a IA responde. Ela passa para a equipe quando pedem um atendente, em reclamação, pagamento, troca ou garantia, e quando não sabe a resposta. Assim que uma pessoa da equipe pega a conversa ou escreve, a IA sai.</p>
        <label className="check l4"><input type="checkbox" checked={f.ativo} disabled={!admin || (!f.ligada && !f.ativo)} onChange={(e) => setF({ ...f, ativo: e.target.checked })} /> Atender sozinha as conversas que entram na fila</label>
        <div className="l4">
          <label className="muted" style={{ fontSize: 13, fontWeight: 600 }}>Em quais números (nenhum marcado = todos)</label>
          <div className="flex" style={{ gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
            {canais.data?.map((c) => <label key={c.id} className="check"><input type="checkbox" disabled={!admin} checked={f.canais.includes(c.id)} onChange={(e) => setF({ ...f, canais: e.target.checked ? [...f.canais, c.id] : f.canais.filter((x) => x !== c.id) })} /> {c.nome}</label>)}
          </div>
        </div>
        <Campo rotulo="Nome com que ela se apresenta" className="l2" ajuda="O mesmo para todos os especialistas: o cliente não percebe a troca. Em branco, ela não se apresenta por nome.">
          <input maxLength={40} disabled={!admin} value={f.nome ?? ''} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder="Ex.: Ari" />
        </Campo>
        <Campo rotulo="Esperar antes de responder: de (segundos)" className="l2" ajuda="A IA sorteia um tempo entre o mínimo e o máximo, contado da última mensagem da pessoa. Parece gente digitando. Se a pessoa mandar outra mensagem, o relógio recomeça e ela responde tudo junto.">
          <input type="number" min={0} max={900} disabled={!admin} value={f.esperaMinS ?? 7} onChange={(e) => setF({ ...f, esperaMinS: Math.max(0, Math.min(900, Number(e.target.value) || 0)) })} />
        </Campo>
        <Campo rotulo="até (segundos)" className="l2" ajuda={`Ex.: de 20 até 180 = entre 20 segundos e 3 minutos. Agora: ${(f.esperaMinS ?? 7) === (f.esperaMaxS ?? 7) ? `sempre ${f.esperaMinS ?? 7} s` : `de ${f.esperaMinS ?? 7} a ${f.esperaMaxS ?? 7} s`}.`}>
          <input type="number" min={0} max={900} disabled={!admin} value={f.esperaMaxS ?? 7} onChange={(e) => setF({ ...f, esperaMaxS: Math.max(0, Math.min(900, Number(e.target.value) || 0)) })} />
        </Campo>
        <label className="check l4"><input type="checkbox" disabled={!admin} checked={f.reserva ?? false} onChange={(e) => setF({ ...f, reserva: e.target.checked })} /> <span><b>Modo reserva: a equipe responde primeiro</b><br /><span className="muted" style={{ fontSize: 13 }}>Dentro do horário da equipe (configurado em cada número, mais abaixo), a IA só começa se a pessoa ficar sem resposta. Se alguém da equipe escrever ou assumir a conversa, a IA para, e só volta quando chegar uma mensagem que fique sem resposta pelo mesmo tempo. Fora do horário, ela responde normalmente.</span></span></label>
        {f.reserva && (
          <Campo rotulo="Minutos sem resposta para a IA entrar" className="l2">
            <input type="number" min={1} max={120} disabled={!admin} value={f.reservaMin ?? 5} onChange={(e) => setF({ ...f, reservaMin: Math.max(1, Math.min(120, Number(e.target.value) || 5)) })} />
          </Campo>
        )}
        <Campo rotulo="Trocas de especialista por conversa" className="l2" ajuda="Passou disso, a conversa vai para a equipe (evita a IA ficar passando de um para o outro).">
          <input type="number" min={0} max={5} disabled={!admin} value={f.maxTransferencias ?? 2} onChange={(e) => setF({ ...f, maxTransferencias: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })} />
        </Campo>
        <Campo rotulo="Como ela deve atender (vale para todos)" className="l4" ajuda="O tom, o objetivo e o que perguntar. Ex.: trate por você; descubra se a pessoa quer comprar ou ser revendedora; para revendedora, peça a cidade.">
          <textarea rows={5} maxLength={20000} disabled={!admin} value={f.instrucoes} onChange={(e) => setF({ ...f, instrucoes: e.target.value })} />
        </Campo>
        <Campo rotulo="O que ela precisa saber sobre a empresa (vale para todos)" className="l4" ajuda="Endereço, horário, formas de pagamento, como funciona a revenda, prazo de entrega, perguntas frequentes. Ela só afirma o que estiver escrito aqui; o resto ela diz que vai confirmar com a equipe.">
          <textarea rows={10} maxLength={100000} disabled={!admin} value={f.conhecimento} onChange={(e) => setF({ ...f, conhecimento: e.target.value })} />
        </Campo>
        <Campo rotulo="Respostas seguidas antes de passar para a equipe" className="l2" ajuda="Evita conversa em círculo. Chegando ao limite, a conversa fica na fila com um recado.">
          <input type="number" min={1} max={50} disabled={!admin} value={f.maxRespostas} onChange={(e) => setF({ ...f, maxRespostas: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} />
        </Campo>
        <div className="secao" style={{ gridColumn: '1 / -1' }}>O que ela pode fazer sozinha</div>
        <p className="muted l4" style={{ margin: 0 }}>Vale só para quem está escrevendo: as parcelas são as do cadastro ligado àquele número. Desconto e parcelamento só dentro das regras de Cobrança › Configurar; quem tem processo judicial ativo vai direto para a equipe. Ela não muda valor nem vencimento e não fecha venda. Tudo que ela faz fica anotado na conversa.</p>
        {([['segundaVia', 'Dizer as parcelas em aberto com o valor atualizado e mandar a 2ª via ou um Pix novo (vencida sai com multa e juros)'], ['promessa', 'Anotar a promessa de pagamento na Cobrança'], ['comprovante', 'Receber o comprovante: conferir valor, data e nome e deixar para a equipe dar baixa (Cobrança › Comprovantes)'], ['acordo', 'Propor acordo dentro das regras da Cobrança (à vista com o desconto máximo do cobrador, ou parcelado até o máximo de parcelas)'], ['fecharAcordo', 'Fechar sozinha o acordo que a pessoa aceitou (desligado: anota a proposta e passa para a equipe fechar)'], ['estoque', 'Consultar peça, preço e se há em estoque'], ['candidatura', 'Registrar quem quer ser revendedora no recrutamento']] as const).map(([k, rotulo]) => (
          <label key={k} className="check l4"><input type="checkbox" disabled={!admin || (k === 'fecharAcordo' && !f.ferramentas?.acordo)} checked={f.ferramentas?.[k] ?? k !== 'fecharAcordo'} onChange={(e) => setF({ ...f, ferramentas: { ...f.ferramentas, [k]: e.target.checked } })} /> {rotulo}</label>
        ))}
        <label className="check l4"><input type="checkbox" disabled={!admin} checked={f.ferramentas?.agendar ?? false} onChange={(e) => setF({ ...f, ferramentas: { ...f.ferramentas, agendar: e.target.checked } })} /> Marcar na agenda uma conversa (ligação ou vídeo) no horário que a pessoa escolher, com confirmação e lembrete pelo WhatsApp</label>
        {f.ferramentas?.agendar && <AgendaDaIa f={f} setF={setF} admin={admin} />}
        <Campo rotulo="Promessa: até quantos dias à frente" className="l2" ajuda="Prazo maior que isso ela passa para a equipe.">
          <input type="number" min={1} max={60} disabled={!admin || !f.ferramentas?.promessa} value={f.ferramentas?.promessaMaxDias ?? 10} onChange={(e) => setF({ ...f, ferramentas: { ...f.ferramentas, promessaMaxDias: Math.max(1, Math.min(60, Number(e.target.value) || 1)) } })} />
        </Campo>
        <label className="check l4"><input type="checkbox" disabled={!admin} checked={f.memoriaClientes ?? true} onChange={(e) => setF({ ...f, memoriaClientes: e.target.checked })} /> Lembrar de cada cliente (um resumo curto das conversas, que a equipe pode ver e apagar no chat)</label>
        <AudioDoAgente f={f} setF={setF} admin={admin} />
        {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
        {salvar.isSuccess && <div className="aviso ok l4">Salvo. {f.ativo ? 'O agente já está atendendo as conversas novas.' : 'O agente está desligado.'}</div>}
        {admin && <div className="l4"><button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Salvar</button></div>}
      </div>
      <NumerosIa especialistas={q.data?.especialistas ?? []} iaNosNumeros={f.ativo ? (q.data?.canais ?? []) : null} admin={admin} />
      <Especialistas lista={q.data?.especialistas ?? []} admin={admin} />
      <Licoes especialistas={q.data?.especialistas ?? []} admin={admin} />
      <UsoIa />
      <div className="cartao">
        <b>No chat</b>
        <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          <li>As mensagens da IA aparecem marcadas com "IA", e a conversa mostra um aviso enquanto ela está atendendo.</li>
          <li>"✨ Sugerir" escreve uma resposta para você revisar e enviar. Funciona mesmo com o agente desligado.</li>
          <li>"🤖 Acionar IA" liga a IA só naquela conversa; "Pausar IA" desliga.</li>
          <li>Quando a IA passa a conversa, ela deixa um recado interno dizendo o motivo.</li>
          <li>Com especialistas, cada troca também aparece como recado interno (ex.: "🤖 Recepção → Vendas: quer comprar peça").</li>
        </ul>
      </div>
    </div>
  );
}

/** Resposta em áudio do agente: quando, com qual voz, e exemplo para ouvir. */
function AudioDoAgente({ f, setF, admin }: { f: ConfigAgente; setF: (c: ConfigAgente) => void; admin: boolean }) {
  const [ouvindo, setOuvindo] = useState(false);
  const [erro, setErro] = useState<unknown>(null);
  const v = f.voz;
  const provedor = f.vozProvedor === 'automatica' ? (v?.elevenlabs ? 'elevenlabs' : v?.openai ? 'openai' : null) : f.vozProvedor;
  const ouvir = async () => {
    if (!provedor) return;
    setOuvindo(true);
    setErro(null);
    try {
      const r = await fetch('/api/crm/ia-agente/ouvir', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${lerSessao()?.token ?? ''}` }, body: JSON.stringify({ texto: `Oi, tudo bem? ${f.nome ? `Aqui é a ${f.nome}, ` : ''}da Aritana. Vi que você se interessou pelas nossas semijoias. Quer que eu te mande o catálogo?`, provedor, voz: provedor === 'elevenlabs' ? f.vozElevenlabs : f.vozOpenai }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { mensagem?: string }).mensagem ?? 'Não deu para gerar o exemplo.');
      await new Audio(URL.createObjectURL(await r.blob())).play();
    } catch (e) {
      setErro(e);
    } finally {
      setOuvindo(false);
    }
  };
  return (
    <>
      <div className="secao l4">Áudio</div>
      <p className="muted l4" style={{ margin: 0 }}>Os áudios que o cliente manda são transcritos e ela entende. Aqui você escolhe se ela também <b>responde em áudio</b>, com voz natural.</p>
      {!v?.disponivel && <div className="aviso alerta l4">Para responder em áudio, cole a chave da ElevenLabs (voz mais natural) ou da OpenAI em Configurações › Integrações › Inteligência artificial.</div>}
      <Campo rotulo="Responder em áudio" className="l2">
        <select disabled={!admin || !v?.disponivel} value={f.respostaAudio} onChange={(e) => setF({ ...f, respostaAudio: e.target.value as ConfigAgente['respostaAudio'] })}>
          <option value="nunca">Nunca (só texto)</option>
          <option value="espelhar">Quando o cliente mandar áudio</option>
          <option value="sempre">Sempre</option>
        </select>
      </Campo>
      <Campo rotulo="Quem fala" className="l2">
        <select disabled={!admin || f.respostaAudio === 'nunca'} value={f.vozProvedor} onChange={(e) => setF({ ...f, vozProvedor: e.target.value as ConfigAgente['vozProvedor'] })}>
          <option value="automatica">Automática (a melhor disponível)</option>
          <option value="elevenlabs" disabled={!v?.elevenlabs}>ElevenLabs (mais natural){v?.elevenlabs ? '' : ' · falta a chave'}</option>
          <option value="openai" disabled={!v?.openai}>OpenAI{v?.openai ? '' : ' · falta a chave'}</option>
        </select>
      </Campo>
      {f.respostaAudio !== 'nunca' && provedor === 'elevenlabs' && (
        <Campo rotulo="Voz" className="l2" ajuda="Para outra voz da ElevenLabs, cole o Voice ID.">
          <input list="vozes-eleven" disabled={!admin} value={f.vozElevenlabs} onChange={(e) => setF({ ...f, vozElevenlabs: e.target.value.trim() })} />
          <datalist id="vozes-eleven">{v?.opcoes.elevenlabs.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}</datalist>
          <small className="muted">{v?.opcoes.elevenlabs.find((o) => o.id === f.vozElevenlabs)?.nome ?? 'voz personalizada'}</small>
        </Campo>
      )}
      {f.respostaAudio !== 'nunca' && provedor === 'openai' && (
        <Campo rotulo="Voz" className="l2">
          <select disabled={!admin} value={f.vozOpenai} onChange={(e) => setF({ ...f, vozOpenai: e.target.value })}>{v?.opcoes.openai.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}</select>
        </Campo>
      )}
      {f.respostaAudio !== 'nunca' && (
        <>
          <label className="check l2"><input type="checkbox" disabled={!admin} checked={f.audioComTexto} onChange={(e) => setF({ ...f, audioComTexto: e.target.checked })} /> Mandar também o texto depois do áudio</label>
          <div className="l4 flex" style={{ gap: 8, alignItems: 'center' }}>
            <button className="botao claro pequeno" disabled={ouvindo || !provedor} onClick={ouvir}>{ouvindo ? 'Gerando…' : '🔊 Ouvir exemplo'}</button>
            <small className="muted">Links nunca vão falados: quando a resposta tem link, o texto vai junto.</small>
          </div>
          {erro != null && <div className="l4"><Erro erro={erro} /></div>}
        </>
      )}
    </>
  );
}

/** Em nome de quem a IA marca as conversas na agenda, e o tipo do compromisso. */
function AgendaDaIa({ f, setF, admin }: { f: ConfigAgente; setF: (c: ConfigAgente) => void; admin: boolean }) {
  const usuarios = usarUsuariosDoCrm();
  return (
    <>
      <Campo rotulo="Na agenda de quem" className="l2" ajuda="O compromisso fica com esta pessoa (os horários dela que já estão ocupados não são oferecidos).">
        <select disabled={!admin} value={f.ferramentas.agendaResponsavelId ?? ''} onChange={(e) => setF({ ...f, ferramentas: { ...f.ferramentas, agendaResponsavelId: e.target.value || null } })}>
          <option value="">Escolha…</option>
          {usuarios.data?.map((u: { id: string; nome: string }) => <option key={u.id} value={u.id}>{u.nome}</option>)}
        </select>
      </Campo>
      <Campo rotulo="Tipo" className="l2">
        <select disabled={!admin} value={f.ferramentas.agendaTipo ?? 'entrevista'} onChange={(e) => setF({ ...f, ferramentas: { ...f.ferramentas, agendaTipo: e.target.value as 'entrevista' } })}>
          <option value="entrevista">Entrevista de candidata</option>
          <option value="reuniao">Reunião</option>
          <option value="outro">Outro</option>
        </select>
      </Campo>
    </>
  );
}

interface MsgTeste { de: 'cliente' | 'ia' | 'equipe'; texto: string; agente?: string | null; passos?: string[]; ferramentas?: { ferramenta: string; resultado: string; simulada: boolean }[] }

/**
 * Ambiente de teste: a equipe escreve como se fosse a cliente e vê o que a IA responderia, por qual especialista,
 * o que a recepção decidiu e quais ferramentas usou. Nada vai para o WhatsApp e nada é gravado.
 */
function TestarIa({ f, especialistas }: { f: ConfigAgente; especialistas: Especialista[] }) {
  const canais = usarCanais();
  const [aberto, setAberto] = useState(false);
  const [canalId, setCanalId] = useState('');
  const [horario, setHorario] = useState<'agora' | 'dentro' | 'fora'>('agora');
  const [agenteId, setAgenteId] = useState('');
  const [rascunho, setRascunho] = useState(true);
  const [busca, setBusca] = useState('');
  const [pessoa, setPessoa] = useState<{ id: string; nome: string } | null>(null);
  const [nome, setNome] = useState('');
  const [texto, setTexto] = useState('');
  const [msgs, setMsgs] = useState<MsgTeste[]>([]);
  const [transf, setTransf] = useState(0);
  const [verBastidores, setVerBastidores] = useState(true);
  const pessoas = useQuery({ queryKey: ['teste-ia-pessoas', busca], queryFn: () => api<{ itens: { id: string; nome: string }[] }>(`/pessoas?tipo=representante&busca=${encodeURIComponent(busca)}`), enabled: busca.trim().length >= 3 });
  const enviar = useMutation({
    mutationFn: (lista: MsgTeste[]) => api<{ resposta: string; passar: boolean; motivo: string | null; agente: { id: string; nome: string } | null; passos: string[]; ferramentas: { ferramenta: string; resultado: string; simulada: boolean }[]; transferencias?: number }>('/crm/ia-agente/testar', {
      corpo: {
        canalId: canalId || null,
        mensagens: lista.filter((m) => m.de !== 'equipe').map((m) => ({ de: m.de, texto: m.texto })),
        pessoaId: pessoa?.id ?? null,
        nome: nome || null,
        horario,
        agenteId: agenteId || null,
        transferencias: transf,
        ...(rascunho ? { config: { instrucoes: f.instrucoes, conhecimento: f.conhecimento, nome: f.nome, maxTransferencias: f.maxTransferencias } } : {}),
      },
    }),
    onSuccess: (r, lista) => {
      setTransf(r.transferencias ?? transf);
      if (r.agente && !agenteId) setAgenteId(r.agente.id);
      const novas: MsgTeste[] = [];
      if (r.resposta) novas.push({ de: 'ia', texto: r.resposta, agente: r.agente?.nome ?? 'Recepção', passos: r.passos, ferramentas: r.ferramentas });
      if (r.passar) novas.push({ de: 'equipe', texto: `A IA passaria a conversa para a equipe: ${r.motivo ?? ''}`, passos: r.resposta ? undefined : r.passos });
      setMsgs([...lista, ...novas]);
    },
  });
  const mandar = (e?: FormEvent) => {
    e?.preventDefault();
    if (!texto.trim() || enviar.isPending) return;
    const lista = [...msgs, { de: 'cliente' as const, texto: texto.trim() }];
    setMsgs(lista);
    setTexto('');
    enviar.mutate(lista);
  };
  const reiniciar = () => { setMsgs([]); setTransf(0); setAgenteId(''); enviar.reset(); };
  const encerrada = msgs.at(-1)?.de === 'equipe';
  if (!aberto) {
    return (
      <div className="cartao flex entre" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div><b>Testar a IA antes de soltar</b><div className="muted" style={{ fontSize: 13 }}>Converse como se fosse uma cliente e veja o que ela responderia, qual especialista atende e quando passa para a equipe. Nada vai para o WhatsApp.</div></div>
        <button className="botao" onClick={() => setAberto(true)}>Abrir o teste</button>
      </div>
    );
  }
  return (
    <div className="cartao coluna" style={{ gap: 10 }}>
      <div className="flex entre" style={{ gap: 8, flexWrap: 'wrap' }}>
        <b>Teste da IA</b>
        <span className="flex" style={{ gap: 6 }}><button className="botao claro pequeno" onClick={reiniciar}>Recomeçar conversa</button><button className="botao claro pequeno" onClick={() => setAberto(false)}>Fechar</button></span>
      </div>
      <div className="form">
        <Campo rotulo="Como se a mensagem chegasse no número" className="l2">
          <select value={canalId} onChange={(e) => { setCanalId(e.target.value); reiniciar(); }}>
            <option value="">Nenhum número (só as instruções gerais)</option>
            {canais.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}{f.ativo && (!f.canais.length || f.canais.includes(c.id)) ? ' · IA ligada' : ' · IA desligada'}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Horário" className="l2">
          <select value={horario} onChange={(e) => setHorario(e.target.value as typeof horario)}>
            <option value="agora">Agora (horário real)</option>
            <option value="dentro">Simular dentro do horário da equipe</option>
            <option value="fora">Simular fora do horário (noite / fim de semana)</option>
          </select>
        </Campo>
        <Campo rotulo="Especialista" className="l2" ajuda="Automático = a recepção escolhe, como no WhatsApp. Dá para testar um desligado antes de ligar.">
          <select value={agenteId} onChange={(e) => { setAgenteId(e.target.value); setTransf(0); }}>
            <option value="">Automático (recepção escolhe)</option>
            {especialistas.map((e) => <option key={e.id} value={e.id}>{e.nome}{e.ativo ? '' : ' (desligado)'}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Quem está escrevendo" className="l2" ajuda="Vazio = pessoa desconhecida (lead). Escolha uma revendedora para a IA ver a maleta e as parcelas dela (só consulta).">
          {pessoa ? (
            <div className="flex" style={{ gap: 6 }}><span className="etiqueta neutra">{pessoa.nome}</span><button className="botao claro pequeno" onClick={() => { setPessoa(null); reiniciar(); }}>Trocar</button></div>
          ) : (
            <>
              <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar revendedora (3 letras) ou deixe vazio" />
              {pessoas.data?.itens?.slice(0, 6).map((p) => <button key={p.id} type="button" className="botao claro pequeno" style={{ margin: '4px 4px 0 0' }} onClick={() => { setPessoa({ id: p.id, nome: p.nome }); setBusca(''); reiniciar(); }}>{p.nome}</button>)}
            </>
          )}
        </Campo>
        {!pessoa && <Campo rotulo="Nome no WhatsApp (opcional)" className="l2"><input value={nome} maxLength={80} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Juliana" /></Campo>}
        <label className="check l2"><input type="checkbox" checked={rascunho} onChange={(e) => setRascunho(e.target.checked)} /> Usar as instruções e o conhecimento desta tela, mesmo sem salvar</label>
        <label className="check l4"><input type="checkbox" checked={verBastidores} onChange={(e) => setVerBastidores(e.target.checked)} /> Mostrar os bastidores (recepção, especialista, ferramentas)</label>
      </div>
      <div style={{ background: 'var(--creme-2, #efe6da)', borderRadius: 12, padding: 12, minHeight: 220, maxHeight: 460, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!msgs.length && <div className="muted" style={{ textAlign: 'center', marginTop: 70 }}>Escreva abaixo como se fosse a cliente. Ex.: "Oi, vi o anúncio e quero revender"</div>}
        {msgs.map((m, k) => (
          <div key={k} style={{ alignSelf: m.de === 'cliente' ? 'flex-end' : m.de === 'equipe' ? 'center' : 'flex-start', maxWidth: m.de === 'equipe' ? '100%' : '80%' }}>
            {m.de === 'ia' && <div className="muted" style={{ fontSize: 11.5, marginBottom: 2 }}>🤖 {f.nome || 'IA'} · {m.agente}</div>}
            <div style={{ whiteSpace: 'pre-wrap', padding: '8px 12px', borderRadius: 12, fontSize: 14, background: m.de === 'cliente' ? '#dcf8c6' : m.de === 'equipe' ? 'transparent' : '#fff', color: m.de === 'cliente' ? '#1f2d1f' : undefined, border: m.de === 'equipe' ? '1px dashed var(--borda)' : undefined, fontStyle: m.de === 'equipe' ? 'italic' : undefined }}>{m.texto}</div>
            {verBastidores && (m.passos?.length || m.ferramentas?.length) ? (
              <div className="muted" style={{ fontSize: 12, marginTop: 3, paddingLeft: 4 }}>
                {m.passos?.map((p, j) => <div key={j}>· {p}</div>)}
                {m.ferramentas?.map((t, j) => <details key={`f${j}`}><summary>🔧 {t.ferramenta}{t.simulada ? ' (simulada)' : ''}</summary><div style={{ whiteSpace: 'pre-wrap' }}>{t.resultado}</div></details>)}
              </div>
            ) : null}
          </div>
        ))}
        {enviar.isPending && <div className="muted" style={{ fontSize: 13 }}>🤖 digitando…</div>}
      </div>
      {enviar.error && <Erro erro={enviar.error} />}
      {encerrada && <div className="aviso" style={{ margin: 0 }}>Na vida real a conversa iria para a fila da equipe aqui. Continue escrevendo para ver como a IA reagiria se fosse acionada de novo, ou recomece.</div>}
      <form className="flex" style={{ gap: 8 }} onSubmit={mandar}>
        <input style={{ flex: 1 }} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Mensagem da cliente…" maxLength={2000} autoFocus />
        <button className="botao" disabled={!texto.trim() || enviar.isPending}>Enviar</button>
      </form>
    </div>
  );
}

/** Por número: quais especialistas atendem nele e o horário da equipe (fora dele, a IA avisa quando a equipe volta). */
function NumerosIa({ especialistas, iaNosNumeros, admin }: { especialistas: Especialista[]; iaNosNumeros: string[] | null; admin: boolean }) {
  const canais = usarCanais();
  const lista = canais.data ?? [];
  if (!lista.length) return null;
  return (
    <div className="cartao coluna" style={{ gap: 10 }}>
      <b>Números: especialistas e horário da equipe</b>
      <p className="muted" style={{ margin: 0 }}>Para cada número, escolha quais especialistas a IA usa e o horário em que a equipe atende. Fora do horário, a IA continua a triagem e avisa quando a equipe responde. Nos números sem IA, dá para mandar um aviso automático fora do horário (uma vez por noite ou fim de semana).</p>
      {lista.map((c) => <NumeroIa key={c.id} canal={c} especialistas={especialistas} iaAqui={iaNosNumeros === null ? false : !iaNosNumeros.length || iaNosNumeros.includes(c.id)} admin={admin} />)}
    </div>
  );
}

function NumeroIa({ canal: c, especialistas, iaAqui, admin }: { canal: Canal; especialistas: Especialista[]; iaAqui: boolean; admin: boolean }) {
  const qc = useQueryClient();
  const inicial = () => ({ esp: c.iaEspecialistas ?? [], ativo: c.atendimentoAtivo ?? false, inicio: c.atendimentoInicio ?? '09:00', fim: c.atendimentoFim ?? '18:00', dias: c.atendimentoDias ?? [1, 2, 3, 4, 5], aviso: c.avisoForaHorario ?? false, msg: c.mensagemForaHorario ?? '' });
  const [f, setF] = useState(inicial);
  const [aberto, setAberto] = useState(false);
  const salvar = useMutation({
    mutationFn: () => api(`/crm/canais/${c.id}`, { metodo: 'PATCH', corpo: { iaEspecialistas: f.esp, atendimentoAtivo: f.ativo, atendimentoInicio: f.inicio, atendimentoFim: f.fim, atendimentoDias: f.dias, avisoForaHorario: f.aviso, mensagemForaHorario: f.msg } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'canais'] }),
  });
  const ligados = especialistas.filter((e) => e.ativo && (!e.canais?.length || e.canais.includes(c.id)));
  const usados = f.esp.length ? ligados.filter((e) => f.esp.includes(e.id)) : ligados;
  const resumo = [iaAqui ? `IA ligada${usados.length ? ` · ${usados.map((e) => e.nome).join(', ')}` : ''}` : 'IA desligada (só equipe)', f.ativo ? `equipe ${f.inicio}–${f.fim}` : 'sem horário'].join(' · ');
  return (
    <div style={{ borderTop: '1px solid var(--borda)', paddingTop: 8 }}>
      <div className="flex" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span><b>{c.nome}</b> <span className="muted">· {resumo}</span></span>
        <button className="botao claro pequeno" onClick={() => setAberto(!aberto)}>{aberto ? 'Fechar' : 'Configurar'}</button>
      </div>
      {aberto && (
        <div className="form" style={{ marginTop: 8 }}>
          {!iaAqui && <div className="aviso l4">A IA não atende neste número (marque-o em "Em quais números", acima, e salve). Os especialistas abaixo valem quando ela for ligada aqui.</div>}
          <div className="l4">
            <label className="muted" style={{ fontSize: 13, fontWeight: 600 }}>Especialistas neste número (nenhum marcado = todos os ligados)</label>
            <div className="flex" style={{ gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
              {ligados.map((e) => <label key={e.id} className="check"><input type="checkbox" disabled={!admin} checked={f.esp.includes(e.id)} onChange={(ev) => setF({ ...f, esp: ev.target.checked ? [...f.esp, e.id] : f.esp.filter((x) => x !== e.id) })} /> {e.nome}</label>)}
              {!ligados.length && <span className="muted">Nenhum especialista ligado para este número.</span>}
            </div>
            {usados.length === 1 && <span className="muted" style={{ fontSize: 12 }}>Só um especialista: ele atende direto, sem recepção.</span>}
          </div>
          <label className="check l4"><input type="checkbox" disabled={!admin} checked={f.ativo} onChange={(e) => setF({ ...f, ativo: e.target.checked })} /> A equipe atende neste número só em um horário</label>
          {f.ativo && (
            <>
              <Campo rotulo="Das"><input type="time" disabled={!admin} value={f.inicio} onChange={(e) => setF({ ...f, inicio: e.target.value })} /></Campo>
              <Campo rotulo="Até"><input type="time" disabled={!admin} value={f.fim} onChange={(e) => setF({ ...f, fim: e.target.value })} /></Campo>
              <div className="l4 flex" style={{ gap: 12, flexWrap: 'wrap' }}>
                {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d, i) => (
                  <label key={d} className="check"><input type="checkbox" disabled={!admin} checked={f.dias.includes(i)} onChange={(e) => setF({ ...f, dias: e.target.checked ? [...f.dias, i].sort() : f.dias.filter((x) => x !== i) })} /> {d}</label>
                ))}
              </div>
              <label className="check l4"><input type="checkbox" disabled={!admin} checked={f.aviso} onChange={(e) => setF({ ...f, aviso: e.target.checked })} /> Quando a IA não estiver atendendo a conversa, mandar um aviso automático fora do horário</label>
              {f.aviso && (
                <Campo rotulo="Mensagem do aviso" className="l4" ajuda="{{horario}} vira o horário da equipe e {{retorno}} vira quando ela responde (ex.: amanhã a partir das 09:00). Em branco, usa a mensagem padrão.">
                  <textarea rows={2} maxLength={1000} disabled={!admin} value={f.msg} onChange={(e) => setF({ ...f, msg: e.target.value })} placeholder="Oi! Recebemos sua mensagem 💛 Nosso atendimento é {{horario}}. A equipe responde {{retorno}}." />
                </Campo>
              )}
            </>
          )}
          {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
          {salvar.isSuccess && <div className="aviso ok l4">Salvo.</div>}
          {admin && <div className="l4"><button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Salvar {c.nome}</button></div>}
        </div>
      )}
    </div>
  );
}

/** Especialistas: a recepção lê a conversa e passa para o do assunto. */
function Especialistas({ lista, admin }: { lista: Especialista[]; admin: boolean }) {
  const qc = useQueryClient();
  const canais = usarCanais();
  const [editar, setEditar] = useState<Partial<Especialista> | null>(null);
  const atualizar = () => qc.invalidateQueries({ queryKey: ['crm', 'ia-agente'] });
  const sugeridos = useMutation({ mutationFn: () => api('/crm/ia-agentes/sugeridos', { corpo: {} }), onSuccess: atualizar });
  const salvar = useMutation({
    mutationFn: (e: Partial<Especialista>) => api(e.id ? `/crm/ia-agentes/${e.id}` : '/crm/ia-agentes', { metodo: e.id ? 'PATCH' : 'POST', corpo: { funcao: e.funcao, nome: e.nome, quando: e.quando, instrucoes: e.instrucoes ?? '', conhecimento: e.conhecimento ?? '', ativo: e.ativo ?? true, ordem: Number(e.ordem) || 0, canais: e.canais ?? [] } }),
    onSuccess: () => { setEditar(null); atualizar(); },
  });
  const ligar = useMutation({ mutationFn: (e: Especialista) => api(`/crm/ia-agentes/${e.id}`, { metodo: 'PATCH', corpo: { ativo: !e.ativo } }), onSuccess: atualizar });
  const duplicar = useMutation({ mutationFn: (e: Especialista) => api<Especialista>(`/crm/ia-agentes/${e.id}/duplicar`, { corpo: {} }), onSuccess: (c) => { atualizar(); setEditar(c); } });
  const excluir = useMutation({ mutationFn: (id: string) => api(`/crm/ia-agentes/${id}`, { metodo: 'DELETE' }), onSuccess: () => { setEditar(null); atualizar(); } });
  const erros = camposComErro(salvar.error);
  const ativos = lista.filter((e) => e.ativo).length;
  return (
    <div className="cartao">
      <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <b>Especialistas</b>
        {admin && (
          <div className="flex">
            {lista.length < 3 && <button className="botao claro pequeno" disabled={sugeridos.isPending} onClick={() => sugeridos.mutate()}>Criar os sugeridos</button>}
            <button className="botao pequeno" onClick={() => setEditar({ ativo: true, ordem: lista.length + 1 })}>+ Especialista</button>
          </div>
        )}
      </div>
      <p className="muted" style={{ margin: '6px 0 10px', fontSize: 13 }}>
        {ativos
          ? 'A recepção (um modelo rápido e barato) lê a conversa, faz até uma pergunta se o assunto não estiver claro, e passa para o especialista. Se a pessoa mudar de assunto, o especialista passa para o outro. Todos usam o nome e o conhecimento geral acima, mais as instruções e o conhecimento próprios.'
          : 'Sem especialistas ligados, um agente só atende tudo com as instruções acima. Com especialistas, a recepção escolhe quem atende cada assunto.'}
      </p>
      {lista.length > 0 && (
        <table className="tabela">
          <thead><tr><th>Especialista</th><th>Situação</th><th>Atende quando</th><th></th></tr></thead>
          <tbody>
            {lista.map((e) => (
              <tr key={e.id} style={e.ativo ? undefined : { opacity: 0.55 }}>
                <td><b>{e.nome}</b><div className="muted" style={{ fontSize: 12 }}>{e.funcao}{e.canais?.length ? ` · só em ${e.canais.map((id) => canais.data?.find((c) => c.id === id)?.nome ?? '?').join(', ')}` : ''}</div></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {/* Mostra o estado, não a ação: marcado = ligado (atendendo). */}
                  <label className="check" title={admin ? (e.ativo ? 'Clique para desligar' : 'Clique para ligar') : undefined} style={{ cursor: admin ? 'pointer' : 'default' }}>
                    <input type="checkbox" checked={e.ativo} disabled={!admin || ligar.isPending} onChange={() => ligar.mutate(e)} />
                    <span className={`etiqueta ${e.ativo ? 'ok' : 'neutra'}`}>{e.ativo ? 'Ligado' : 'Desligado'}</span>
                  </label>
                </td>
                <td style={{ fontSize: 13 }}>{e.quando}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {admin && <button className="botao claro pequeno" onClick={() => setEditar(e)}>Editar</button>}{' '}
                  {admin && <button className="botao claro pequeno" title="Cria uma cópia desligada para você ajustar" disabled={duplicar.isPending} onClick={() => duplicar.mutate(e)}>Duplicar</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(sugeridos.error || ligar.error || duplicar.error) && <Erro erro={sugeridos.error ?? ligar.error ?? duplicar.error} />}
      {editar && (
        <div className="modal-fundo" onClick={() => setEditar(null)}>
          <div className="cartao modal" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 680 }}>
            <h3 style={{ marginTop: 0 }}>{editar.id ? `Editar ${editar.nome}` : 'Novo especialista'}</h3>
            <div className="form">
              <Campo rotulo="Nome (só a equipe vê)" erro={erros.nome} className="l2"><input value={editar.nome ?? ''} onChange={(ev) => setEditar({ ...editar, nome: ev.target.value })} placeholder="Ex.: Pós-venda" /></Campo>
              <Campo rotulo="Chave" erro={erros.funcao} ajuda="Minúsculas, sem espaço." ><input value={editar.funcao ?? ''} onChange={(ev) => setEditar({ ...editar, funcao: ev.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} placeholder="posvenda" /></Campo>
              <Campo rotulo="Ordem"><input type="number" min={0} max={100} value={editar.ordem ?? 0} onChange={(ev) => setEditar({ ...editar, ordem: Number(ev.target.value) })} /></Campo>
              <Campo rotulo="Quando a recepção passa para ele" erro={erros.quando} className="l4" ajuda="O assunto, com exemplos. É o que a recepção lê para decidir."><textarea rows={3} maxLength={600} value={editar.quando ?? ''} onChange={(ev) => setEditar({ ...editar, quando: ev.target.value })} placeholder="Ex.: troca, defeito ou garantia de peça já comprada." /></Campo>
              <Campo rotulo="Como atender este assunto" className="l4"><textarea rows={5} maxLength={20000} value={editar.instrucoes ?? ''} onChange={(ev) => setEditar({ ...editar, instrucoes: ev.target.value })} /></Campo>
              <Campo rotulo="O que ele precisa saber deste assunto" className="l4" ajuda="Só o que é deste assunto (o conhecimento geral já vai junto)."><textarea rows={6} maxLength={100000} value={editar.conhecimento ?? ''} onChange={(ev) => setEditar({ ...editar, conhecimento: ev.target.value })} /></Campo>
              <div className="l4">
                <label className="muted" style={{ fontSize: 13, fontWeight: 600 }}>Atende em quais números (nenhum marcado = todos)</label>
                <div className="flex" style={{ gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
                  {canais.data?.map((c) => <label key={c.id} className="check"><input type="checkbox" checked={(editar.canais ?? []).includes(c.id)} onChange={(ev) => setEditar({ ...editar, canais: ev.target.checked ? [...(editar.canais ?? []), c.id] : (editar.canais ?? []).filter((x) => x !== c.id) })} /> {c.nome}</label>)}
                </div>
                <span className="muted" style={{ fontSize: 12 }}>Se for o único especialista de um número, atende direto, sem passar pela recepção.</span>
              </div>
              <label className="check l4"><input type="checkbox" checked={editar.ativo ?? true} onChange={(ev) => setEditar({ ...editar, ativo: ev.target.checked })} /> Ligado</label>
            </div>
            {salvar.error && <Erro erro={salvar.error} />}
            {excluir.error && <Erro erro={excluir.error} />}
            <div className="flex" style={{ marginTop: 12 }}>
              <button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate(editar)}>Salvar</button>
              <button className="botao claro" onClick={() => setEditar(null)}>Voltar</button>
              {editar.id && <button className="botao perigo" style={{ marginLeft: 'auto' }} disabled={excluir.isPending} onClick={() => window.confirm(`Excluir o especialista ${editar.nome}? As conversas com ele voltam para a recepção.`) && excluir.mutate(editar.id!)}>Excluir</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const NOME_RECURSO: Record<string, string> = { agente: 'Agente no WhatsApp', triagem: 'Recepção do agente (escolhe o especialista)', sugestao: 'Sugestão de resposta', reconhecer_peca: 'Reconhecer peça pela foto', maleta: 'Sugestão de maleta', foto: 'Foto de catálogo', transcricao: 'Transcrição de áudio', teste: 'Teste de conexão' };

/** Quantas vezes a IA foi chamada neste mês (a cobrança é das empresas de IA, pelo consumo). */
function UsoIa() {
  const q = useQuery({ queryKey: ['ia', 'uso'], queryFn: () => api<{ recurso: string; chamadas: number; entrada: number; saida: number }[]>('/ia/uso'), enabled: pode('configuracoes', 'ver') });
  if (!q.data?.length) return null;
  return (
    <div className="cartao">
      <b>Uso da IA neste mês</b>
      <table className="tabela" style={{ marginTop: 8 }}>
        <thead><tr><th>Recurso</th><th className="num">Chamadas</th><th className="num">Texto lido (tokens)</th><th className="num">Texto escrito (tokens)</th></tr></thead>
        <tbody>{q.data.map((r) => <tr key={r.recurso}><td>{NOME_RECURSO[r.recurso] ?? r.recurso}</td><td className="num">{r.chamadas.toLocaleString('pt-BR')}</td><td className="num">{r.entrada.toLocaleString('pt-BR')}</td><td className="num">{r.saida.toLocaleString('pt-BR')}</td></tr>)}</tbody>
      </table>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>O valor cobrado aparece no painel da Anthropic (Claude) e da OpenAI; elas cobram pela quantidade de tokens.</p>
    </div>
  );
}


interface Licao { id: string; funcao: string | null; quando: string; resposta: string; status: 'ativa' | 'pendente' | 'recusada'; origem: 'correcao' | 'semanal' | 'manual'; criadoEm: string; por: string | null }
const ORIGEM: Record<Licao['origem'], string> = { correcao: 'Correção no chat', semanal: 'Revisão semanal', manual: 'Escrita à mão' };

/** O que a IA aprendeu: correções da equipe e sugestões da revisão semanal, para a gestão aprovar. */
function Licoes({ especialistas, admin }: { especialistas: Especialista[]; admin: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['crm', 'ia-licoes'], queryFn: () => api<Licao[]>('/crm/ia-licoes') });
  const [editando, setEditando] = useState<Partial<Licao> | null>(null);
  const [verRecusadas, setVerRecusadas] = useState(false);
  const atualizar = () => qc.invalidateQueries({ queryKey: ['crm', 'ia-licoes'] });
  const mudar = useMutation({ mutationFn: ({ id, ...corpo }: { id: string; status: Licao['status'] }) => api(`/crm/ia-licoes/${id}`, { metodo: 'PATCH', corpo }), onSuccess: atualizar });
  const apagar = useMutation({ mutationFn: (id: string) => api(`/crm/ia-licoes/${id}`, { metodo: 'DELETE' }), onSuccess: atualizar });
  const revisar = useMutation({ mutationFn: () => api<{ conversas: number; sugestoes: number }>('/crm/ia-licoes/revisar', { corpo: {} }), onSuccess: atualizar });
  const salvar = useMutation({
    mutationFn: () => (editando!.id ? api(`/crm/ia-licoes/${editando!.id}`, { metodo: 'PATCH', corpo: { funcao: editando!.funcao || null, quando: editando!.quando, resposta: editando!.resposta } }) : api('/crm/ia-licoes', { corpo: { funcao: editando!.funcao || null, quando: editando!.quando, resposta: editando!.resposta } })),
    onSuccess: () => { setEditando(null); atualizar(); },
  });
  const lista = q.data ?? [];
  const pendentes = lista.filter((l) => l.status === 'pendente');
  const ativas = lista.filter((l) => l.status === 'ativa');
  const recusadas = lista.filter((l) => l.status === 'recusada');
  const nomeDe = (f: string | null) => (f ? especialistas.find((e) => e.funcao === f)?.nome ?? f : 'Todos');
  const linha = (l: Licao) => (
    <div key={l.id} style={{ padding: '10px 0', borderTop: '1px dashed var(--linha)' }}>
      <div><b>Quando:</b> {l.quando}</div>
      <div><b>Faça:</b> {l.resposta}</div>
      <div className="flex entre" style={{ flexWrap: 'wrap', marginTop: 4 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>{nomeDe(l.funcao)} · {ORIGEM[l.origem]}{l.por ? ` · ${l.por}` : ''}</span>
        {admin && (
          <span className="flex" style={{ gap: 6 }}>
            {l.status !== 'ativa' && <button className="botao pequeno" disabled={mudar.isPending} onClick={() => mudar.mutate({ id: l.id, status: 'ativa' })}>Aprovar</button>}
            {l.status === 'pendente' && <button className="botao claro pequeno" disabled={mudar.isPending} onClick={() => mudar.mutate({ id: l.id, status: 'recusada' })}>Recusar</button>}
            {l.status === 'ativa' && <button className="botao claro pequeno" disabled={mudar.isPending} onClick={() => mudar.mutate({ id: l.id, status: 'pendente' })}>Pausar</button>}
            <button className="botao claro pequeno" onClick={() => setEditando(l)}>Editar</button>
            <button className="botao claro pequeno" disabled={apagar.isPending} onClick={() => window.confirm('Apagar esta lição?') && apagar.mutate(l.id)}>Apagar</button>
          </span>
        )}
      </div>
    </div>
  );
  return (
    <div className="cartao">
      <div className="flex entre" style={{ flexWrap: 'wrap' }}>
        <b>O que a IA aprendeu</b>
        {admin && <span className="flex" style={{ gap: 6 }}><button className="botao claro pequeno" disabled={revisar.isPending} title="Relê as conversas que a IA passou para a equipe nos últimos 7 dias e sugere lições" onClick={() => revisar.mutate()}>{revisar.isPending ? 'Revisando…' : 'Revisar a semana agora'}</button><button className="botao pequeno" onClick={() => setEditando({ funcao: null, quando: '', resposta: '' })}>Nova lição</button></span>}
      </div>
      <p className="muted" style={{ margin: '6px 0 0' }}>Lições são regras do tipo "quando acontecer isto, responda aquilo". Nascem quando alguém clica em "Corrigir a IA" numa resposta dela no chat, ou da revisão semanal (toda segunda-feira a IA relê as conversas que passou para a equipe e sugere o que poderia ter respondido). Só as aprovadas entram nas instruções dela.</p>
      {revisar.isSuccess && <div className="aviso ok" style={{ marginTop: 8 }}>{revisar.data.conversas === 0 ? 'Nenhuma conversa passada para a equipe e respondida por uma pessoa nos últimos 7 dias.' : `${revisar.data.conversas} conversa(s) revisada(s), ${revisar.data.sugestoes} sugestão(ões) nova(s).`}</div>}
      {revisar.error && <Erro erro={revisar.error} />}
      {mudar.error && <Erro erro={mudar.error} />}
      {q.isLoading ? <Carregando /> : (
        <>
          <div className="secao">Esperando aprovação ({pendentes.length})</div>
          {pendentes.length ? pendentes.map(linha) : <p className="muted" style={{ margin: 0 }}>Nada esperando.</p>}
          <div className="secao">Valendo ({ativas.length})</div>
          {ativas.length ? ativas.map(linha) : <p className="muted" style={{ margin: 0 }}>Nenhuma lição ativa ainda.</p>}
          {recusadas.length > 0 && <button className="botao claro pequeno" style={{ marginTop: 10 }} onClick={() => setVerRecusadas((v) => !v)}>{verRecusadas ? 'Esconder' : 'Ver'} recusadas ({recusadas.length})</button>}
          {verRecusadas && recusadas.map(linha)}
        </>
      )}
      {editando && (
        <div className="modal-fundo" onClick={() => setEditando(null)}>
          <div className="cartao modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 10px' }}>{editando.id ? 'Editar lição' : 'Nova lição'}</h3>
            <Campo rotulo="Vale para"><select value={editando.funcao ?? ''} onChange={(e) => setEditando({ ...editando, funcao: e.target.value || null })}><option value="">Todos os especialistas</option>{especialistas.map((e) => <option key={e.id} value={e.funcao}>{e.nome}</option>)}</select></Campo>
            <Campo rotulo="Quando acontecer isto"><textarea rows={2} maxLength={400} value={editando.quando ?? ''} onChange={(e) => setEditando({ ...editando, quando: e.target.value })} /></Campo>
            <Campo rotulo="A IA deve responder ou fazer isto"><textarea rows={4} maxLength={1200} value={editando.resposta ?? ''} onChange={(e) => setEditando({ ...editando, resposta: e.target.value })} /></Campo>
            {salvar.error && <Erro erro={salvar.error} />}
            <div className="flex" style={{ marginTop: 12 }}>
              <button className="botao" disabled={salvar.isPending || (editando.quando ?? '').trim().length < 8 || (editando.resposta ?? '').trim().length < 8} onClick={() => salvar.mutate()}>Salvar</button>
              <button className="botao claro" onClick={() => setEditando(null)}>Voltar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
