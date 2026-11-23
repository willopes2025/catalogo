import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { readSheet } from 'read-excel-file/browser';
import { calcularPreco, metalDoTexto, type Metal, type RegrasPrecificacao } from '@aritana/regras';
import { api, pode } from '../api';
import { centavosParaTexto, paraCentavos, pct, reais } from '../formato';
import { Campo, Carregando, Erro, Topo } from '../componentes/ui';
import './financeiro/financeiro.css';
import './precificacao.css';

interface Linha {
  id: string; codigoBarras: string; referencia: string; descricao: string; cor: string | null; tipoBanho: string | null; categoria?: string | null; estoque?: number; emMaletas?: number;
  peso: number; bruto: number; insumos: number | null; metal: Metal | null; coeficiente: number | null; custo: number; preco: number;
}
/** O que foi digitado na linha e ainda não foi gravado (texto, como está no campo). */
interface Edicao { peso?: string; bruto?: string; insumos?: string; coeficiente?: string; metal?: Metal; preco?: string }

const numero = (t?: string) => (t?.trim() ? Number(t.replace(/\./g, '').replace(',', '.')) : NaN);
const texto = (n: number, casas = 2) => n.toLocaleString('pt-BR', { maximumFractionDigits: casas });
const vezes = (m: number) => `×${texto(m / 100)}`;

/** Junta o cadastro com o que foi digitado e faz a conta da planilha. */
function conta(l: Linha, e: Edicao | undefined, regras: RegrasPrecificacao) {
  const peso = e?.peso !== undefined ? numero(e.peso) || 0 : l.peso;
  const bruto = e?.bruto !== undefined ? paraCentavos(e.bruto || '0') : l.bruto;
  const metal = e?.metal ?? l.metal;
  const trocouMetal = !!e?.metal && e.metal !== l.metal;
  const coefDigitado = e?.coeficiente !== undefined && e.coeficiente.trim() ? Math.round(numero(e.coeficiente) * 100) : null;
  const coeficiente = coefDigitado ?? (trocouMetal ? null : l.coeficiente);
  const insumos = e?.insumos !== undefined ? (e.insumos.trim() ? paraCentavos(e.insumos) : null) : l.insumos;
  const calculo = metal && peso > 0 ? calcularPreco({ peso, bruto, metal, coeficiente, insumos }, regras) : null;
  const novoPreco = e?.preco?.trim() ? paraCentavos(e.preco) : null;
  return { peso, bruto, metal, coeficiente, insumos, calculo, novoPreco };
}

