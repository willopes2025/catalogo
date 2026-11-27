import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../api';
import { dataHora } from '../formato';
import { Campo, Carregando, Erro } from '../componentes/ui';
import { TextoComVariaveis } from '../componentes/TextoComVariaveis';

/** Lê e grava uma configuração por chave (impressao, avisos, regras_garantia, regras_comissao). */
function useConfig<T>(chave: string) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', chave], queryFn: () => api<T>(`/configuracoes/chave/${chave}`) });
  const [v, setV] = useState<T | null>(null);
  useEffect(() => { if (q.data) setV(q.data); }, [q.data]);
  const salvar = useMutation({ mutationFn: (valor: T) => api<T>(`/configuracoes/chave/${chave}`, { metodo: 'PUT', corpo: valor }), onSuccess: () => qc.invalidateQueries({ queryKey: ['config', chave] }) });
  return { v, setV, salvar, carregando: q.isLoading };
}

const num = (s: string) => (s.trim() === '' ? 0 : Number(s.replace(',', '.')));
const pctTexto = (pb: number) => String(pb / 100).replace('.', ',');
const pbDe = (s: string) => Math.round(num(s) * 100);

function Salvar({ s, valor }: { s: { mutate: (v: any) => void; isPending: boolean; isSuccess: boolean; error: unknown }; valor: unknown }) {
  return (
    <div className="campo" style={{ gridColumn: 'span 4' }}>
      {s.error ? <Erro erro={s.error} /> : null}
      <div className="flex">
        <button className="botao" disabled={!pode('configuracoes', 'editar') || s.isPending} onClick={() => s.mutate(valor)}>Salvar</button>
        {s.isSuccess && <span className="muted">Salvo.</span>}
      </div>
    </div>
  );
}

export function AvisosERegras() {
  return (
    <div className="coluna">
      <Avisos />
      <MensagensAgenda />
      <MensagemApp />
      <Impressao />
      <OutrasRegras />
    </div>
  );
}

interface CfgMsgApp { ativo: boolean; canalId: string | null; texto: string }

/** WhatsApp para a consultora quando ela assina o contrato: como instalar o app. */
function MensagemApp() {
  const { v, setV, salvar, carregando } = useConfig<CfgMsgApp>('mensagem_app');
  const padrao = useQuery({ queryKey: ['config-padrao', 'mensagem_app'], queryFn: () => api<CfgMsgApp>('/configuracoes/padrao/mensagem_app'), staleTime: Infinity });
  const canais = useQuery({ queryKey: ['crm', 'canais'], queryFn: () => api<{ id: string; nome: string; tipo: string; ativo: boolean }[]>('/crm/canais') });
  if (carregando || !v) return <Carregando />;
  return (
    <div className="cartao form">
      <div className="secao">Mensagem do app ao assinar o contrato (WhatsApp)</div>
      <label className="check l2"><input type="checkbox" checked={v.ativo} onChange={(e) => setV({ ...v, ativo: e.target.checked })} /> Mandar quando a consultora assinar o contrato (uma vez por consultora)</label>
      <Campo rotulo="Número que manda" className="l2" ajuda="Em branco: o primeiro número por QR code ligado ao CRM.">
        <select value={v.canalId ?? ''} onChange={(e) => setV({ ...v, canalId: e.target.value || null })}>
          <option value="">Automático (primeiro número por QR code)</option>
          {canais.data?.filter((c) => c.ativo).map((c) => <option key={c.id} value={c.id}>{c.nome}{c.tipo === 'oficial' ? ' (oficial: só chega se a pessoa escreveu nas últimas 24 h)' : ''}</option>)}
        </select>
      </Campo>
      <div className="campo" style={{ gridColumn: 'span 4' }}>
        <div className="flex entre" style={{ gap: 8, flexWrap: 'wrap' }}>
          <label htmlFor="msg-app"><b>Texto</b> <span className="muted" style={{ fontSize: 12 }}>· variáveis: {'{{primeiro_nome}}'} {'{{nome}}'} {'{{link_android}}'} (baixar o app) {'{{link_portal}}'} (portal, para o iPhone) {'{{link_acesso}}'} (link de acesso direto; se faltar no texto, vai no fim)</span></label>
          {padrao.data && v.texto !== padrao.data.texto && <button type="button" className="botao claro pequeno" onClick={() => setV({ ...v, texto: padrao.data!.texto })}>Voltar ao padrão</button>}
        </div>
        <TextoComVariaveis id="msg-app" linhas={9} maxLength={2000} value={v.texto} onChange={(t) => setV({ ...v, texto: t })} variaveis={[{ nome: 'primeiro_nome', rotulo: 'Primeiro nome' }, { nome: 'nome', rotulo: 'Nome completo' }, { nome: 'link_android', rotulo: 'Link para baixar o app (Android)' }, { nome: 'link_portal', rotulo: 'Endereço do portal (iPhone)' }, { nome: 'link_acesso', rotulo: 'Link de acesso direto (7 dias)' }]} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
      </div>
      <Salvar s={salvar} valor={v} />
    </div>
  );
}

