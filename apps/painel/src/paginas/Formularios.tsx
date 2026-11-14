import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../api';
import { dataHora } from '../formato';
import { Campo, Carregando, Erro, Indicador, Topo } from '../componentes/ui';

interface CampoForm { id: string; tipo: string; rotulo: string; obrigatorio: boolean; opcoes?: string[]; ajuda?: string | null; papel?: string | null }
interface Form { id?: string; slug?: string; titulo: string; descricao: string | null; campos: CampoForm[]; acao: string; mensagemFinal: string | null; consentimento: string | null; ativo?: boolean }

const TIPOS: [string, string][] = [['texto', 'Texto curto'], ['texto_longo', 'Texto longo'], ['telefone', 'Telefone'], ['email', 'E-mail'], ['cpf', 'CPF'], ['numero', 'Número'], ['data', 'Data'], ['escolha', 'Escolha uma opção'], ['multipla', 'Várias opções'], ['nota', 'Nota de 0 a 10']];
const PAPEIS: [string, string][] = [['', '—'], ['nome', 'Nome'], ['telefone', 'Telefone'], ['email', 'E-mail'], ['cpf', 'CPF'], ['cidade', 'Cidade'], ['uf', 'Estado (UF)']];
const ACOES: Record<string, string> = { nenhuma: 'Só guardar as respostas', cliente: 'Cadastrar ou atualizar cliente', candidata: 'Abrir candidatura a revendedora' };
const linkPublico = (slug: string) => `${window.location.origin}/f/${slug}`;
const copiar = async (t: string) => { try { await navigator.clipboard.writeText(t); } catch { window.prompt('Copie:', t); } };

export function Formularios() {
  const [aberto, setAberto] = useState<{ modo: 'editar' | 'respostas'; id: string | null; base?: Form } | null>(null);
  const q = useQuery({ queryKey: ['formularios'], queryFn: () => api<any[]>('/formularios') });
  const modelos = useQuery({ queryKey: ['formularios-modelos'], queryFn: () => api<any[]>('/formularios/modelos') });
  if (aberto?.modo === 'editar') return <Editor id={aberto.id} base={aberto.base} voltar={() => setAberto(null)} />;
  if (aberto?.modo === 'respostas' && aberto.id) return <Respostas id={aberto.id} voltar={() => setAberto(null)} />;
  return (
    <>
      <Topo eb="Formulários" titulo="Pesquisas, cadastros e inscrições" sub="Monte o formulário, mande o link e acompanhe as respostas" />
      {pode('formularios', 'criar') && (
        <div className="cartao" style={{ marginBottom: 14 }}>
          <div className="secao" style={{ marginTop: 0 }}>Começar de um modelo</div>
          <div className="flex" style={{ flexWrap: 'wrap' }}>
            {modelos.data?.map((m) => <button key={m.chave} className="botao claro" onClick={() => setAberto({ modo: 'editar', id: null, base: { titulo: m.titulo, descricao: m.descricao, campos: m.campos, acao: m.acao, mensagemFinal: m.mensagemFinal, consentimento: m.consentimento } })}>{m.titulo}</button>)}
            <button className="botao claro" onClick={() => setAberto({ modo: 'editar', id: null, base: { titulo: '', descricao: null, campos: [{ id: 'pergunta_1', tipo: 'texto', rotulo: '', obrigatorio: true }], acao: 'nenhuma', mensagemFinal: null, consentimento: null } })}>Em branco</button>
          </div>
        </div>
      )}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <table className="tabela">
          <thead><tr><th>Formulário</th><th>O que faz</th><th className="num">Respostas</th><th>Última</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {q.data!.map((f) => (
              <tr key={f.id}>
                <td><b>{f.titulo}</b><div className="muted">/f/{f.slug}</div></td>
                <td>{ACOES[f.acao]}</td>
                <td className="num">{f.respostas}</td>
                <td>{f.ultima ? dataHora(f.ultima) : '—'}</td>
                <td>{f.ativo ? <span className="etiqueta ok">No ar</span> : <span className="etiqueta neutra">Encerrado</span>}</td>
                <td>
                  <div className="flex">
                    <button className="botao claro pequeno" onClick={() => void copiar(linkPublico(f.slug))}>Copiar link</button>
                    <button className="botao claro pequeno" onClick={() => setAberto({ modo: 'respostas', id: f.id })}>Respostas</button>
                    {pode('formularios', 'editar') && <button className="botao claro pequeno" onClick={() => setAberto({ modo: 'editar', id: f.id })}>Editar</button>}
                  </div>
                </td>
              </tr>
            ))}
            {!q.data!.length && <tr><td colSpan={6} className="vazio">Nenhum formulário ainda. Comece por um modelo acima.</td></tr>}
          </tbody>
        </table>
      )}
    </>
  );
}

