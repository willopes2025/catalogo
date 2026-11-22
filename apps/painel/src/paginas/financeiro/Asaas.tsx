import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { data as dataBR, dataHora, paraCentavos, reais } from '../../formato';
import { Campo, Carregando, Erro, Indicador, camposComErro } from '../../componentes/ui';

type Tipo = 'texto' | 'numero' | 'inteiro' | 'data' | 'bool' | 'dinheiro' | 'opcao' | 'cliente' | 'json';
interface CampoAsaas { nome: string; rotulo: string; tipo: Tipo; obrigatorio?: boolean; opcoes?: [string, string][]; ajuda?: string }
interface Operacao { chave: string; grupo: string; nome: string; metodo: 'GET' | 'POST' | 'PUT' | 'DELETE'; nivel: 'ver' | 'operar' | 'dinheiro' | 'gestao'; filtros?: CampoAsaas[]; campos?: CampoAsaas[]; aviso?: string }
interface Catalogo { ligado: boolean; ambiente: string; operacoes: Operacao[] }
type Linha = Record<string, any>;
type Col = [campo: string, rotulo: string, tipo?: 'reais' | 'data' | 'dataHora' | 'situacao' | 'bool' | 'link' | 'titulo'];
interface Lista { op: string; titulo?: string; colunas: Col[]; acoes?: string[]; id?: string }
interface Secao { chave: string; nome: string; sub: string; listas: Lista[]; topo?: string[] }

const SITUACAO: Record<string, [string, string]> = {
  PENDING: ['Aguardando', 'neutra'], AWAITING_RISK_ANALYSIS: ['Em análise', 'alerta'], OVERDUE: ['Vencida', 'erro'], RECEIVED: ['Recebida', 'ok'], CONFIRMED: ['Confirmada', 'ok'], RECEIVED_IN_CASH: ['Recebida em dinheiro', 'ok'],
  REFUNDED: ['Estornada', 'neutra'], REFUND_REQUESTED: ['Estorno pedido', 'alerta'], REFUND_IN_PROGRESS: ['Estornando', 'alerta'], CHARGEBACK_REQUESTED: ['Chargeback', 'erro'], DUNNING_REQUESTED: ['Em negativação', 'alerta'],
  ACTIVE: ['Ativa', 'ok'], INACTIVE: ['Parada', 'neutra'], EXPIRED: ['Encerrada', 'neutra'], DONE: ['Concluída', 'ok'], CANCELLED: ['Cancelada', 'neutra'], CANCELED: ['Cancelada', 'neutra'], FAILED: ['Falhou', 'erro'], BANK_PROCESSING: ['No banco', 'alerta'],
  SCHEDULED: ['Agendada', 'alerta'], AUTHORIZED: ['Emitida', 'ok'], ERROR: ['Erro', 'erro'], REFUSED: ['Recusada', 'erro'], DENIED: ['Negada', 'erro'], CREDITED: ['Creditada', 'ok'], DEBITED: ['Debitada', 'neutra'], PAID: ['Paga', 'ok'],
  PROCESSED: ['Processada', 'ok'], AWAITING_APPROVAL: ['Em análise', 'alerta'], AWAITING_ACTIVATION: ['Aguardando', 'alerta'], DELETED: ['Excluída', 'neutra'], APPROVED: ['Aprovado', 'ok'], AWAITING_CREDIT: ['A creditar', 'alerta'],
};
const FORMA: Record<string, string> = { BOLETO: 'Boleto', PIX: 'Pix', CREDIT_CARD: 'Cartão', DEBIT_CARD: 'Débito', UNDEFINED: 'Cliente escolhe', TRANSFER: 'Transferência', DEPOSIT: 'Depósito' };

const COBRANCA: Col[] = [['dueDate', 'Vencimento', 'data'], ['description', 'Descrição'], ['_titulo', 'Título do sistema', 'titulo'], ['billingType', 'Forma'], ['value', 'Valor', 'reais'], ['netValue', 'Líquido', 'reais'], ['status', 'Situação', 'situacao'], ['invoiceUrl', 'Fatura', 'link']];
const ACOES_COBRANCA = ['cobrancas.ver', 'cobrancas.linha', 'cobrancas.pix', 'cobrancas.fatura', 'cobrancas.visualizacao', 'cobrancas.situacao', 'cobrancas.editar', 'cobrancas.dinheiro', 'cobrancas.desfazerDinheiro', 'cobrancas.estornar', 'cobrancas.estornos', 'cobrancas.documentos', 'cobrancas.excluir', 'cobrancas.restaurar'];