interface CfgMsgAgenda { canalId: string | null; marcado: string; remarcado: string; cancelado: string; lembrete_dia: string; lembrete_hora: string }
const MSGS_AGENDA: [keyof Omit<CfgMsgAgenda, 'canalId'>, string, string][] = [
  ['marcado', 'Ao marcar', 'Sai assim que o compromisso é marcado (com "Avisar pelo WhatsApp" ligado).'],
  ['remarcado', 'Ao remarcar', 'Quando a data ou a hora mudam.'],
  ['cancelado', 'Ao cancelar', 'Quando o compromisso é cancelado.'],
  ['lembrete_dia', 'Na véspera', 'No dia anterior ao compromisso.'],
  ['lembrete_hora', 'Pouco antes', 'Perto do horário.'],
];
const VARS_AGENDA = ['primeiro_nome', 'nome', 'titulo', 'dia', 'hora', 'onde', 'link', 'local', 'portal'];
const EXEMPLO_AGENDA: Record<string, string> = { primeiro_nome: 'Patrícia', nome: 'Patrícia Moura', titulo: 'Entrevista de candidata', dia: 'quinta-feira, 26/11', hora: '10:00', onde: 'Link da chamada: https://meet.google.com/abc-defg-hij', link: 'https://meet.google.com/abc-defg-hij', local: '', portal: 'Confirme no portal: https://aritana.wideic.com/portal' };
const previaAgenda = (t: string) => t.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => EXEMPLO_AGENDA[k] ?? '').split('\n').filter((l) => l.trim()).join('\n');

/** Mensagens de WhatsApp da Agenda: texto de cada aviso e o número que manda. */
function MensagensAgenda() {
  const { v, setV, salvar, carregando } = useConfig<CfgMsgAgenda>('mensagens_agenda');
  const padrao = useQuery({ queryKey: ['config-padrao', 'mensagens_agenda'], queryFn: () => api<CfgMsgAgenda>('/configuracoes/padrao/mensagens_agenda'), staleTime: Infinity });
  const canais = useQuery({ queryKey: ['crm', 'canais'], queryFn: () => api<{ id: string; nome: string; tipo: string; ativo: boolean }[]>('/crm/canais') });
  const [aberta, setAberta] = useState<string | null>(null);
  if (carregando || !v) return <Carregando />;
  return (
    <div className="cartao form">
      <div className="secao">Mensagens da Agenda (WhatsApp)</div>
      <Campo rotulo="Número que manda os avisos da Agenda" className="l2" ajuda="Em branco: o primeiro número por QR code ligado ao CRM.">
        <select value={v.canalId ?? ''} onChange={(e) => setV({ ...v, canalId: e.target.value || null })}>
          <option value="">Automático (primeiro número por QR code)</option>
          {canais.data?.filter((c) => c.ativo).map((c) => <option key={c.id} value={c.id}>{c.nome}{c.tipo === 'oficial' ? ' (oficial: só chega se a pessoa escreveu nas últimas 24 h)' : ''}</option>)}
        </select>
      </Campo>
      <p className="muted" style={{ gridColumn: 'span 4', margin: 0 }}>
        Variáveis (clique para copiar): {VARS_AGENDA.map((x) => <button key={x} type="button" className="tag" style={{ marginRight: 4, cursor: 'pointer', border: 0 }} onClick={() => void navigator.clipboard?.writeText(`{{${x}}}`).catch(() => undefined)}>{`{{${x}}}`}</button>)}
        <br />{'{{onde}}'} vira "Link da chamada: …" no online ou "Local: …" no presencial. {'{{portal}}'} só aparece para consultora. Linha que ficar vazia some sozinha. Use *asteriscos* para negrito no WhatsApp.
      </p>
      {MSGS_AGENDA.map(([k, rotulo, ajuda]) => (
        <div key={k} className="campo" style={{ gridColumn: 'span 4' }}>
          <div className="flex entre" style={{ gap: 8, flexWrap: 'wrap' }}>
            <label htmlFor={`msg-agenda-${k}`}><b>{rotulo}</b> <span className="muted" style={{ fontSize: 12 }}>· {ajuda}</span></label>
            <span className="flex" style={{ gap: 6 }}>
              <button type="button" className="botao claro pequeno" onClick={() => setAberta(aberta === k ? null : k)}>{aberta === k ? 'Esconder prévia' : 'Ver prévia'}</button>
              {padrao.data && v[k] !== padrao.data[k] && <button type="button" className="botao claro pequeno" onClick={() => setV({ ...v, [k]: padrao.data![k] })}>Voltar ao padrão</button>}
            </span>
          </div>
          <TextoComVariaveis id={`msg-agenda-${k}`} linhas={4} maxLength={1500} value={v[k]} onChange={(t) => setV({ ...v, [k]: t })} variaveis={VARS_AGENDA} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
          {aberta === k && <div className="aviso" style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}><b>Exemplo:</b>{'\n'}{previaAgenda(v[k])}</div>}
        </div>
      ))}
      <Salvar s={salvar} valor={v} />
    </div>
  );
}