/** Precificação: a planilha de preços dentro do sistema (peso × coeficiente + custo bruto, markup e ajuste final). */
export function Precificacao() {
  const qc = useQueryClient();
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState({ busca: '', categoriaId: '', situacao: '' });
  const [pagina, setPagina] = useState(1);
  const [edicoes, setEdicoes] = useState<Record<string, Edicao>>({});
  const [planilha, setPlanilha] = useState<{ nome: string; itens: Linha[]; naoAchados: string[] } | null>(null);
  const [regrasAbertas, setRegrasAbertas] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const arquivo = useRef<HTMLInputElement>(null);
  const editavel = pode('produtos', 'editar');
  const cats = useQuery({ queryKey: ['categorias'], queryFn: () => api<{ id: string; caminho: string }[]>('/produtos/categorias') });
  const params = new URLSearchParams({ pagina: String(pagina), ...Object.fromEntries(Object.entries(filtro).filter(([, v]) => v)) });
  const q = useQuery({ queryKey: ['precificacao', params.toString()], queryFn: () => api<{ itens: Linha[]; total: number; porPagina: number; regras: RegrasPrecificacao }>(`/precificacao?${params}`), placeholderData: (a) => a });
  const regras = q.data?.regras;
  const itens = planilha?.itens ?? q.data?.itens ?? [];
  const porId = useMemo(() => new Map(itens.map((l) => [l.id, l])), [itens]);
  const mudar = (id: string, campo: keyof Edicao, valor: string) =>
    setEdicoes((a) => {
      const e = { ...(a[id] ?? {}), [campo]: valor } as Edicao;
      const l = porId.get(id);
      // Voltou ao que já estava no cadastro: não conta como alteração.
      if (l && campo === 'metal' && valor === (l.metal ?? '')) delete e.metal;
      if (campo === 'preco' && !valor.trim()) delete e.preco;
      const n = { ...a };
      if (Object.keys(e).length) n[id] = e; else delete n[id];
      return n;
    });
  const alteradas = Object.keys(edicoes);

  const aplicar = useMutation({
    mutationFn: async () => {
      if (!regras) return { pecas: 0, precos: 0 };
      const corpo = Object.entries(edicoes).map(([id, e]) => {
        const i: Record<string, unknown> = { id };
        if (e.peso !== undefined) i.peso = numero(e.peso) || 0;
        if (e.bruto !== undefined) i.bruto = paraCentavos(e.bruto || '0');
        if (e.insumos !== undefined && e.insumos.trim()) i.insumos = paraCentavos(e.insumos);
        if (e.metal) i.metal = e.metal;
        if (e.coeficiente?.trim()) i.coeficiente = Math.round(numero(e.coeficiente) * 100);
        if (e.preco?.trim()) i.preco = paraCentavos(e.preco);
        return i;
      });
      let pecas = 0, precos = 0;
      for (let i = 0; i < corpo.length; i += 400) {
        const r = await api<{ pecas: number; precosAlterados: number }>('/precificacao/aplicar', { corpo: { itens: corpo.slice(i, i + 400) } });
        pecas += r.pecas; precos += r.precosAlterados;
      }
      return { pecas, precos };
    },
    onSuccess: (r) => {
      setEdicoes({}); setPlanilha(null);
      setAviso(`${r.pecas} peça(s) gravada(s), ${r.precos} com preço novo.`);
      qc.invalidateQueries({ queryKey: ['precificacao'] }); qc.invalidateQueries({ queryKey: ['produtos'] }); qc.invalidateQueries({ queryKey: ['produto'] });
    },
  });

  /** Põe o preço sugerido (já arredondado) em todas as peças da tela que têm conta e ainda estão sem novo preço. */
  const usarSugeridos = () => {
    if (!regras) return;
    setEdicoes((a) => {
      const n = { ...a };
      for (const l of itens) {
        const c = conta(l, n[l.id], regras);
        if (c.calculo && !n[l.id]?.preco?.trim() && c.calculo.arredondado !== l.preco) n[l.id] = { ...(n[l.id] ?? {}), preco: centavosParaTexto(c.calculo.arredondado) };
      }
      return n;
    });
  };

  const importar = useMutation({
    mutationFn: async (f: File) => {
      const linhas = (await readSheet(f)) as unknown[][];
      const chave = (c: unknown) => String(c ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const iCab = linhas.findIndex((l) => l.some((c) => chave(c) === 'codigo de barras'));
      if (iCab < 0) throw new Error('Não achei a coluna "Código de Barras" na planilha.');
      const cab = linhas[iCab].map(chave);
      const col = (...nomes: string[]) => cab.findIndex((c) => nomes.includes(c));
      const c = { codigo: col('codigo de barras'), ref: col('referencia'), peso: col('peso'), cor: col('cor'), bruto: col('custo compra bruto', 'custo bruto'), insumos: col('custo insumos', 'insumos'), ouro: col('custo banho ouro'), prata: col('custo banho prata'), novo: col('novo preco') };
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && !Number.isNaN(Number(v.replace(',', '.'))) ? Number(v.replace(',', '.')) : null);
      const dados = linhas.slice(iCab + 1).map((l) => ({ codigo: String(l[c.codigo] ?? '').trim(), ref: String(l[c.ref] ?? '').trim(), peso: num(l[c.peso]), cor: String(l[c.cor] ?? ''), bruto: num(l[c.bruto]), insumos: num(l[c.insumos]), ouro: num(l[c.ouro]), prata: num(l[c.prata]), novo: num(l[c.novo]) })).filter((d) => d.codigo || d.ref);
      if (!dados.length) throw new Error('A planilha não tem linhas com código.');
      const codigos = [...new Set(dados.flatMap((d) => [d.codigo, d.ref]).filter(Boolean))];
      const r = await api<{ itens: Record<string, Linha> }>('/precificacao/buscar', { corpo: { codigos } });
      const achadas = new Map<string, Linha>();
      const ed: Record<string, Edicao> = {};
      const naoAchados: string[] = [];
      for (const d of dados) {
        const l = r.itens[d.codigo] ?? r.itens[d.ref];
        if (!l) { naoAchados.push(d.codigo || d.ref); continue; }
        if (achadas.has(l.id)) continue;
        const e: Edicao = {};
        if (d.peso !== null && d.peso > 0 && d.peso !== l.peso) e.peso = texto(d.peso, 3);
        if (d.bruto !== null && d.bruto > 0 && Math.round(d.bruto * 100) !== l.bruto) e.bruto = centavosParaTexto(Math.round(d.bruto * 100));
        if (d.insumos !== null && Math.round(d.insumos * 100) !== (l.insumos ?? regras?.insumos ?? -1)) e.insumos = centavosParaTexto(Math.round(d.insumos * 100));
        // Metal: a coluna Cor manda; sem ela, vale a coluna de banho que veio preenchida sozinha.
        const metal = metalDoTexto(d.cor) ?? (d.ouro !== null && d.prata === null ? 'ouro' : d.prata !== null && d.ouro === null ? 'prata' : null);
        if (metal && metal !== l.metal) e.metal = metal;
        // Coeficiente da linha, quando a planilha usou um diferente do que o sistema usaria.
        const m = metal ?? l.metal;
        const banho = m === 'ouro' ? d.ouro : m === 'prata' ? d.prata : null;
        if (m && banho !== null && d.peso && d.peso > 0) {
          const coef = Math.round((banho / d.peso) * 100) / 100;
          if (Math.round(coef * 100) !== (l.coeficiente ?? regras?.[m].coeficiente)) e.coeficiente = texto(coef);
        }
        if (d.novo !== null && d.novo > 0 && Math.round(d.novo * 100) !== l.preco) e.preco = centavosParaTexto(Math.round(d.novo * 100));
        achadas.set(l.id, l);
        if (Object.keys(e).length) ed[l.id] = e;
      }
      return { nome: f.name, itens: [...achadas.values()].sort((a, b) => Number(!!ed[b.id]) - Number(!!ed[a.id]) || a.descricao.localeCompare(b.descricao)), naoAchados, ed };
    },
    onSuccess: (r) => { setPlanilha({ nome: r.nome, itens: r.itens, naoAchados: r.naoAchados }); setEdicoes(r.ed); setAviso(null); },
  });

  const exportar = () => {
    if (!regras) return;
    const cab = ['Código de Barras', 'Referência', 'Descrição', 'Metal', 'Peso', 'Custo Compra Bruto', 'Coeficiente', 'Custo Banho', 'Custo Insumos', 'Markup', 'Preço Atual', 'Preço Sugerido', 'Novo Preço'];
    const r$ = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
    const linhas = itens.map((l) => {
      const c = conta(l, edicoes[l.id], regras);
      return [l.codigoBarras, l.referencia, l.descricao, c.metal ?? '', c.peso ? texto(c.peso, 3) : '', r$(c.bruto), c.calculo ? r$(c.calculo.coeficiente) : '', r$(c.calculo?.banho), r$(c.calculo?.insumos ?? c.insumos), c.calculo ? texto(c.calculo.multiplicador / 100) : '', r$(l.preco), r$(c.calculo?.arredondado), r$(c.novoPreco)];
    });
    const csv = [cab, ...linhas].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'precificacao.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const trocarLista = (f: () => void) => {
    if (alteradas.length && !window.confirm(`Há ${alteradas.length} peça(s) alterada(s) e não gravada(s). Descartar?`)) return;
    setEdicoes({}); setPlanilha(null); f();
  };

  return (
    <>
      <Topo
        eb={<Link to="/produtos">Produtos</Link>}
        titulo="Precificação"
        sub="Peso × coeficiente do metal + custo bruto, vezes o markup, mais insumos. O sugerido é o ponto de partida; o novo preço é seu."
        acoes={<>
          <button className="botao claro" onClick={() => setRegrasAbertas(true)} disabled={!regras}>Regras</button>
          {editavel && <button className="botao claro" onClick={() => arquivo.current?.click()} disabled={importar.isPending}>{importar.isPending ? 'Lendo…' : 'Importar planilha'}</button>}
          <button className="botao claro" onClick={exportar} disabled={!itens.length}>Exportar</button>
        </>}
      />
      <input ref={arquivo} type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) trocarLista(() => importar.mutate(f)); }} />
      {importar.error && <Erro erro={importar.error} />}
      {aviso && <div className="aviso ok" style={{ marginBottom: 12 }}>{aviso}</div>}
      {planilha ? (
        <div className="aviso alerta" style={{ marginBottom: 12 }}>
          <b>{planilha.nome}</b>: {planilha.itens.length} peça(s) encontrada(s) no cadastro, {Object.keys(edicoes).length} com diferença para gravar
          {planilha.naoAchados.length > 0 && <>, {planilha.naoAchados.length} não encontrada(s) <span title={planilha.naoAchados.slice(0, 200).join(', ')} style={{ textDecoration: 'underline dotted', cursor: 'help' }}>(ver códigos)</span></>}.
          {' '}Confira e clique em "Gravar". <button className="botao claro pequeno" onClick={() => trocarLista(() => undefined)}>Fechar planilha</button>
        </div>
      ) : (
        <form className="busca" onSubmit={(e) => { e.preventDefault(); trocarLista(() => { setPagina(1); setFiltro({ ...filtro, busca }); }); }}>
          <input placeholder="Descrição, referência ou código de barras" value={busca} onChange={(e) => setBusca(e.target.value)} />
          <select value={filtro.categoriaId} aria-label="Categoria" onChange={(e) => trocarLista(() => { setPagina(1); setFiltro({ ...filtro, categoriaId: e.target.value }); })}>
            <option value="">Todas as categorias</option>
            {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.caminho}</option>)}
          </select>
          <select value={filtro.situacao} aria-label="Situação" onChange={(e) => trocarLista(() => { setPagina(1); setFiltro({ ...filtro, situacao: e.target.value }); })}>
            <option value="">Todas as peças</option>
            <option value="com_estoque">Só com estoque</option>
            <option value="com_peso">Com peso informado</option>
            <option value="sem_peso">Sem peso</option>
          </select>
          <button className="botao claro">Buscar</button>
        </form>
      )}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : regras && (
        <>
          <div className="preco-rolagem">
            <table className="tabela preco-tabela">
              <thead>
                <tr>
                  <th>Peça</th><th>Metal</th><th className="num">Peso (g)</th><th className="num">Bruto</th><th className="num" title="Reais por grama de peça">Coef.</th><th className="num">Banho</th><th className="num">Custo total</th><th className="num">Markup</th><th className="num">Insumos</th>
                  <th className="num">Sugerido</th><th className="num">Preço atual</th><th className="num">Novo preço</th><th className="num" title="Sobre o novo preço (ou o atual)">Margem</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((l) => {
                  const e = edicoes[l.id];
                  const c = conta(l, e, regras);
                  const final = c.novoPreco ?? l.preco;
                  const custoTotal = c.calculo ? c.calculo.custoTotal + c.calculo.insumos : l.custo;
                  const campo = (k: 'peso' | 'bruto' | 'coeficiente' | 'insumos' | 'preco', atual: string, dica?: string) => (
                    <input className={e?.[k] !== undefined ? 'mudou' : ''} inputMode="decimal" disabled={!editavel} value={e?.[k] ?? atual} placeholder={dica} onChange={(ev) => mudar(l.id, k, ev.target.value)} aria-label={k} />
                  );
                  return (
                    <tr key={l.id} className={e ? 'alterada' : ''}>
                      <td className="peca"><Link to={`/produtos/${l.id}`} target="_blank"><b>{l.descricao}</b></Link><span className="muted">{l.codigoBarras} · {l.referencia}{l.estoque !== undefined ? ` · estoque ${l.estoque}${l.emMaletas ? ` + ${l.emMaletas} em maletas` : ''}` : ''}</span></td>
                      <td>
                        <select className={e?.metal ? 'mudou' : ''} disabled={!editavel} value={c.metal ?? ''} onChange={(ev) => mudar(l.id, 'metal', ev.target.value)} aria-label="Metal">
                          {!l.metal && <option value="">—</option>}
                          <option value="ouro">Ouro</option>
                          <option value="prata">Prata</option>
                        </select>
                      </td>
                      <td className="num">{campo('peso', l.peso ? texto(l.peso, 3) : '')}</td>
                      <td className="num">{campo('bruto', l.bruto ? centavosParaTexto(l.bruto) : '')}</td>
                      <td className="num">{campo('coeficiente', l.coeficiente != null && !(e?.metal && e.metal !== l.metal) ? texto(l.coeficiente / 100) : '', c.metal ? texto(regras[c.metal].coeficiente / 100) : undefined)}</td>
                      <td className="num">{c.calculo ? reais(c.calculo.banho) : '—'}</td>
                      <td className="num">{c.calculo ? reais(c.calculo.custoTotal) : '—'}</td>
                      <td className="num">{c.calculo ? vezes(c.calculo.multiplicador) : '—'}</td>
                      <td className="num">{campo('insumos', l.insumos != null ? centavosParaTexto(l.insumos) : '', centavosParaTexto(regras.insumos))}</td>
                      <td className="num">
                        {c.calculo ? (
                          <button type="button" className="sugerido" disabled={!editavel} title={`Fórmula: ${reais(c.calculo.sugerido)}. Clique para usar como novo preço.`} onClick={() => mudar(l.id, 'preco', centavosParaTexto(c.calculo!.arredondado))}>{reais(c.calculo.arredondado)}</button>
                        ) : <span className="muted" title={!c.metal ? 'Escolha o metal' : 'Informe o peso'}>{!c.metal ? 'sem metal' : 'sem peso'}</span>}
                      </td>
                      <td className="num">{reais(l.preco)}</td>
                      <td className="num">{campo('preco', '', '—')}</td>
                      <td className="num">{final > 0 && custoTotal > 0 ? pct(Math.round(((final - custoTotal) * 10000) / final)) : '—'}</td>
                    </tr>
                  );
                })}
                {!itens.length && <tr><td colSpan={13} className="vazio">Nenhuma peça por aqui.</td></tr>}
              </tbody>
            </table>
          </div>
          {!planilha && q.data && q.data.total > q.data.porPagina && (
            <div className="flex" style={{ marginTop: 10 }}>
              <button className="botao claro pequeno" disabled={pagina === 1} onClick={() => trocarLista(() => setPagina(pagina - 1))}>Anterior</button>
              <span className="muted">Página {pagina} de {Math.ceil(q.data.total / q.data.porPagina)} · {q.data.total} peças</span>
              <button className="botao claro pequeno" disabled={pagina * q.data.porPagina >= q.data.total} onClick={() => trocarLista(() => setPagina(pagina + 1))}>Próxima</button>
            </div>
          )}
          {editavel && (
            <div className="preco-barra">
              <span>{alteradas.length ? <><b>{alteradas.length}</b> peça(s) alterada(s), {Object.values(edicoes).filter((e) => e.preco?.trim()).length} com novo preço</> : <span className="muted">Edite os campos ou clique no sugerido para usá-lo como novo preço.</span>}</span>
              <span className="flex">
                <button className="botao claro" onClick={usarSugeridos}>Usar o sugerido em todas</button>
                <button className="botao claro" disabled={!alteradas.length} onClick={() => setEdicoes({})}>Descartar</button>
                <button className="botao" disabled={!alteradas.length || aplicar.isPending} onClick={() => aplicar.mutate()}>{aplicar.isPending ? 'Gravando…' : 'Gravar'}</button>
              </span>
              {aplicar.error && <Erro erro={aplicar.error} />}
            </div>
          )}
        </>
      )}
      {regrasAbertas && regras && <Regras regras={regras} fechar={() => setRegrasAbertas(false)} />}
    </>
  );
}