function Editor({ id, base, voltar }: { id: string | null; base?: Form; voltar: () => void }) {
  const qc = useQueryClient();
  const atual = useQuery({ queryKey: ['formulario', id], queryFn: () => api<Form>(`/formularios/${id}`), enabled: !!id });
  const [f, setF] = useState<Form | null>(base ?? null);
  useEffect(() => { if (atual.data) setF(atual.data); }, [atual.data]);
  const salvar = useMutation({
    mutationFn: () => {
      const corpo = { titulo: f!.titulo, descricao: f!.descricao || null, campos: f!.campos.map((c) => ({ ...c, papel: c.papel || null, ajuda: c.ajuda || null, opcoes: ['escolha', 'multipla'].includes(c.tipo) ? (c.opcoes ?? []).filter((o) => o.trim()) : undefined })), acao: f!.acao, mensagemFinal: f!.mensagemFinal || null, consentimento: f!.consentimento || null, ativo: f!.ativo ?? true, ...(f!.slug ? { slug: f!.slug } : {}) };
      return id ? api<Form>(`/formularios/${id}`, { metodo: 'PATCH', corpo }) : api<Form>('/formularios', { corpo });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['formularios'] }); voltar(); },
  });
  if (!f) return <Carregando />;
  const mudarCampo = (i: number, c: Partial<CampoForm>) => setF({ ...f, campos: f.campos.map((x, k) => (k === i ? { ...x, ...c } : x)) });
  const mover = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= f.campos.length) return;
    const cs = [...f.campos];
    [cs[i], cs[j]] = [cs[j], cs[i]];
    setF({ ...f, campos: cs });
  };
  const novoId = () => { let n = f.campos.length + 1; while (f.campos.some((c) => c.id === `pergunta_${n}`)) n++; return `pergunta_${n}`; };
  return (
    <>
      <Topo eb="Formulários" titulo={id ? 'Editar formulário' : 'Novo formulário'} acoes={<button className="botao claro" onClick={voltar}>← Voltar</button>} />
      <div className="coluna">
        <div className="cartao form">
          <Campo rotulo="Título" className="l2"><input value={f.titulo} onChange={(e) => setF({ ...f, titulo: e.target.value })} /></Campo>
          <Campo rotulo="Endereço" ajuda={f.slug ? linkPublico(f.slug) : 'Gerado pelo título'}><input value={f.slug ?? ''} placeholder="automático" onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></Campo>
          <Campo rotulo="Situação"><select value={(f.ativo ?? true) ? 's' : 'n'} onChange={(e) => setF({ ...f, ativo: e.target.value === 's' })}><option value="s">No ar</option><option value="n">Encerrado</option></select></Campo>
          <Campo rotulo="Texto de apresentação" className="l2"><input value={f.descricao ?? ''} onChange={(e) => setF({ ...f, descricao: e.target.value })} /></Campo>
          <Campo rotulo="Ao receber uma resposta" className="l2" ajuda={f.acao !== 'nenhuma' ? 'Marque uma pergunta obrigatória com o papel "Nome" e outra com "Telefone".' : undefined}>
            <select value={f.acao} onChange={(e) => setF({ ...f, acao: e.target.value })}>{Object.entries(ACOES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Campo>
          <Campo rotulo="Mensagem depois de enviar" className="l2"><input value={f.mensagemFinal ?? ''} onChange={(e) => setF({ ...f, mensagemFinal: e.target.value })} placeholder="Resposta enviada. Obrigada!" /></Campo>
          <Campo rotulo="Autorização (LGPD)" className="l2" ajuda="Se preencher, a pessoa precisa marcar para enviar. Use quando guardar contato."><input value={f.consentimento ?? ''} onChange={(e) => setF({ ...f, consentimento: e.target.value })} /></Campo>
        </div>
        {f.campos.map((c, i) => (
          <div key={i} className="cartao form">
            <div className="secao flex entre" style={{ gridColumn: 'span 4', marginTop: 0 }}>
              <span>Pergunta {i + 1}</span>
              <span className="flex">
                <button className="botao claro pequeno" disabled={i === 0} onClick={() => mover(i, -1)}>↑</button>
                <button className="botao claro pequeno" disabled={i === f.campos.length - 1} onClick={() => mover(i, 1)}>↓</button>
                <button className="botao claro pequeno" disabled={f.campos.length === 1} onClick={() => setF({ ...f, campos: f.campos.filter((_, k) => k !== i) })}>Remover</button>
              </span>
            </div>
            <Campo rotulo="Pergunta" className="l2"><input value={c.rotulo} onChange={(e) => mudarCampo(i, { rotulo: e.target.value })} /></Campo>
            <Campo rotulo="Tipo de resposta"><select value={c.tipo} onChange={(e) => mudarCampo(i, { tipo: e.target.value, opcoes: ['escolha', 'multipla'].includes(e.target.value) ? c.opcoes ?? ['', ''] : undefined })}>{TIPOS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
            <Campo rotulo="Papel no cadastro"><select value={c.papel ?? ''} onChange={(e) => mudarCampo(i, { papel: e.target.value || null })}>{PAPEIS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
            {['escolha', 'multipla'].includes(c.tipo) && (
              <Campo rotulo="Opções (uma por linha)" className="l2"><textarea rows={4} value={(c.opcoes ?? []).join('\n')} onChange={(e) => mudarCampo(i, { opcoes: e.target.value.split('\n') })} /></Campo>
            )}
            <Campo rotulo="Ajuda abaixo da pergunta" className="l2"><input value={c.ajuda ?? ''} onChange={(e) => mudarCampo(i, { ajuda: e.target.value })} /></Campo>
            <label className="check"><input type="checkbox" checked={c.obrigatorio} onChange={(e) => mudarCampo(i, { obrigatorio: e.target.checked })} /> Obrigatória</label>
          </div>
        ))}
        <div className="flex">
          <button className="botao claro" onClick={() => setF({ ...f, campos: [...f.campos, { id: novoId(), tipo: 'texto', rotulo: '', obrigatorio: false }] })}>+ Pergunta</button>
          <button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Salvar formulário</button>
        </div>
        {salvar.error && <Erro erro={salvar.error} />}
      </div>
    </>
  );
}

function Respostas({ id, voltar }: { id: string; voltar: () => void }) {
  const q = useQuery({ queryKey: ['formulario-respostas', id], queryFn: () => api<any>(`/formularios/${id}/respostas`) });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const { formulario: f, total, resumo, linhas } = q.data;
  const fmt = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v));
  const exportar = () => {
    const cab = ['Data', ...f.campos.map((c: CampoForm) => c.rotulo), 'Origem'];
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const csv = [cab, ...linhas.map((l: any) => [dataHora(l.criadoEm), ...f.campos.map((c: CampoForm) => fmt(l.respostas[c.id])), fmt(l.origem?.utm_campaign)])].map((r) => r.map((x: string) => esc(String(x))).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${f.slug}.csv`;
    a.click();
  };
  return (
    <>
      <Topo eb="Formulários" titulo={f.titulo} sub={`${total} resposta(s) · ${linkPublico(f.slug)}`} acoes={<><button className="botao claro" onClick={voltar}>← Voltar</button>{pode('formularios', 'exportar') && <button className="botao claro" disabled={!total} onClick={exportar}>Baixar planilha (CSV)</button>}</>} />
      <div className="grade g3" style={{ marginBottom: 14 }}>
        {resumo.map((r: any) => (
          r.tipo === 'nota' ? (
            <Indicador key={r.campo} tipo="destaque" rotulo={r.rotulo} valor={r.nps === null ? '—' : `NPS ${r.nps}`} detalhe={r.total ? `Média ${String(r.media).replace('.', ',')} · ${r.promotores} promotores · ${r.neutros} neutros · ${r.detratores} detratores` : 'Sem respostas'} />
          ) : (
            <div key={r.campo} className="cartao">
              <div className="muted" style={{ marginBottom: 6 }}>{r.rotulo}</div>
              {Object.entries(r.contagem as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([o, n]) => (
                <div key={o} style={{ marginBottom: 4 }}>
                  <div className="flex entre" style={{ fontSize: 13.5 }}><span>{o}</span><b>{n}</b></div>
                  <div style={{ height: 6, background: 'var(--creme-2)', borderRadius: 3 }}><div style={{ width: `${r.respostas ? (n / r.respostas) * 100 : 0}%`, height: '100%', background: 'var(--dourado)', borderRadius: 3 }} /></div>
                </div>
              ))}
            </div>
          )
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tabela">
          <thead><tr><th>Quando</th>{f.campos.map((c: CampoForm) => <th key={c.id}>{c.rotulo}</th>)}<th>Origem</th></tr></thead>
          <tbody>
            {linhas.map((l: any) => <tr key={l.id}><td style={{ whiteSpace: 'nowrap' }}>{dataHora(l.criadoEm)}</td>{f.campos.map((c: CampoForm) => <td key={c.id}>{fmt(l.respostas[c.id])}</td>)}<td className="muted">{fmt(l.origem?.utm_campaign) || 'direto'}</td></tr>)}
            {!linhas.length && <tr><td colSpan={f.campos.length + 2} className="vazio">Nenhuma resposta ainda. Copie o link e divulgue.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
