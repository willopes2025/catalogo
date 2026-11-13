import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Papa from 'papaparse';
import { readSheet } from 'read-excel-file/browser';
import { api } from '../api';
import { dataHora } from '../formato';
import { Campo, Erro } from '../componentes/ui';

type Tipo = 'produtos' | 'representante' | 'cliente' | 'fornecedor';
const NOMES: Record<Tipo, string> = { produtos: 'Produtos (com estoque)', representante: 'Representantes', cliente: 'Clientes', fornecedor: 'Fornecedores' };

/** Lê CSV ou Excel no navegador e devolve as linhas com o nome de cada coluna. */
async function lerPlanilha(arquivo: File): Promise<Record<string, unknown>[]> {
  if (/\.xlsx$/i.test(arquivo.name)) {
    const linhas = (await readSheet(arquivo)) as unknown[][];
    const [cab, ...resto] = linhas;
    return resto
      .filter((l) => l.some((c) => c !== null && c !== ''))
      .map((l) => Object.fromEntries(cab.map((c, i) => [String(c ?? `coluna${i + 1}`), l[i] instanceof Date ? (l[i] as Date).toISOString().slice(0, 10) : l[i]])));
  }
  const texto = await arquivo.text();
  const r = Papa.parse<Record<string, unknown>>(texto, { header: true, skipEmptyLines: true, delimiter: '' });
  return r.data;
}

/** Migração do Jueri e cargas futuras por planilha: primeiro simula, depois importa. */
export function Importacao() {
  const qc = useQueryClient();
  const [tipo, setTipo] = useState<Tipo>('produtos');
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [linhas, setLinhas] = useState<Record<string, unknown>[]>([]);
  const [lendo, setLendo] = useState<string | null>(null);
  const [localId, setLocalId] = useState('');
  const [simulacao, setSimulacao] = useState<any | null>(null);
  const locais = useQuery({ queryKey: ['locais'], queryFn: () => api<any[]>('/estoque/locais') });
  const historico = useQuery({ queryKey: ['importacoes'], queryFn: () => api<any[]>('/importacao/historico') });

  const enviar = useMutation({
    mutationFn: (simular: boolean) =>
      tipo === 'produtos'
        ? api<any>('/importacao/produtos', { corpo: { linhas, localId: localId || null, simular, arquivo: arquivo?.name } })
        : api<any>('/importacao/pessoas', { corpo: { tipo, linhas, simular, arquivo: arquivo?.name } }),
    onSuccess: (r, simular) => {
      if (simular) setSimulacao(r);
      else { setSimulacao({ ...r, concluida: true }); qc.invalidateQueries(); }
    },
  });

  async function escolher(f: File | null) {
    setArquivo(f);
    setSimulacao(null);
    setLinhas([]);
    if (!f) return;
    setLendo('Lendo a planilha…');
    try {
      const l = await lerPlanilha(f);
      setLinhas(l);
      setLendo(null);
    } catch {
      setLendo('Não consegui ler o arquivo. Salve como .xlsx ou .csv e tente de novo.');
    }
  }

  const colunas = linhas[0] ? Object.keys(linhas[0]) : [];
  return (
    <div className="coluna">
      <div className="cartao form">
        <div className="secao">1. O que importar</div>
        <Campo rotulo="Tipo"><select value={tipo} onChange={(e) => { setTipo(e.target.value as Tipo); setSimulacao(null); }}>{Object.entries(NOMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
        {tipo === 'produtos' && <Campo rotulo="Estoque da planilha vai para" ajuda="Vazio: só atualiza o cadastro"><select value={localId} onChange={(e) => { setLocalId(e.target.value); setSimulacao(null); }}><option value="">Não mexer no estoque</option>{locais.data?.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select></Campo>}
        <Campo rotulo="Planilha (.xlsx ou .csv)" className="l2" ajuda="Exporte do Jueri pelo botão Excel de cada lista"><input type="file" accept=".xlsx,.csv,text/csv" onChange={(e) => escolher(e.target.files?.[0] ?? null)} /></Campo>
        {lendo && <p className="l4 muted">{lendo}</p>}
        {linhas.length > 0 && <p className="l4 muted"><b>{linhas.length}</b> linhas · colunas: {colunas.join(', ')}</p>}
      </div>

      {linhas.length > 0 && (
        <div className="cartao coluna">
          <div className="secao">2. Conferir antes de gravar</div>
          <p className="muted">A simulação faz tudo sem gravar nada e mostra o que aconteceria. Reimportar a mesma planilha atualiza os cadastros, sem duplicar.</p>
          <div className="flex">
            <button className="botao claro" onClick={() => enviar.mutate(true)} disabled={enviar.isPending}>{enviar.isPending && !simulacao ? 'Simulando…' : 'Simular'}</button>
            {simulacao && !simulacao.concluida && <button className="botao" onClick={() => enviar.mutate(false)} disabled={enviar.isPending}>{enviar.isPending ? 'Importando…' : `Importar ${simulacao.criados + simulacao.atualizados} registros`}</button>}
          </div>
          {enviar.error && <Erro erro={enviar.error} />}
          {simulacao && (
            <div className={`aviso ${simulacao.erros.length ? 'alerta' : 'ok'}`}>
              {simulacao.concluida ? <b>Importação concluída. </b> : <b>Simulação: </b>}
              {simulacao.criados} novos · {simulacao.atualizados} atualizados · {simulacao.erros.length} linha(s) com problema.
              <div className="muted">Colunas reconhecidas: {simulacao.colunasReconhecidas.join(', ')}</div>
              {simulacao.avisos.length > 0 && <ul>{simulacao.avisos.map((a: string) => <li key={a}>{a}</li>)}</ul>}
              {simulacao.erros.length > 0 && <ul>{simulacao.erros.slice(0, 30).map((e: any) => <li key={e.linha}>Linha {e.linha}: {e.mensagem}</li>)}{simulacao.erros.length > 30 && <li>e mais {simulacao.erros.length - 30}…</li>}</ul>}
            </div>
          )}
        </div>
      )}

      <div className="cartao">
        <h3 style={{ marginBottom: 8 }}>Importações feitas</h3>
        {historico.data?.length ? historico.data.map((h) => <div key={h.id} className="resumo-linha"><span>{dataHora(h.criadoEm)} · {h.tipo} · {h.arquivo ?? 'sem nome'} · {h.usuario}</span><span>{h.criados} novos · {h.atualizados} atualizados · {h.erros.length} erros</span></div>) : <p className="muted">Nenhuma ainda.</p>}
      </div>
    </div>
  );
}