const SECOES: Secao[] = [
  { chave: 'cobrancas', nome: 'Cobranças', sub: 'Boletos, Pix e cartão emitidos pelo Asaas', topo: ['cobrancas.criar', 'cobrancas.simular', 'chargebacks'], listas: [{ op: 'cobrancas', colunas: COBRANCA, acoes: ACOES_COBRANCA }] },
  { chave: 'parcelamentos', nome: 'Parcelamentos', sub: 'Vendas divididas em várias cobranças', topo: ['parcelamentos.criar'], listas: [{ op: 'parcelamentos', colunas: [['dateCreated', 'Criado', 'data'], ['description', 'Descrição'], ['billingType', 'Forma'], ['installmentCount', 'Parcelas'], ['paymentValue', 'Cada parcela', 'reais'], ['value', 'Total', 'reais']], acoes: ['parcelamentos.ver', 'parcelamentos.parcelas', 'parcelamentos.cancelarAbertas', 'parcelamentos.estornar', 'parcelamentos.excluir'] }] },
  { chave: 'assinaturas', nome: 'Assinaturas', sub: 'Cobranças que se repetem sozinhas', topo: ['assinaturas.criar'], listas: [{ op: 'assinaturas', colunas: [['nextDueDate', 'Próxima', 'data'], ['description', 'Descrição'], ['cycle', 'Repete'], ['billingType', 'Forma'], ['value', 'Valor', 'reais'], ['status', 'Situação', 'situacao']], acoes: ['assinaturas.ver', 'assinaturas.cobrancas', 'assinaturas.notas', 'assinaturas.editar', 'assinaturas.excluir'] }] },
  { chave: 'links', nome: 'Links de pagamento', sub: 'Um endereço para vários clientes pagarem', topo: ['links.criar'], listas: [{ op: 'links', colunas: [['name', 'Nome'], ['chargeType', 'Tipo'], ['billingType', 'Forma'], ['value', 'Valor', 'reais'], ['active', 'Ativo', 'bool'], ['url', 'Link', 'link']], acoes: ['links.ver', 'links.editar', 'links.excluir', 'links.restaurar'] }] },
  { chave: 'clientes', nome: 'Clientes', sub: 'Cadastro que o Asaas usa nas cobranças e nos avisos', topo: ['clientes.criar'], listas: [{ op: 'clientes', colunas: [['name', 'Nome'], ['cpfCnpj', 'CPF/CNPJ'], ['email', 'E-mail'], ['mobilePhone', 'Celular'], ['city', 'Cidade'], ['notificationDisabled', 'Sem avisos', 'bool']], acoes: ['clientes.ver', 'clientes.avisos', 'clientes.editar', 'clientes.excluir', 'clientes.restaurar'] }] },
  { chave: 'extrato', nome: 'Extrato', sub: 'Tudo que entrou e saiu do saldo do Asaas', listas: [{ op: 'extrato', colunas: [['date', 'Data', 'data'], ['description', 'Descrição'], ['type', 'Tipo'], ['value', 'Valor', 'reais'], ['balance', 'Saldo', 'reais']] }] },
  { chave: 'transferencias', nome: 'Transferências', sub: 'Tirar dinheiro do Asaas para banco, Pix ou outra conta Asaas', topo: ['transferencias.pix', 'transferencias.banco', 'transferencias.asaas'], listas: [{ op: 'transferencias', colunas: [['dateCreated', 'Criada', 'data'], ['description', 'Descrição'], ['operationType', 'Por'], ['value', 'Valor', 'reais'], ['transferFee', 'Taxa', 'reais'], ['status', 'Situação', 'situacao'], ['authorized', 'Autorizada', 'bool']], acoes: ['transferencias.ver', 'transferencias.cancelar'] }] },
  { chave: 'pix', nome: 'Pix', sub: 'Chaves, QR Codes e transações', topo: ['pix.chaves.criar', 'pix.qr.criar', 'pix.ler', 'pix.pagar', 'pix.limite'], listas: [
    { op: 'pix.chaves', titulo: 'Chaves da conta', colunas: [['key', 'Chave'], ['type', 'Tipo'], ['status', 'Situação', 'situacao'], ['dateCreated', 'Criada', 'data']], acoes: ['pix.chaves.excluir'] },
    { op: 'pix.transacoes', titulo: 'Transações', colunas: [['effectiveDate', 'Data', 'dataHora'], ['description', 'Descrição'], ['type', 'Tipo'], ['value', 'Valor', 'reais'], ['status', 'Situação', 'situacao']], acoes: ['pix.transacoes.ver', 'pix.transacoes.cancelar'] },
  ] },
  { chave: 'contas', nome: 'Pagar contas', sub: 'Pagar boletos com o saldo do Asaas', topo: ['contas.simular', 'contas.pagar'], listas: [{ op: 'contas', colunas: [['scheduleDate', 'Agendado', 'data'], ['paymentDate', 'Pago', 'data'], ['description', 'Descrição'], ['companyName', 'Favorecido'], ['value', 'Valor', 'reais'], ['fee', 'Taxa', 'reais'], ['status', 'Situação', 'situacao']], acoes: ['contas.ver', 'contas.cancelar'] }] },
  { chave: 'antecipacoes', nome: 'Antecipações', sub: 'Receber antes o que foi vendido a prazo', topo: ['antecipacoes.limites', 'antecipacoes.simular', 'antecipacoes.pedir', 'antecipacoes.automatica', 'antecipacoes.automatica.mudar'], listas: [{ op: 'antecipacoes', colunas: [['requestDate', 'Pedida', 'data'], ['anticipationDate', 'Crédito', 'data'], ['payment', 'Cobrança'], ['value', 'Valor', 'reais'], ['fee', 'Taxa', 'reais'], ['netValue', 'Líquido', 'reais'], ['status', 'Situação', 'situacao']], acoes: ['antecipacoes.ver', 'antecipacoes.cancelar'] }] },
  { chave: 'negativacao', nome: 'Negativação', sub: 'Registrar devedores no Serasa pelo Asaas', topo: ['negativacoes.disponiveis', 'negativacoes.simular', 'negativacoes.criar'], listas: [{ op: 'negativacoes', colunas: [['requestDate', 'Pedida', 'data'], ['payment', 'Cobrança'], ['description', 'Descrição'], ['value', 'Valor', 'reais'], ['feeValue', 'Custo', 'reais'], ['status', 'Situação', 'situacao']], acoes: ['negativacoes.ver', 'negativacoes.historico', 'negativacoes.recebimentos', 'negativacoes.cancelar'] }] },
  { chave: 'serasa', nome: 'Consulta Serasa', sub: 'Consultar a situação de crédito de um CPF ou CNPJ', topo: ['serasa.consultar'], listas: [{ op: 'serasa', colunas: [['dateCreated', 'Feita', 'dataHora'], ['cpfCnpj', 'CPF/CNPJ'], ['customer', 'Cliente']], acoes: ['serasa.ver'] }] },
  { chave: 'notas', nome: 'Notas de serviço', sub: 'NFS-e emitidas pelo Asaas', topo: ['notas.agendar', 'notas.fiscal', 'notas.servicos', 'notas.municipio'], listas: [{ op: 'notas', colunas: [['effectiveDate', 'Emissão', 'data'], ['number', 'Número'], ['serviceDescription', 'Serviço'], ['value', 'Valor', 'reais'], ['status', 'Situação', 'situacao'], ['pdfUrl', 'PDF', 'link']], acoes: ['notas.ver', 'notas.emitir', 'notas.cancelar'] }] },
  { chave: 'recargas', nome: 'Recarga de celular', sub: 'Recarga paga com o saldo do Asaas', topo: ['recargas.pedir'], listas: [{ op: 'recargas', colunas: [['dateCreated', 'Feita', 'dataHora'], ['phoneNumber', 'Celular'], ['operatorName', 'Operadora'], ['value', 'Valor', 'reais'], ['status', 'Situação', 'situacao']], acoes: ['recargas.ver', 'recargas.cancelar'] }] },
  { chave: 'splits', nome: 'Split e subcontas', sub: 'Divisão automática do valor recebido e contas-filhas', topo: ['splits.totais', 'conta.carteiras', 'subcontas.criar'], listas: [
    { op: 'splits.pagos', titulo: 'Splits pagos', colunas: [['paymentId', 'Cobrança'], ['walletId', 'Carteira'], ['totalValue', 'Valor', 'reais'], ['status', 'Situação', 'situacao']] },
    { op: 'splits.recebidos', titulo: 'Splits recebidos', colunas: [['paymentId', 'Cobrança'], ['walletId', 'Carteira'], ['totalValue', 'Valor', 'reais'], ['status', 'Situação', 'situacao']] },
    { op: 'subcontas', titulo: 'Subcontas', colunas: [['name', 'Nome'], ['email', 'E-mail'], ['cpfCnpj', 'CPF/CNPJ'], ['walletId', 'WalletId']], acoes: ['subcontas.ver'] },
  ] },
  { chave: 'webhooks', nome: 'Webhooks', sub: 'Avisos que o Asaas manda para os sistemas (é o que dá a baixa automática)', topo: ['webhooks.criar'], listas: [{ op: 'webhooks', colunas: [['name', 'Nome'], ['url', 'Endereço'], ['enabled', 'Ligado', 'bool'], ['interrupted', 'Fila parada', 'bool'], ['sendType', 'Envio']], acoes: ['webhooks.ver', 'webhooks.editar', 'webhooks.destravar', 'webhooks.excluir'] }] },
];
const DA_CONTA = ['conta.dados', 'conta.numero', 'conta.taxas', 'conta.situacao', 'conta.limites', 'conta.checkout', 'conta.carteiras'];