interface CfgAvisos { ativo: boolean; hora: number; emailsEquipe: string[]; diasAntesMaleta: number; diasAntesTitulo: number }

function Avisos() {
  const { v, setV, salvar, carregando } = useConfig<CfgAvisos>('avisos');
  const [emails, setEmails] = useState('');
  const previa = useQuery({ queryKey: ['avisos-previa'], queryFn: () => api<{ chave: string; para: string; assunto: string }[]>('/avisos/previa') });
  const hist = useQuery({ queryKey: ['avisos-historico'], queryFn: () => api<any[]>('/avisos/historico') });
  const qc = useQueryClient();
  const executar = useMutation({ mutationFn: () => api<{ enviados: number; jaEnviados: number; falhas: number }>('/avisos/executar', { corpo: {} }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['avisos-historico'] }); } });
  useEffect(() => { if (v) setEmails(v.emailsEquipe.join(', ')); }, [v?.emailsEquipe.join()]);
  if (carregando || !v) return <Carregando />;
  const enviados = new Set((hist.data ?? []).map((h) => h.chave));
  const pendentes = (previa.data ?? []).filter((p) => !enviados.has(p.chave));
  const valor = { ...v, emailsEquipe: emails.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean) };
  return (
    <div className="cartao form">
      <div className="secao">Avisos automáticos por e-mail</div>
      <label className="check l2"><input type="checkbox" checked={v.ativo} onChange={(e) => setV({ ...v, ativo: e.target.checked })} /> Enviar avisos todos os dias</label>
      <Campo rotulo="A partir de que hora" ajuda="Horário de Brasília"><select value={v.hora} onChange={(e) => setV({ ...v, hora: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}h</option>)}</select></Campo>
      <div />
      <Campo rotulo="Lembrar o acerto da maleta" ajuda="Dias antes da data limite"><input type="number" min={0} max={15} value={v.diasAntesMaleta} onChange={(e) => setV({ ...v, diasAntesMaleta: Number(e.target.value) })} /></Campo>
      <Campo rotulo="Lembrar a parcela" ajuda="Dias antes do vencimento"><input type="number" min={0} max={15} value={v.diasAntesTitulo} onChange={(e) => setV({ ...v, diasAntesTitulo: Number(e.target.value) })} /></Campo>
      <Campo rotulo="E-mails da equipe para o resumo do dia" className="l2" ajuda="Separe por vírgula. Em branco, não envia resumo."><input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="gerencia@aritana..., financeiro@aritana..." /></Campo>
      <p className="muted" style={{ gridColumn: 'span 4', margin: 0 }}>
        A representante recebe o lembrete do acerto e, se atrasar, um aviso de atraso. Cliente e representante recebem o lembrete das parcelas, com o link do boleto ou o Pix quando houver. Cada aviso sai uma vez só. Sem e-mail cadastrado, a pessoa não recebe.
      </p>
      <Salvar s={salvar} valor={valor} />
      <div className="secao">Hoje</div>
      <div style={{ gridColumn: 'span 4' }} className="coluna">
        {previa.error ? <Erro erro={previa.error} /> : (
          <div className="muted">{pendentes.length ? `${pendentes.length} aviso(s) ainda não enviado(s) hoje:` : 'Nenhum aviso pendente agora.'}</div>
        )}
        {pendentes.length > 0 && <ul style={{ margin: 0 }}>{pendentes.slice(0, 15).map((p) => <li key={p.chave}><b>{p.para}</b> · {p.assunto}</li>)}</ul>}
        {executar.error ? <Erro erro={executar.error} /> : null}
        {executar.data && <div className="aviso ok">{executar.data.enviados} enviado(s){executar.data.falhas ? `, ${executar.data.falhas} falha(s): confira o e-mail em Integrações` : ''}.</div>}
        <div><button className="botao claro" disabled={!pode('configuracoes', 'editar') || executar.isPending || !pendentes.length} onClick={() => executar.mutate()}>Enviar agora</button></div>
        {!!hist.data?.length && (
          <details>
            <summary className="muted" style={{ cursor: 'pointer' }}>Últimos enviados</summary>
            <table className="tabela" style={{ marginTop: 8 }}>
              <tbody>{hist.data.slice(0, 50).map((h) => <tr key={h.chave}><td style={{ whiteSpace: 'nowrap' }}>{dataHora(h.criadoEm)}</td><td>{h.para}</td><td>{h.assunto}</td></tr>)}</tbody>
            </table>
          </details>
        )}
      </div>
    </div>
  );
}

