import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../../api';
import { Abas, Campo, Carregando, Erro } from '../../componentes/ui';
import { Distribuicao } from './Distribuicao';
import { NOME_TIPO_CANAL, NovoCampo, TIPOS_CAMPO, usarAtendentes, usarCampos, usarCanais, usarFunis, variavelDoCampo, type CampoDef, type Canal, type Template, type TipoCanal } from './comum';

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
  const sit = useQuery({ queryKey: ['crm', 'canal', c.id, 'situacao'], queryFn: () => api<{ conectado: boolean; detalhe: string; qrcode?: string | null }>(`/crm/canais/${c.id}/situacao`), refetchInterval: (q) => (q.state.data && !q.state.data.conectado && c.tipo !== 'oficial' ? (c.tipo === 'evolution' ? 3000 : 5000) : 60_000) });
  const acao = useMutation({ mutationFn: (a: string) => api<any>(`/crm/canais/${c.id}/${a}`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }) });
  const [copiado, setCopiado] = useState(false);
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
            {c.ultimoWebhookEm ? `Último aviso do WhatsApp para o sistema: ${new Date(c.ultimoWebhookEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : c.tipo === 'oficial' ? 'O WhatsApp ainda não avisou o sistema de nenhuma mensagem por este número: confira o webhook no app da Meta.' : 'O WhatsApp ainda não avisou o sistema de nenhuma mensagem por este número. Se já mandaram mensagem para ele, clique em "Reapontar webhook".'}
          </div>
        </div>
        {admin && (
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            {c.tipo === 'oficial' && pode('crm', 'excluir') && <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate('templates')}>Sincronizar templates</button>}
            {c.tipo !== 'oficial' && <button className="botao claro pequeno" title="Use se as mensagens recebidas pararam de chegar: manda o WhatsApp avisar o sistema neste endereço de novo" disabled={acao.isPending} onClick={() => acao.mutate('webhook')}>Reapontar webhook</button>}
            {c.tipo !== 'oficial' && sit.data?.conectado && <button className="botao claro pequeno" onClick={() => window.confirm('Desconectar este celular do sistema?') && acao.mutate('desconectar')}>Desconectar</button>}
            <button className="botao claro pequeno" onClick={editar}>Editar</button>
            <button className="botao claro pequeno perigo" disabled={excluir.isPending} onClick={confirmarExclusao}>{excluir.isPending ? 'Excluindo…' : 'Excluir'}</button>
          </div>
        )}
      </div>
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
          {c.tipo === 'oficial' && <div>No app da Meta (WhatsApp › Configuração), cole este endereço como URL de retorno e use como token de verificação o final do endereço (depois da última barra). Assine os campos "messages".</div>}
        </div>
      )}
    </div>
  );
}

function FormCanal({ tipo, canal, fechar, porToken: novoPorToken }: { tipo: TipoCanal; canal?: Canal; fechar: (criadoId?: string) => void; porToken?: boolean }) {
  // Evolution ligada pelo token de uma instância que já existe (em vez do QR code criado pelo sistema).
  const porToken = tipo === 'evolution' && (canal ? !!canal.config?.servidor : !!novoPorToken);
  const qc = useQueryClient();
  const atendentes = usarAtendentes();
  const funis = usarFunis();
  const [f, setF] = useState({ nome: canal?.nome ?? '', config: { ...(canal?.config ?? {}) } as Record<string, string>, atendentes: canal?.atendentes ?? [], usuarioId: canal?.usuarioId ?? '', funilEntradaId: canal?.funilEntradaId ?? '', ativo: canal?.ativo ?? true });
  const salvar = useMutation({
    mutationFn: () => {
      const corpo = { nome: f.nome, config: f.config, atendentes: f.atendentes, usuarioId: f.usuarioId || null, funilEntradaId: f.funilEntradaId || null, ...(canal ? { ativo: f.ativo } : { tipo }) };
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
      <div className="secao" style={{ gridColumn: '1 / -1', marginTop: 0 }}>{canal ? `Editar ${canal.nome}` : tipo === 'oficial' ? 'Novo WhatsApp oficial (API Cloud da Meta)' : porToken ? 'Evolution API com token (instância que já existe)' : tipo === 'evolution' ? 'Evolution API por QR code' : 'Novo WhatsApp pela Z-API (ID da instância e token)'}</div>
      {porToken && !canal && <p className="muted l4" style={{ margin: 0 }}>Para um número que já está numa instância do seu servidor Evolution. O sistema confere os dados, aponta o webhook da instância para cá e não cria nem apaga nada no seu servidor. Se a instância estiver desconectada, o QR code aparece aqui.</p>}
      {tipo === 'evolution' && !porToken && !canal && <p className="muted l4" style={{ margin: 0 }}>Só dê um nome ao número e salve. O QR code aparece na hora: é ler com o celular e pronto, sem digitar nenhum código.</p>}
      <Campo rotulo="Nome do número" className="l2"><input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder={tipo === 'oficial' ? 'Matriz oficial' : 'Celular da Ana'} /></Campo>
      {tipo === 'oficial' ? (
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
      {tipo !== 'oficial' && (
        <Campo rotulo="Dono do número (opcional)" className="l2" ajuda="Celular de uma atendente">
          <select value={f.usuarioId} onChange={(e) => setF({ ...f, usuarioId: e.target.value })}><option value="">Número da empresa</option>{atendentes.data?.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}</select>
        </Campo>
      )}
      <div className="l4">
        <label className="muted" style={{ fontSize: 13, fontWeight: 600 }}>Quem atende por este número (nenhum marcado = toda a equipe do CRM)</label>
        <div className="flex" style={{ gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
          {atendentes.data?.map((a) => <label key={a.id} className="check"><input type="checkbox" checked={f.atendentes.includes(a.id)} onChange={(e) => setF({ ...f, atendentes: e.target.checked ? [...f.atendentes, a.id] : f.atendentes.filter((x) => x !== a.id) })} /> {a.nome}</label>)}
        </div>
      </div>
      {canal && <label className="check l4"><input type="checkbox" checked={f.ativo} onChange={(e) => setF({ ...f, ativo: e.target.checked })} /> Número ativo</label>}
      {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
      <div className="flex l4">
        <button className="botao" disabled={!f.nome.trim() || salvar.isPending || (porToken && !canal && !(f.config.servidor?.trim() && f.config.instancia?.trim() && f.config.token?.trim()))} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Preparando…' : porToken ? (canal ? 'Salvar' : 'Conferir e conectar') : tipo === 'evolution' && !canal ? 'Salvar e mostrar o QR code' : 'Salvar'}</button>
        <button className="botao claro" onClick={() => fechar()}>Voltar</button>
      </div>
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
            <textarea rows={3} placeholder="Oi {{primeiro_nome}}, …" value={f.texto} onChange={(e) => setF({ ...f, texto: e.target.value })} style={sel} />
            <div><button className="botao claro" disabled={!f.nome.trim() || !f.texto.trim()} onClick={() => { m.mutate({ rota: '/crm/templates', corpo: f }); setF({ nome: '', texto: '' }); }}>Criar modelo</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────── Respostas rápidas ─────────────

function Respostas() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['crm', 'respostas'], queryFn: () => api<{ id: string; atalho: string; texto: string }[]>('/crm/respostas') });
  const [f, setF] = useState({ atalho: '', texto: '' });
  const m = useMutation({ mutationFn: ({ rota, metodo, corpo }: { rota: string; metodo?: string; corpo?: unknown }) => api(rota, { metodo, corpo: corpo ?? {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'respostas'] }) });
  const gestor = pode('crm', 'excluir');
  if (q.isLoading) return <Carregando />;
  return (
    <div className="cartao">
      <p className="muted" style={{ marginTop: 0 }}>No chat, digite "/" e o atalho para inserir o texto.</p>
      {m.error && <Erro erro={m.error} />}
      <table className="tabela">
        <thead><tr><th>Atalho</th><th>Texto</th><th></th></tr></thead>
        <tbody>{q.data?.map((r) => <tr key={r.id}><td><code>/{r.atalho}</code></td><td style={{ whiteSpace: 'pre-wrap' }}>{r.texto}</td><td>{gestor && <button className="botao perigo pequeno" onClick={() => m.mutate({ rota: `/crm/respostas/${r.id}`, metodo: 'DELETE' })}>Apagar</button>}</td></tr>)}</tbody>
      </table>
      {gestor && (
        <div className="flex" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          <input placeholder="atalho" value={f.atalho} onChange={(e) => setF({ ...f, atalho: e.target.value })} style={{ ...sel, width: 140 }} />
          <input placeholder="Texto da resposta" value={f.texto} onChange={(e) => setF({ ...f, texto: e.target.value })} style={{ ...sel, flex: 1, minWidth: 240 }} />
          <button className="botao claro" disabled={!f.atalho.trim() || !f.texto.trim()} onClick={() => { m.mutate({ rota: '/crm/respostas', corpo: f }); setF({ atalho: '', texto: '' }); }}>Adicionar</button>
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

interface ConfigAgente { ativo: boolean; canais: string[]; instrucoes: string; conhecimento: string; maxRespostas: number; ligada: boolean }

/** O agente que atende no WhatsApp enquanto ninguém da equipe pegou a conversa. */
function AgenteIa() {
  const qc = useQueryClient();
  const admin = pode('configuracoes', 'editar');
  const q = useQuery({ queryKey: ['crm', 'ia-agente'], queryFn: () => api<ConfigAgente>('/crm/ia-agente') });
  const canais = usarCanais();
  const [f, setF] = useState<ConfigAgente | null>(null);
  useEffect(() => { if (q.data && !f) setF(q.data); }, [q.data, f]);
  const salvar = useMutation({ mutationFn: () => api<ConfigAgente>('/crm/ia-agente', { metodo: 'PUT', corpo: { ativo: f!.ativo, canais: f!.canais, instrucoes: f!.instrucoes, conhecimento: f!.conhecimento, maxRespostas: f!.maxRespostas } }), onSuccess: (r) => { setF(r); qc.invalidateQueries({ queryKey: ['crm', 'ia-agente'] }); } });
  if (q.isLoading || !f) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  return (
    <div className="coluna" style={{ gap: 12 }}>
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
        <Campo rotulo="Como ela deve atender" className="l4" ajuda="O tom, o objetivo e o que perguntar. Ex.: trate por você; descubra se a pessoa quer comprar ou ser revendedora; para revendedora, peça a cidade.">
          <textarea rows={5} maxLength={6000} disabled={!admin} value={f.instrucoes} onChange={(e) => setF({ ...f, instrucoes: e.target.value })} />
        </Campo>
        <Campo rotulo="O que ela precisa saber sobre a empresa" className="l4" ajuda="Endereço, horário, formas de pagamento, como funciona a revenda, prazo de entrega, perguntas frequentes. Ela só afirma o que estiver escrito aqui; o resto ela diz que vai confirmar com a equipe.">
          <textarea rows={10} maxLength={20000} disabled={!admin} value={f.conhecimento} onChange={(e) => setF({ ...f, conhecimento: e.target.value })} />
        </Campo>
        <Campo rotulo="Respostas seguidas antes de passar para a equipe" className="l2" ajuda="Evita conversa em círculo. Chegando ao limite, a conversa fica na fila com um recado.">
          <input type="number" min={1} max={50} disabled={!admin} value={f.maxRespostas} onChange={(e) => setF({ ...f, maxRespostas: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} />
        </Campo>
        {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
        {salvar.isSuccess && <div className="aviso ok l4">Salvo. {f.ativo ? 'O agente já está atendendo as conversas novas.' : 'O agente está desligado.'}</div>}
        {admin && <div className="l4"><button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Salvar</button></div>}
      </div>
      <UsoIa />
      <div className="cartao">
        <b>No chat</b>
        <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          <li>As mensagens da IA aparecem marcadas com "IA", e a conversa mostra um aviso enquanto ela está atendendo.</li>
          <li>"✨ Sugerir" escreve uma resposta para você revisar e enviar. Funciona mesmo com o agente desligado.</li>
          <li>"🤖 Acionar IA" liga a IA só naquela conversa; "Pausar IA" desliga.</li>
          <li>Quando a IA passa a conversa, ela deixa um recado interno dizendo o motivo.</li>
        </ul>
      </div>
    </div>
  );
}

const NOME_RECURSO: Record<string, string> = { agente: 'Agente no WhatsApp', sugestao: 'Sugestão de resposta', reconhecer_peca: 'Reconhecer peça pela foto', maleta: 'Sugestão de maleta', foto: 'Foto de catálogo', teste: 'Teste de conexão' };

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