const executar = (operacao: string, extra: { id?: string; filtros?: Linha; corpo?: Linha; pagina?: number } = {}) => api<Linha>('/financeiro/asaas/executar', { corpo: { operacao, ...extra } });
const dinheiro = (v: unknown) => (typeof v === 'number' ? reais(Math.round(v * 100)) : '—');
const pegar = (o: Linha, caminho: string) => caminho.split('.').reduce<any>((a, k) => a?.[k], o);

function celula(l: Linha, [campo, , tipo]: Col) {
  const v = pegar(l, campo);
  if (tipo === 'titulo') return v ? <span className="etiqueta marrom" title="Esta cobrança pertence a um título do sistema">{v.descricao}</span> : <span className="muted">avulsa</span>;
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  if (tipo === 'reais') return dinheiro(v);
  if (tipo === 'data') return dataBR(String(v).slice(0, 10));
  if (tipo === 'dataHora') return dataHora(String(v).replace(' ', 'T'));
  if (tipo === 'bool') return v ? 'Sim' : 'Não';
  if (tipo === 'link') return <a href={String(v)} target="_blank" rel="noreferrer">abrir</a>;
  if (tipo === 'situacao') return <span className={`etiqueta ${SITUACAO[v]?.[1] ?? 'neutra'}`}>{SITUACAO[v]?.[0] ?? String(v)}</span>;
  return FORMA[v] ?? String(v);
}

