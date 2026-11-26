import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { reais } from '../../formato';
import { Erro } from '../../componentes/ui';

interface Resultado { boletos: number; cancelados: number; pagos: number; jaSemBoleto: number; falhas: { titulo: string; erro: string }[]; valor: number }

const hojeBR = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

/** Cancela no Asaas os boletos gerados num dia (ex.: emitidos por engano). Confere antes de cancelar. */
export function CancelarBoletosDoDia() {
  const qc = useQueryClient();
  const [dia, setDia] = useState(hojeBR());
  const [confirmar, setConfirmar] = useState(false);
  const conferir = useMutation({ mutationFn: () => api<Resultado>('/cobranca/boletos/cancelar-do-dia', { corpo: { dia, simular: true } }) });
  const cancelar = useMutation({
    mutationFn: () => api<Resultado>('/cobranca/boletos/cancelar-do-dia', { corpo: { dia, simular: false } }),
    onSuccess: () => { setConfirmar(false); qc.invalidateQueries(); },
  });
  const p = conferir.data;
  const r = cancelar.data;
  return (
    <div className="cartao coluna" style={{ marginBottom: 14 }}>
      <h3 style={{ margin: 0 }}>Cancelar boletos gerados num dia</h3>
      <p className="muted" style={{ margin: 0 }}>Apaga no Asaas os boletos e Pix emitidos na data escolhida. As parcelas continuam em aberto, só sem o boleto. Parcela já paga não é mexida.</p>
      <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" value={dia} onChange={(e) => { setDia(e.target.value); conferir.reset(); cancelar.reset(); setConfirmar(false); }} />
        <button className="botao claro" disabled={conferir.isPending} onClick={() => { cancelar.reset(); conferir.mutate(); }}>{conferir.isPending ? 'Conferindo…' : 'Conferir'}</button>
      </div>
      {conferir.error && <Erro erro={conferir.error} />}
      {p && !r && (
        <div className="aviso">
          {p.boletos === 0 ? 'Nenhum boleto foi gerado nesse dia.' : (
            <>
              <b>{p.cancelados}</b> boleto(s) para cancelar ({reais(p.valor)}){p.pagos ? ` · ${p.pagos} já pago(s), ficam como estão` : ''}.
              <div className="flex" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {!confirmar ? (
                  <button className="botao perigo" disabled={!p.cancelados} onClick={() => setConfirmar(true)}>Cancelar estes boletos</button>
                ) : (
                  <>
                    <span>Cancelar {p.cancelados} boleto(s) no Asaas? Não tem volta.</span>
                    <button className="botao perigo" disabled={cancelar.isPending} onClick={() => cancelar.mutate()}>{cancelar.isPending ? 'Cancelando…' : 'Sim, cancelar'}</button>
                    <button className="botao claro" onClick={() => setConfirmar(false)}>Não</button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {cancelar.error && <Erro erro={cancelar.error} />}
      {r && (
        <div className={r.falhas.length ? 'aviso alerta' : 'aviso ok'}>
          {r.cancelados} boleto(s) cancelado(s) no Asaas{r.pagos ? `; ${r.pagos} já estavam pagos` : ''}.
          {r.falhas.length > 0 && <> {r.falhas.length} não cancelaram: <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{r.falhas.slice(0, 20).map((f, i) => <li key={i}>{f.titulo}: {f.erro}</li>)}</ul></>}
        </div>
      )}
    </div>
  );
}