/** Regras da fórmula: coeficiente de cada metal, markup por faixa de custo, insumos e terminação do preço. */
function Regras({ regras, fechar }: { regras: RegrasPrecificacao; fechar: () => void }) {
  const qc = useQueryClient();
  const editavel = pode('configuracoes', 'editar');
  type Faixa = { ate: string; mult: string };
  const inicial = (m: Metal) => ({ coef: texto(regras[m].coeficiente / 100), faixas: [...regras[m].faixas].sort((a, b) => (a.ate ?? Infinity) - (b.ate ?? Infinity)).map((f): Faixa => ({ ate: f.ate === null ? '' : centavosParaTexto(f.ate), mult: texto(f.multiplicador / 100) })) });
  const [f, setF] = useState({ ouro: inicial('ouro'), prata: inicial('prata'), insumos: centavosParaTexto(regras.insumos), terminacao: regras.terminacao === null ? '' : String(regras.terminacao).padStart(2, '0') });
  const salvar = useMutation({
    mutationFn: () => {
      const metal = (m: Metal) => ({ coeficiente: Math.round(numero(f[m].coef) * 100) || 0, faixas: f[m].faixas.map((x) => ({ ate: x.ate.trim() ? paraCentavos(x.ate) : null, multiplicador: Math.round(numero(x.mult) * 100) || 0 })) });
      return api('/configuracoes/chave/precificacao', { metodo: 'PUT', corpo: { ouro: metal('ouro'), prata: metal('prata'), insumos: paraCentavos(f.insumos || '0'), terminacao: f.terminacao.trim() ? Number(f.terminacao) : null } });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['precificacao'] }); fechar(); },
  });
  const bloco = (m: Metal, nome: string) => (
    <div className="cartao" style={{ flex: 1, minWidth: 260 }}>
      <b>{nome}</b>
      <Campo rotulo="Coeficiente (R$ por grama)" ajuda="Multiplicado pelo peso da peça para dar o custo do banho."><input inputMode="decimal" disabled={!editavel} value={f[m].coef} onChange={(e) => setF({ ...f, [m]: { ...f[m], coef: e.target.value } })} /></Campo>
      <div className="muted" style={{ fontSize: 12, margin: '8px 0 4px' }}>Markup por custo total (bruto + banho)</div>
      {f[m].faixas.map((x, i) => (
        <div key={i} className="flex" style={{ gap: 6, marginBottom: 6 }}>
          <span className="muted" style={{ width: 28 }}>{x.ate.trim() || i < f[m].faixas.length - 1 ? 'até' : 'acima'}</span>
          <input style={{ width: 90 }} inputMode="decimal" disabled={!editavel || i === f[m].faixas.length - 1} placeholder={i === f[m].faixas.length - 1 ? 'sem limite' : 'R$'} value={i === f[m].faixas.length - 1 ? '' : x.ate} onChange={(e) => setF({ ...f, [m]: { ...f[m], faixas: f[m].faixas.map((y, j) => (j === i ? { ...y, ate: e.target.value } : y)) } })} aria-label="Até" />
          <span className="muted">×</span>
          <input style={{ width: 70 }} inputMode="decimal" disabled={!editavel} value={x.mult} onChange={(e) => setF({ ...f, [m]: { ...f[m], faixas: f[m].faixas.map((y, j) => (j === i ? { ...y, mult: e.target.value } : y)) } })} aria-label="Multiplicador" />
          {editavel && i < f[m].faixas.length - 1 && <button type="button" className="botao claro pequeno" onClick={() => setF({ ...f, [m]: { ...f[m], faixas: f[m].faixas.filter((_, j) => j !== i) } })}>Tirar</button>}
        </div>
      ))}
      {editavel && f[m].faixas.length < 8 && <button type="button" className="botao claro pequeno" onClick={() => setF({ ...f, [m]: { ...f[m], faixas: [{ ate: '', mult: f[m].faixas[0]?.mult ?? '7' }, ...f[m].faixas] } })}>+ Faixa</button>}
    </div>
  );
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 6px' }}>Regras da precificação</h3>
        <p className="muted" style={{ marginTop: 0 }}>Preço sugerido = (custo bruto + peso × coeficiente) × markup + insumos. Peça que já foi precificada guarda o coeficiente dela; estas regras valem para as demais.</p>
        <div className="flex" style={{ alignItems: 'stretch', flexWrap: 'wrap', gap: 12 }}>{bloco('ouro', 'Banho de ouro')}{bloco('prata', 'Banho de prata')}</div>
        <div className="form" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 12 }}>
          <Campo rotulo="Insumos por peça (R$)" ajuda="Embalagem, tag e afins. Somado depois do markup."><input inputMode="decimal" disabled={!editavel} value={f.insumos} onChange={(e) => setF({ ...f, insumos: e.target.value })} /></Campo>
          <Campo rotulo="Terminação do preço (centavos)" ajuda="90 faz o sugerido subir até o próximo …,90. Em branco não arredonda."><input inputMode="numeric" maxLength={2} disabled={!editavel} value={f.terminacao} onChange={(e) => setF({ ...f, terminacao: e.target.value.replace(/\D/g, '') })} /></Campo>
        </div>
        {salvar.error && <Erro erro={salvar.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          {editavel && <button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Salvando…' : 'Salvar regras'}</button>}
          <button className="botao claro" onClick={fechar}>{editavel ? 'Voltar' : 'Fechar'}</button>
        </div>
      </div>
    </div>
  );
}