/** Módulo Asaas: tudo que a conta do Asaas faz, sem sair do sistema. */
export function Asaas() {
  const cat = useQuery({ queryKey: ['asaas', 'catalogo'], queryFn: () => api<Catalogo>('/financeiro/asaas/catalogo'), staleTime: 60_000 });
  const [secao, setSecao] = useState('visao');
  const [acao, setAcao] = useState<{ op: Operacao; id?: string; linha?: Linha } | null>(null);
  const [resultado, setResultado] = useState<{ titulo: string; dados: Linha } | null>(null);
  const qc = useQueryClient();
  if (cat.isLoading) return <Carregando />;
  if (cat.error) return <Erro erro={cat.error} />;
  const c = cat.data!;
  if (!c.ligado)
    return <div className="cartao"><b>O Asaas ainda não está ligado.</b><p className="muted" style={{ marginBottom: 0 }}>Cole a chave da API em Configurações › Integrações › Asaas. Com a chave, este módulo mostra saldo, cobranças, extrato, transferências, Pix e o resto.</p></div>;
  const ops = new Map(c.operacoes.map((o) => [o.chave, o]));
  const abrir = (chave: string, linha?: Linha, idCampo = 'id') => {
    const op = ops.get(chave);
    if (!op) return;
    const id = linha ? String(linha[idCampo] ?? '') : undefined;
    // Consulta sem campos: roda direto e mostra a resposta.
    if (op.metodo === 'GET' && !op.filtros?.length) {
      void executar(chave, { id }).then((d) => setResultado({ titulo: op.nome, dados: d })).catch((e) => setResultado({ titulo: op.nome, dados: { erro: (e as Error).message } }));
      return;
    }
    setAcao({ op, id, linha });
  };
  const s = SECOES.find((x) => x.chave === secao);
  const visiveis = SECOES.filter((x) => x.listas.some((l) => ops.has(l.op)));
  return (
    <div className="coluna">
      <div className="asaas-secoes">
        <button className={secao === 'visao' ? 'ativa' : ''} onClick={() => setSecao('visao')}>Visão geral</button>
        {visiveis.map((x) => <button key={x.chave} className={secao === x.chave ? 'ativa' : ''} onClick={() => setSecao(x.chave)}>{x.nome}</button>)}
      </div>
      {c.ambiente !== 'producao' && <div className="aviso alerta">Ambiente de testes do Asaas ({c.ambiente}): nada aqui movimenta dinheiro de verdade.</div>}
      {secao === 'visao' || !s ? <Visao ops={ops} abrir={abrir} setResultado={setResultado} /> : (
        <>
          <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <p className="muted" style={{ margin: 0 }}>{s.sub}</p>
            <div className="flex" style={{ flexWrap: 'wrap' }}>
              {s.topo?.filter((k) => ops.has(k)).map((k, i) => <button key={k} className={`botao pequeno ${i === 0 && ops.get(k)!.metodo !== 'GET' ? '' : 'claro'}`} onClick={() => abrir(k)}>{ops.get(k)!.nome}</button>)}
            </div>
          </div>
          {s.listas.filter((l) => ops.has(l.op)).map((l) => <ListaAsaas key={l.op} lista={l} op={ops.get(l.op)!} ops={ops} abrir={abrir} />)}
        </>
      )}
      {acao && <Acao {...acao} fechar={() => setAcao(null)} pronto={(d) => { setAcao(null); setResultado({ titulo: acao.op.nome, dados: d }); if (acao.op.metodo !== 'GET') { qc.invalidateQueries({ queryKey: ['asaas', 'lista'] }); qc.invalidateQueries({ queryKey: ['asaas', 'resumo'] }); qc.invalidateQueries({ queryKey: ['titulos'] }); } }} />}
      {resultado && <Resultado {...resultado} fechar={() => setResultado(null)} />}
    </div>
  );
}

