import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { dataHora } from '../formato';
import { Carregando, Erro } from '../componentes/ui';

/** Página de assinatura eletrônica que a representante abre pelo link. */
export function Assinar() {
  const { token } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['assinar', token], queryFn: () => api<any>(`/publico/documentos/${token}`) });
  const [codigo, setCodigo] = useState('');
  const [nome, setNome] = useState('');
  const [cpf, setCpf] = useState('');
  const [aceite, setAceite] = useState(false);
  const [envio, setEnvio] = useState<{ enviadoPara: string; codigoDev?: string } | null>(null);
  const pedir = useMutation({ mutationFn: () => api<any>(`/publico/documentos/${token}/codigo`, { corpo: {} }), onSuccess: setEnvio });
  const assinar = useMutation({ mutationFn: () => api(`/publico/documentos/${token}/assinar`, { corpo: { codigo, nome, cpf: cpf || undefined, aceite } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['assinar', token] }) });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <div className="publico"><Erro erro={q.error} /></div>;
  const d = q.data;
  return (
    <div className="publico" style={{ maxWidth: 760 }}>
      <div className="cab">
        <img src="/logo-creme.png" alt="Aritana Semijoias" />
        <h1 style={{ fontSize: 22 }}>{d.titulo}</h1>
        <p style={{ color: '#d9cfc1', fontSize: 14 }}>Leia com atenção. Para assinar, você vai receber um código no seu e-mail.</p>
      </div>
      <div className="cartao" style={{ marginTop: 14, whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 15 }}>{d.conteudo}</div>
      {d.status === 'assinado' ? (
        <div className="aviso ok" style={{ marginTop: 14 }}>
          Assinado por <b>{d.assinaturaNome}</b> em {dataHora(d.assinadoEm)}.<br />
          <span style={{ fontSize: 12, wordBreak: 'break-all' }}>Código de verificação (SHA-256): {d.hash}</span>
        </div>
      ) : d.status !== 'pendente' ? (
        <div className="aviso alerta" style={{ marginTop: 14 }}>Este documento foi {d.status}. Fale com a Aritana.</div>
      ) : (
        <div className="cartao coluna" style={{ marginTop: 14 }}>
          <h2>Assinar</h2>
          {!envio ? (
            <>
              <p>Vamos enviar um código de 6 números para {d.emailMascarado ?? 'o seu e-mail'}.</p>
              {pedir.error && <Erro erro={pedir.error} />}
              <button className="botao" onClick={() => pedir.mutate()} disabled={pedir.isPending || !d.emailMascarado}>{pedir.isPending ? 'Enviando…' : 'Receber código por e-mail'}</button>
            </>
          ) : (
            <>
              <p className="muted">Código enviado para {envio.enviadoPara}. Ele vale por 15 minutos.</p>
              {envio.codigoDev && <div className="aviso alerta">Ambiente de teste, sem e-mail configurado. Código: <b>{envio.codigoDev}</b></div>}
              <div className="campo"><label htmlFor="cod">Código recebido</label><input id="cod" inputMode="numeric" maxLength={6} value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} style={{ fontSize: 22, letterSpacing: 6, maxWidth: 180 }} /></div>
              <div className="campo"><label htmlFor="nome">Seu nome completo</label><input id="nome" value={nome} onChange={(e) => setNome(e.target.value)} autoComplete="name" /></div>
              {d.pedeCpf && <div className="campo"><label htmlFor="cpf">Seu CPF</label><input id="cpf" inputMode="numeric" value={cpf} onChange={(e) => setCpf(e.target.value)} /></div>}
              <label className="check"><input type="checkbox" checked={aceite} onChange={(e) => setAceite(e.target.checked)} /> Li o documento inteiro e concordo com os termos.</label>
              {assinar.error && <Erro erro={assinar.error} />}
              <div className="flex">
                <button className="botao" disabled={codigo.length !== 6 || nome.length < 3 || !aceite || assinar.isPending} onClick={() => assinar.mutate()}>{assinar.isPending ? 'Assinando…' : 'Assinar documento'}</button>
                <button className="botao claro" onClick={() => pedir.mutate()} disabled={pedir.isPending}>Enviar outro código</button>
              </div>
              <p className="muted" style={{ fontSize: 12 }}>Ao assinar, registramos a data, a hora, o endereço de internet e o aparelho usado, junto com o código de verificação do documento.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
