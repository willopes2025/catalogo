import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { data, dataHora, reais, telefone } from '../formato';
import { Carregando, Erro } from '../componentes/ui';

const estiloFolha = `
  @page { size: A4; margin: 14mm; }
  body { background: #fff; }
  .folha { max-width: 190mm; margin: 0 auto; padding: 16px; background: #fff; color: #2b231d; font-size: 12.5px; }
  .folha h1 { font-size: 20px; margin: 0 0 4px; }
  .folha table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  .folha th, .folha td { border-bottom: 1px solid #ddd; padding: 5px 6px; text-align: left; }
  .folha th { background: #efe7d9; }
  .folha .num { text-align: right; }
  .folha .cab { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #5c4a3d; padding-bottom: 10px; margin-bottom: 10px; }
  .folha .assinatura { margin-top: 48px; display: flex; gap: 40px; }
  .folha .assinatura div { flex: 1; border-top: 1px solid #2b231d; padding-top: 4px; text-align: center; }
  .acoes-impressao { position: fixed; top: 12px; right: 12px; display: flex; gap: 8px; }
  @media print { .acoes-impressao { display: none; } }
`;

function Folha({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.body.style.background = '#fff';
    return () => { document.body.style.background = ''; };
  }, []);
  return (
    <>
      <style>{estiloFolha}</style>
      <div className="acoes-impressao"><button className="botao" onClick={() => window.print()}>Imprimir ou salvar PDF</button><button className="botao claro" onClick={() => window.close()}>Fechar</button></div>
      <div className="folha">{children}</div>
    </>
  );
}

/** Pedido da maleta (com valores) ou lista de separação (para o estoque, sem valores, por localização). */
export function ImprimirMaleta() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const via = params.get('via') === 'separacao' ? 'separacao' : 'pedido';
  const q = useQuery({ queryKey: ['maleta', id], queryFn: () => api<any>(`/maletas/${id}`) });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const m = q.data;
  const itens = m.itens.filter((i: any) => i.enviada > 0);
  return (
    <Folha>
      <div className="cab">
        <div>
          <img src="/logo-marrom.png" alt="Aritana" style={{ width: 120 }} />
          <h1>{via === 'pedido' ? 'Pedido de consignação' : 'Lista de separação'} · Maleta nº {m.numero}</h1>
          <div>{m.representante} · {telefone(m.telefone)} · {m.cidade}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div>Retirada: <b>{data(m.dataRetirada)}</b></div>
          <div>Acerto até: <b>{data(m.dataLimite)}</b></div>
          <div>Saída de: {m.origem}</div>
          <div>{m.entrega === 'envio' ? `Envio ${m.codigoRastreio ?? ''}` : 'Retirada presencial'}</div>
        </div>
      </div>
      <table>
        <thead><tr><th style={{ width: 24 }}>{via === 'separacao' ? '✓' : '#'}</th><th>Código</th><th>Ref.</th><th>Descrição</th><th className="num">Qtd.</th>{via === 'pedido' && <><th className="num">Preço</th><th className="num">Total</th></>}</tr></thead>
        <tbody>
          {itens.map((i: any, n: number) => (
            <tr key={i.id}>
              <td>{via === 'separacao' ? '☐' : n + 1}</td><td>{i.codigoBarras}</td><td>{i.referencia}</td><td>{i.descricao}</td><td className="num">{i.enviada}</td>
              {via === 'pedido' && <><td className="num">{reais(i.preco)}</td><td className="num">{reais(i.preco * i.enviada)}</td></>}
            </tr>
          ))}
        </tbody>
        <tfoot><tr><th colSpan={4}>Total</th><th className="num">{m.totais.pecasEnviadas}</th>{via === 'pedido' && <><th></th><th className="num">{reais(m.totais.valorEnviado)}</th></>}</tr></tfoot>
      </table>
      {via === 'pedido' && (
        <>
          <p style={{ marginTop: 14 }}>Declaro que recebi as peças acima em consignação, em perfeito estado, e que farei o acerto até {data(m.dataLimite)}, conforme o contrato.</p>
          {m.observacao && <p><b>Observação:</b> {m.observacao}</p>}
          <div className="assinatura"><div>{m.representante}</div><div>Aritana Semijoias</div></div>
        </>
      )}
      {via === 'separacao' && <div className="assinatura"><div>Separado por</div><div>Conferido por</div></div>}
      <p style={{ marginTop: 20, fontSize: 10, color: '#777' }}>Emitido em {dataHora(new Date().toISOString())}</p>
    </Folha>
  );
}

/** Contrato, promissória ou aditivo, com o registro da assinatura eletrônica. */
export function ImprimirDocumento() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['documento', id], queryFn: () => api<any>(`/documentos/${id}`) });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const d = q.data;
  return (
    <Folha>
      <div className="cab"><img src="/logo-marrom.png" alt="Aritana" style={{ width: 120 }} /><div style={{ textAlign: 'right' }}>{d.status === 'assinado' ? 'Assinado eletronicamente' : `Situação: ${d.status}`}</div></div>
      <h1>{d.titulo}</h1>
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55, marginTop: 10 }}>{d.conteudo}</div>
      {d.status === 'assinado' ? (
        <div style={{ marginTop: 24, border: '1px solid #ccc', padding: 10, fontSize: 11 }}>
          <b>Registro da assinatura eletrônica</b><br />
          Assinado por: {d.assinaturaNome}{d.assinaturaDocumento ? ` · CPF ${d.assinaturaDocumento.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')}` : ''}<br />
          Data e hora: {dataHora(d.assinadoEm)} · Confirmação por código enviado a {d.enviadoPara}<br />
          Endereço de internet: {d.ip} · Aparelho: {d.userAgent}<br />
          Código de verificação do documento (SHA-256): <span style={{ wordBreak: 'break-all' }}>{d.hash}</span>
        </div>
      ) : (
        <div className="assinatura"><div>{d.pessoa}</div></div>
      )}
    </Folha>
  );
}