function Visao({ ops, abrir, setResultado }: { ops: Map<string, Operacao>; abrir: (k: string) => void; setResultado: (r: { titulo: string; dados: Linha }) => void }) {
  const q = useQuery({ queryKey: ['asaas', 'resumo'], queryFn: () => api<any>('/financeiro/asaas/resumo') });
  const qc = useQueryClient();
  const webhook = useMutation({ mutationFn: () => api<Linha>('/financeiro/asaas/webhook-sistema', { corpo: {} }), onSuccess: (d) => { setResultado({ titulo: 'Webhook deste sistema', dados: d }); qc.invalidateQueries({ queryKey: ['asaas', 'lista'] }); } });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const r = q.data;
  const total = (t: any) => (t ? `${dinheiro(t.value)}` : '—');
  return (
    <div className="coluna">
      {r.erro && <div className="aviso erro">{r.erro}</div>}
      <div className="grade g4">
        <Indicador tipo="destaque" rotulo="Saldo no Asaas" valor={r.saldo === null ? '—' : dinheiro(r.saldo)} detalhe={r.numero?.account ? `Agência ${r.numero.agency} · conta ${r.numero.account}-${r.numero.accountDigit}` : undefined} />
        <Indicador rotulo="A receber" valor={total(r.aReceber)} detalhe={r.aReceber ? `${r.aReceber.quantity} cobrança(s) · líquido ${dinheiro(r.aReceber.netValue)}` : undefined} />
        <Indicador tipo="atencao" rotulo="Vencidas" valor={total(r.vencidas)} detalhe={r.vencidas ? `${r.vencidas.quantity} cobrança(s)` : undefined} />
        <Indicador rotulo="Recebidas" valor={total(r.recebidas)} detalhe={r.recebidas ? `${r.recebidas.quantity} cobrança(s) · líquido ${dinheiro(r.recebidas.netValue)}` : undefined} />
      </div>
      <div className="cartao">
        <b>Conta</b>
        {r.situacao && <p className="muted" style={{ margin: '6px 0' }}>Cadastro: {Object.entries(r.situacao as Record<string, string>).filter(([, v]) => typeof v === 'string').map(([k, v]) => `${({ general: 'geral', commercialInfo: 'dados comerciais', bankAccountInfo: 'conta bancária', documentation: 'documentos' } as Record<string, string>)[k] ?? k}: ${SITUACAO[v]?.[0] ?? v}`).join(' · ')}</p>}
        <div className="flex" style={{ flexWrap: 'wrap' }}>
          {DA_CONTA.filter((k) => ops.has(k)).map((k) => <button key={k} className="botao claro pequeno" onClick={() => abrir(k)}>{ops.get(k)!.nome}</button>)}
        </div>
      </div>
      {ops.has('webhooks') && (
        <div className="cartao">
          <b>Baixa automática</b>
          <p className="muted" style={{ margin: '6px 0' }}>Para o título receber a baixa sozinho quando o cliente paga, o Asaas precisa avisar este sistema. O botão cria (ou conserta) esse aviso no Asaas, com o endereço e o token certos.</p>
          <button className="botao pequeno" disabled={webhook.isPending} onClick={() => webhook.mutate()}>{webhook.isPending ? 'Configurando…' : 'Configurar o webhook deste sistema'}</button>
          {webhook.error && <Erro erro={webhook.error} />}
        </div>
      )}
      <p className="muted" style={{ margin: 0 }}>
        Operações que tiram dinheiro do saldo ou têm custo (transferir, pagar boleto, pagar Pix, estornar, antecipar, negativar, consultar Serasa, recarga) aparecem só para quem tem a permissão "excluir" no Financeiro, e tudo que muda fica na auditoria.
        O Asaas ainda pode pedir a autorização dele (SMS ou aplicativo) antes de liberar uma transferência.
      </p>
    </div>
  );
}