interface CfgImpressao { etiquetaLarguraMm: number; etiquetaAlturaMm: number; etiquetaColunas: number; etiquetaMostrarPreco: boolean; etiquetaMostrarRef: boolean; etiquetaTexto: string; rodapePedido: string }

function Impressao() {
  const { v, setV, salvar, carregando } = useConfig<CfgImpressao>('impressao');
  if (carregando || !v) return <Carregando />;
  return (
    <div className="cartao form">
      <div className="secao">Etiquetas e impressos</div>
      <Campo rotulo="Largura da etiqueta (mm)"><input type="number" min={15} max={120} value={v.etiquetaLarguraMm} onChange={(e) => setV({ ...v, etiquetaLarguraMm: Number(e.target.value) })} /></Campo>
      <Campo rotulo="Altura da etiqueta (mm)"><input type="number" min={8} max={80} value={v.etiquetaAlturaMm} onChange={(e) => setV({ ...v, etiquetaAlturaMm: Number(e.target.value) })} /></Campo>
      <Campo rotulo="Etiquetas por linha" ajuda="Colunas do rolo"><select value={v.etiquetaColunas} onChange={(e) => setV({ ...v, etiquetaColunas: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></Campo>
      <Campo rotulo="Texto no topo"><input maxLength={30} value={v.etiquetaTexto} onChange={(e) => setV({ ...v, etiquetaTexto: e.target.value })} /></Campo>
      <label className="check"><input type="checkbox" checked={v.etiquetaMostrarPreco} onChange={(e) => setV({ ...v, etiquetaMostrarPreco: e.target.checked })} /> Mostrar o preço</label>
      <label className="check"><input type="checkbox" checked={v.etiquetaMostrarRef} onChange={(e) => setV({ ...v, etiquetaMostrarRef: e.target.checked })} /> Mostrar a referência</label>
      <Campo rotulo="Rodapé do pedido da maleta e do recibo" className="l2"><input maxLength={500} value={v.rodapePedido} onChange={(e) => setV({ ...v, rodapePedido: e.target.value })} placeholder="Ex.: trocas em até 7 dias com a etiqueta" /></Campo>
      <Salvar s={salvar} valor={v} />
    </div>
  );
}

function OutrasRegras() {
  const g = useConfig<{ prazoDias: number }>('regras_garantia');
  const c = useConfig<{ lojaPadraoPb: number; redeLiderPb: number; diaPagamento: number }>('regras_comissao');
  const [txt, setTxt] = useState({ loja: '', rede: '' });
  useEffect(() => { if (c.v) setTxt({ loja: pctTexto(c.v.lojaPadraoPb), rede: pctTexto(c.v.redeLiderPb) }); }, [c.v?.lojaPadraoPb, c.v?.redeLiderPb]);
  if (!g.v || !c.v) return <Carregando />;
  return (
    <>
      <div className="cartao form">
        <div className="secao">Garantia</div>
        <Campo rotulo="Prazo da garantia (dias)" ajuda="O Código de Defesa do Consumidor dá no mínimo 90 dias para produto durável"><input type="number" min={0} value={g.v.prazoDias} onChange={(e) => g.setV({ prazoDias: Number(e.target.value) })} /></Campo>
        <Salvar s={g.salvar} valor={g.v} />
      </div>
      <div className="cartao form">
        <div className="secao">Comissões</div>
        <Campo rotulo="Vendedora da loja e eventos (%)" ajuda="Padrão; dá para mudar por pessoa em Comissões"><input inputMode="decimal" value={txt.loja} onChange={(e) => setTxt({ ...txt, loja: e.target.value })} /></Campo>
        <Campo rotulo="Líder sobre a rede (%)" ajuda="Sobre o vendido pelas representantes dela. 0 = desligado"><input inputMode="decimal" value={txt.rede} onChange={(e) => setTxt({ ...txt, rede: e.target.value })} /></Campo>
        <Campo rotulo="Dia do pagamento" ajuda="No mês seguinte"><input type="number" min={1} max={28} value={c.v.diaPagamento} onChange={(e) => c.setV({ ...c.v!, diaPagamento: Number(e.target.value) })} /></Campo>
        <Salvar s={c.salvar} valor={{ ...c.v, lojaPadraoPb: pbDe(txt.loja), redeLiderPb: pbDe(txt.rede) }} />
      </div>
    </>
  );
}
