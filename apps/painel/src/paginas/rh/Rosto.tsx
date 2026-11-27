import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, lerSessao, pode } from '../../api';
import { dataHora } from '../../formato';
import { Carregando, Erro } from '../../componentes/ui';

/** Imagem que só sai com login (fotos do RH ficam em pasta privada). */
function ImagemPrivada({ url, alt, tamanho = 140 }: { url: string; alt: string; tamanho?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [falhou, setFalhou] = useState(false);
  useEffect(() => {
    let vivo = true;
    let criado: string | null = null;
    setSrc(null);
    setFalhou(false);
    fetch(`/api${url}`, { headers: { authorization: `Bearer ${lerSessao()?.token ?? ''}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        criado = URL.createObjectURL(await r.blob());
        if (vivo) setSrc(criado);
      })
      .catch(() => vivo && setFalhou(true));
    return () => {
      vivo = false;
      if (criado) URL.revokeObjectURL(criado);
    };
  }, [url]);
  const estilo = { width: tamanho, height: tamanho, objectFit: 'cover' as const, borderRadius: 10, background: 'var(--creme-2)', display: 'grid', placeItems: 'center', fontSize: 12 };
  if (falhou) return <div className="muted" style={estilo}>Sem foto</div>;
  if (!src) return <div className="muted" style={estilo}>…</div>;
  return <img src={src} alt={alt} style={estilo} />;
}

const RESULTADO: Record<string, [string, string]> = {
  nao_confere: ['erro', 'Rosto não confere'],
  incerto: ['alerta', 'Não deu para conferir'],
  referencia: ['neutra', '1ª selfie virou referência'],
  erro: ['neutra', 'Falha na conferência'],
  confere: ['ok', 'Confere'],
};

/** RH › Conferir rostos: a selfie de cada batida comparada com a foto de referência (Claude); o RH revisa o que não confere. */
export function ConferirRostos() {
  const qc = useQueryClient();
  const [todos, setTodos] = useState(false);
  const q = useQuery({ queryKey: ['rh', 'rosto', todos], queryFn: () => api<any[]>(`/rh/rosto${todos ? '?todos=1' : ''}`) });
  const revisar = useMutation({ mutationFn: (d: { id: string; revisao: 'ok' | 'fraude'; usarComoReferencia?: boolean }) => api(`/rh/rosto/${d.id}/revisar`, { corpo: d }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rh', 'rosto'] }) });
  const editar = pode('rh', 'editar');
  return (
    <div className="coluna">
      <p className="muted" style={{ margin: 0 }}>
        Cada selfie do ponto é comparada com a foto de referência do funcionário. O ponto nunca é bloqueado por isso: o que não confere aparece aqui para o RH decidir. A foto de referência fica na ficha do funcionário (aba Dados) e pode ser trocada.
      </p>
      <label className="check"><input type="checkbox" checked={todos} onChange={(e) => setTodos(e.target.checked)} /> Mostrar também as que conferiram e as já revisadas</label>
      {revisar.error && <Erro erro={revisar.error} />}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : !q.data!.length ? <div className="cartao vazio">Nada para revisar.</div> : (
        <div className="coluna">
          {q.data!.map((c) => {
            const [cls, txt] = RESULTADO[c.resultado] ?? ['neutra', c.resultado];
            return (
              <div key={c.id} className="cartao flex" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ textAlign: 'center' }}><ImagemPrivada url={`/rh/funcionarios/${c.funcionarioId}/foto-rosto`} alt={`Referência de ${c.nome}`} /><div className="muted" style={{ fontSize: 12 }}>Referência</div></div>
                <div style={{ textAlign: 'center' }}><ImagemPrivada url={`/rh/registros/${c.registroId}/foto`} alt={`Selfie de ${c.nome}`} /><div className="muted" style={{ fontSize: 12 }}>Selfie do ponto</div></div>
                <div className="coluna" style={{ gap: 4, flex: 1, minWidth: 200 }}>
                  <b><Link to={`/rh/funcionario/${c.funcionarioId}?aba=ponto`}>{c.nome}</Link></b>
                  <span className="muted">Batida de {dataHora(c.marcadoEm)}</span>
                  <span><span className={`etiqueta ${cls}`}>{txt}</span> {c.motivo && <span className="muted" style={{ fontSize: 13 }}>{c.motivo}</span>}</span>
                  {c.revisao && <span className={`etiqueta ${c.revisao === 'ok' ? 'ok' : 'erro'}`}>{c.revisao === 'ok' ? 'RH: era a pessoa' : 'RH: não era a pessoa'}</span>}
                  {editar && !c.revisao && (
                    <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <button className="botao pequeno" disabled={revisar.isPending} onClick={() => revisar.mutate({ id: c.id, revisao: 'ok' })}>É a pessoa</button>
                      {c.resultado !== 'referencia' && <button className="botao claro pequeno" disabled={revisar.isPending} onClick={() => revisar.mutate({ id: c.id, revisao: 'ok', usarComoReferencia: true })}>É a pessoa · usar como referência</button>}
                      <button className="botao perigo pequeno" disabled={revisar.isPending} onClick={() => revisar.mutate({ id: c.id, revisao: 'fraude' })}>Não é a pessoa</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Foto de referência do rosto na ficha do funcionário. */
export function FotoRosto({ funcionarioId }: { funcionarioId: string }) {
  const [versao, setVersao] = useState(0);
  const enviar = useMutation({
    mutationFn: async (f: File) => {
      const dados = await new Promise<string>((ok, erro) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = erro; r.readAsDataURL(f); });
      return api(`/rh/funcionarios/${funcionarioId}/foto-rosto`, { corpo: { foto: dados } });
    },
    onSuccess: () => setVersao((v) => v + 1),
  });
  return (
    <div className="cartao flex" style={{ gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
      <ImagemPrivada key={versao} url={`/rh/funcionarios/${funcionarioId}/foto-rosto?v=${versao}`} alt="Foto de referência" tamanho={110} />
      <div className="coluna" style={{ gap: 6, flex: 1, minWidth: 220 }}>
        <b>Foto de referência do rosto</b>
        <span className="muted" style={{ fontSize: 13 }}>Usada para conferir a selfie do ponto. Sem foto, a primeira selfie vira a referência. Use uma foto de frente, com boa luz (JPEG).</span>
        {pode('rh', 'editar') && (
          <label className="botao claro pequeno" style={{ cursor: 'pointer', alignSelf: 'flex-start' }}>
            {enviar.isPending ? 'Enviando…' : 'Trocar foto'}
            <input type="file" accept="image/jpeg" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) enviar.mutate(f); e.target.value = ''; }} />
          </label>
        )}
        {enviar.error && <Erro erro={enviar.error} />}
      </div>
    </div>
  );
}