function ListaAsaas({ lista, op, ops, abrir }: { lista: Lista; op: Operacao; ops: Map<string, Operacao>; abrir: (k: string, linha?: Linha, idCampo?: string) => void }) {
  const [filtros, setFiltros] = useState<Linha>({});
  const [pagina, setPagina] = useState(1);
  const q = useQuery({ queryKey: ['asaas', 'lista', op.chave, filtros, pagina], queryFn: () => executar(op.chave, { filtros, pagina }), placeholderData: (a) => a, retry: false });
  const linhas: Linha[] = Array.isArray(q.data?.data) ? q.data!.data : [];
  const acoes = (lista.acoes ?? []).filter((k) => ops.has(k));
  return (
    <div className="coluna" style={{ gap: 8 }}>
      {lista.titulo && <h3 style={{ margin: '8px 0 0' }}>{lista.titulo}</h3>}
      {!!op.filtros?.length && (
        <div className="busca">
          {op.filtros.map((f) => <Entrada key={f.nome} campo={f} valor={filtros[f.nome]} mudar={(v) => { setPagina(1); setFiltros((a) => { const n = { ...a }; if (v === undefined) delete n[f.nome]; else n[f.nome] = v; return n; }); }} compacto />)}
        </div>
      )}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="tabela">
              <thead><tr>{lista.colunas.map((c) => <th key={c[0]} className={c[2] === 'reais' ? 'num' : ''}>{c[1]}</th>)}{acoes.length > 0 && <th></th>}</tr></thead>
              <tbody>
                {linhas.map((l, i) => (
                  <tr key={l.id ?? i} style={l.deleted ? { opacity: 0.5 } : undefined}>
                    {lista.colunas.map((c) => <td key={c[0]} className={c[2] === 'reais' ? 'num' : ''}>{celula(l, c)}</td>)}
                    {acoes.length > 0 && (
                      <td>
                        <select className="asaas-acoes" value="" aria-label="Ações" onChange={(e) => e.target.value && abrir(e.target.value, l, lista.id)}>
                          <option value="">Ações…</option>
                          {acoes.map((k) => <option key={k} value={k}>{ops.get(k)!.nome}</option>)}
                        </select>
                      </td>
                    )}
                  </tr>
                ))}
                {!linhas.length && <tr><td colSpan={lista.colunas.length + 1} className="vazio">Nada por aqui.</td></tr>}
              </tbody>
            </table>
          </div>
          {(pagina > 1 || q.data?.hasMore) && (
            <div className="flex">
              <button className="botao claro pequeno" disabled={pagina === 1} onClick={() => setPagina(pagina - 1)}>Anterior</button>
              <span className="muted">Página {pagina}{typeof q.data?.totalCount === 'number' ? ` · ${q.data.totalCount} no total` : ''}</span>
              <button className="botao claro pequeno" disabled={!q.data?.hasMore} onClick={() => setPagina(pagina + 1)}>Próxima</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Campo de formulário conforme o tipo do catálogo. O valor já sai no formato que o servidor espera. */
function Entrada({ campo, valor, mudar, compacto, erro }: { campo: CampoAsaas; valor: unknown; mudar: (v: unknown) => void; compacto?: boolean; erro?: string }) {
  const [texto, setTexto] = useState(() => (campo.tipo === 'dinheiro' && typeof valor === 'number' ? (valor / 100).toFixed(2).replace('.', ',') : campo.tipo === 'json' && valor !== undefined ? JSON.stringify(valor) : valor === undefined || valor === null ? '' : String(valor)));
  const rotulo = `${campo.rotulo}${campo.obrigatorio ? ' *' : ''}`;
  let entrada: JSX.Element;
  if (campo.tipo === 'opcao') entrada = <select value={(valor as string) ?? ''} onChange={(e) => mudar(e.target.value || undefined)} aria-label={campo.rotulo}><option value="">{compacto ? campo.rotulo : 'Escolha…'}</option>{campo.opcoes!.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>;
  else if (campo.tipo === 'bool') entrada = <select value={valor === undefined ? '' : valor ? 's' : 'n'} onChange={(e) => mudar(e.target.value === '' ? undefined : e.target.value === 's')} aria-label={campo.rotulo}><option value="">{compacto ? campo.rotulo : '—'}</option><option value="s">Sim</option><option value="n">Não</option></select>;
  else if (campo.tipo === 'data') entrada = <input type="date" value={(valor as string) ?? ''} onChange={(e) => mudar(e.target.value || undefined)} aria-label={campo.rotulo} title={campo.rotulo} />;
  else if (campo.tipo === 'cliente') entrada = <ClienteAsaas valor={(valor as string) ?? ''} mudar={mudar} rotulo={compacto ? campo.rotulo : undefined} />;
  else if (campo.tipo === 'json') entrada = <textarea rows={2} value={texto} placeholder='["A","B"]' onChange={(e) => { setTexto(e.target.value); try { mudar(e.target.value.trim() ? JSON.parse(e.target.value) : undefined); } catch { mudar('inválido'); } }} />;
  else
    entrada = (
      <input
        value={texto}
        inputMode={campo.tipo === 'texto' ? undefined : 'decimal'}
        placeholder={compacto ? campo.rotulo : campo.tipo === 'dinheiro' ? '0,00' : undefined}
        aria-label={campo.rotulo}
        onChange={(e) => {
          const t = e.target.value;
          setTexto(t);
          if (!t.trim()) return mudar(undefined);
          if (campo.tipo === 'dinheiro') return mudar(paraCentavos(t));
          if (campo.tipo === 'numero') return mudar(Number(t.replace(',', '.')));
          if (campo.tipo === 'inteiro') return mudar(Number.parseInt(t, 10));
          mudar(t);
        }}
      />
    );
  if (compacto) return campo.tipo === 'data' ? <label className="asaas-data"><span>{campo.rotulo}</span>{entrada}</label> : entrada;
  return <Campo rotulo={rotulo} ajuda={campo.ajuda} erro={erro} className={campo.tipo === 'json' || campo.tipo === 'cliente' ? 'l2' : undefined}>{entrada}</Campo>;
}

/** Cliente do Asaas: busca a pessoa no cadastro do sistema (e cria no Asaas se precisar) ou aceita o código cus_… */
function ClienteAsaas({ valor, mudar, rotulo }: { valor: string; mudar: (v: unknown) => void; rotulo?: string }) {
  const [busca, setBusca] = useState('');
  const [nome, setNome] = useState('');
  const q = useQuery({
    queryKey: ['pessoas', 'asaas', busca],
    enabled: busca.trim().length >= 3 && !/^cus_/.test(busca),
    queryFn: async () => (await Promise.all(['representante', 'cliente'].map((tipo) => api<{ itens: any[] }>(`/pessoas?tipo=${tipo}&busca=${encodeURIComponent(busca)}`).catch(() => ({ itens: [] }))))).flatMap((r) => r.itens),
  });
  const escolher = useMutation({ mutationFn: (pessoaId: string) => api<{ id: string; nome: string }>('/financeiro/asaas/cliente', { corpo: { pessoaId } }), onSuccess: (r) => { mudar(r.id); setNome(r.nome); setBusca(''); } });
  const itens: any[] = q.data ?? [];
  if (valor) return <span className="flex" style={{ gap: 6 }}><span className="etiqueta marrom">{nome || valor}</span><button type="button" className="botao claro pequeno" onClick={() => { mudar(undefined); setNome(''); }}>Trocar</button></span>;
  return (
    <div style={{ position: 'relative', minWidth: 220 }}>
      <input value={busca} placeholder={rotulo ? `${rotulo}: nome, CPF ou cus_…` : 'Nome ou CPF do cadastro, ou o código cus_…'} onChange={(e) => { setBusca(e.target.value); if (/^cus_[A-Za-z0-9]+$/.test(e.target.value.trim())) mudar(e.target.value.trim()); }} />
      {busca.trim().length >= 3 && itens.length > 0 && (
        <div className="asaas-sugestoes">
          {itens.slice(0, 8).map((p) => <button type="button" key={p.id} disabled={escolher.isPending} onClick={() => escolher.mutate(p.id)}>{p.nome} <span className="muted">{p.documento ?? 'sem CPF'}</span></button>)}
        </div>
      )}
      {escolher.error && <div className="muted" style={{ color: '#a23a2a' }}>{(escolher.error as Error).message}</div>}
    </div>
  );
}

const VALOR_EM_REAIS = /^(value|netValue|totalValue|installmentValue|paymentValue|discount|interest|fine|incomeValue|deductions)$/;

function Acao({ op, id, linha, fechar, pronto }: { op: Operacao; id?: string; linha?: Linha; fechar: () => void; pronto: (d: Linha) => void }) {
  const campos = op.metodo === 'GET' ? op.filtros ?? [] : op.campos ?? [];
  // Edição: começa com o que o registro já tem (valores do Asaas vêm em reais; a tela trabalha em centavos).
  const [v, setV] = useState<Linha>(() => {
    if (op.metodo !== 'PUT' || !linha) return {};
    const ini: Linha = {};
    for (const cp of campos) {
      const atual = pegar(linha, cp.nome);
      if (atual === undefined || atual === null || typeof atual === 'object' && cp.tipo !== 'json') continue;
      ini[cp.nome] = cp.tipo === 'dinheiro' ? Math.round(Number(atual) * 100) : atual;
    }
    return ini;
  });
  const [conferi, setConferi] = useState(false);
  const perigo = op.nivel === 'dinheiro' || op.metodo === 'DELETE';
  const m = useMutation({ mutationFn: () => executar(op.chave, op.metodo === 'GET' ? { id, filtros: v } : { id, corpo: v }), onSuccess: pronto });
  const erros = camposComErro(m.error);
  const valorPrincipal = campos.find((cp) => cp.tipo === 'dinheiro' && VALOR_EM_REAIS.test(cp.nome) && typeof v[cp.nome] === 'number');
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: campos.length > 4 ? 760 : 520 }}>
        <h3 style={{ margin: '0 0 12px' }}>{op.nome}{linha ? ` · ${linha.description ?? linha.name ?? linha.key ?? id}` : ''}</h3>
        {op.aviso && <div className="aviso alerta" style={{ marginBottom: 10 }}>{op.aviso}</div>}
        {campos.length > 0 && (
          <div className="form" style={{ gridTemplateColumns: campos.length > 4 ? '1fr 1fr' : '1fr' }}>
            {campos.map((cp) => <Entrada key={cp.nome} campo={cp} valor={v[cp.nome]} erro={erros[cp.nome]} mudar={(x) => setV((a) => { const n = { ...a }; if (x === undefined) delete n[cp.nome]; else n[cp.nome] = x; return n; })} />)}
          </div>
        )}
        {perigo && (
          <label className="check" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={conferi} onChange={(e) => setConferi(e.target.checked)} />
            {op.nivel === 'dinheiro' ? `Conferi os dados${valorPrincipal ? ` e o valor de ${reais(v[valorPrincipal.nome])}` : ''}: pode executar` : 'Tenho certeza'}
          </label>
        )}
        {m.error && <Erro erro={m.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className={`botao ${perigo ? 'perigo' : ''}`} disabled={m.isPending || (perigo && !conferi)} onClick={() => m.mutate()}>{m.isPending ? 'Enviando…' : op.metodo === 'GET' ? 'Consultar' : op.metodo === 'DELETE' ? 'Excluir' : 'Confirmar'}</button>
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}

const ROTULOS: Record<string, string> = { id: 'Código', status: 'Situação', value: 'Valor', netValue: 'Valor líquido', dueDate: 'Vencimento', description: 'Descrição', billingType: 'Forma', customer: 'Cliente', invoiceUrl: 'Fatura', bankSlipUrl: 'Boleto', identificationField: 'Linha digitável', barCode: 'Código de barras', nossoNumero: 'Nosso número', payload: 'Pix copia e cola', expirationDate: 'Vale até', balance: 'Saldo', dateCreated: 'Criado em', paymentDate: 'Pago em', name: 'Nome', email: 'E-mail', cpfCnpj: 'CPF/CNPJ', apiKey: 'Chave de API (copie agora)', walletId: 'WalletId', fee: 'Taxa', transferFee: 'Taxa', authorized: 'Autorizada', mensagem: 'Resultado', _efeito: 'No sistema', erro: 'Erro', url: 'Endereço', deleted: 'Excluído', key: 'Chave' };

function valorLegivel(k: string, v: unknown): JSX.Element | string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (typeof v === 'number') return /value|balance|fee|discount|interest|fine|limit|income|deductions|amount/i.test(k) && !/count|days|percent/i.test(k) ? dinheiro(v) : v.toLocaleString('pt-BR');
  const s = String(v);
  if (/^https?:\/\//.test(s)) return <a href={s} target="_blank" rel="noreferrer">{s}</a>;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dataBR(s);
  if (k === 'status' || SITUACAO[s]) return SITUACAO[s]?.[0] ?? s;
  return FORMA[s] ?? s;
}

/** Mostra a resposta do Asaas de forma legível: campos simples, objetos abertos e listas em tabela. */
function Resultado({ titulo, dados, fechar }: { titulo: string; dados: Linha; fechar: () => void }) {
  const bloco = (o: Linha, nivel = 0): JSX.Element => (
    <div className="asaas-campos" style={nivel ? { marginLeft: 14 } : undefined}>
      {Object.entries(o).filter(([k]) => !['object', '_titulo', 'encodedImage'].includes(k) && !(k === '_efeito' && !o[k])).map(([k, v]) => (
        Array.isArray(v)
          ? <div key={k} className="largo"><b>{ROTULOS[k] ?? k}</b>{v.length === 0 ? <span className="muted"> nenhum</span> : typeof v[0] === 'object' && v[0] ? <Tabela linhas={v} /> : <span> {v.join(', ')}</span>}</div>
          : v && typeof v === 'object'
            ? <div key={k} className="largo"><b>{ROTULOS[k] ?? k}</b>{bloco(v as Linha, nivel + 1)}</div>
            : <div key={k}><span className="muted">{ROTULOS[k] ?? k}</span><span style={{ overflowWrap: 'anywhere' }}>{valorLegivel(k, v)}</span></div>
      ))}
    </div>
  );
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860 }}>
        <h3 style={{ marginTop: 0 }}>{titulo}</h3>
        {dados.encodedImage && <img alt="QR Code" src={`data:image/png;base64,${dados.encodedImage}`} style={{ width: 200, height: 200, imageRendering: 'pixelated' }} />}
        {Array.isArray(dados.data) && Object.keys(dados).every((k) => ['object', 'hasMore', 'totalCount', 'limit', 'offset', 'data', '_efeito'].includes(k)) ? (dados.data.length ? <Tabela linhas={dados.data} /> : <p className="muted">Nada encontrado.</p>) : bloco(dados)}
        <div className="flex" style={{ marginTop: 12 }}><button className="botao claro" onClick={fechar}>Fechar</button></div>
      </div>
    </div>
  );
}

function Tabela({ linhas }: { linhas: Linha[] }) {
  const colunas = [...new Set(linhas.flatMap((l) => Object.keys(l).filter((k) => l[k] === null || typeof l[k] !== 'object')))].filter((k) => k !== 'object').slice(0, 9);
  return (
    <div style={{ overflowX: 'auto', marginTop: 6 }}>
      <table className="tabela">
        <thead><tr>{colunas.map((k) => <th key={k}>{ROTULOS[k] ?? k}</th>)}</tr></thead>
        <tbody>{linhas.slice(0, 100).map((l, i) => <tr key={i}>{colunas.map((k) => <td key={k}>{valorLegivel(k, l[k])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
