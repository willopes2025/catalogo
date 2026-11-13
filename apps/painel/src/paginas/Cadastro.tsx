import { useMemo, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ErroApi } from '../api';
import '../portal/portal.css';

const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

/** Formulário público "Quero ser revendedora": link para anúncios, Instagram e WhatsApp (guarda a origem pelos utm_*). */
export function Cadastro() {
  const origem = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    const o: Record<string, string> = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref']) if (p.get(k)) o[k] = p.get(k)!.slice(0, 200);
    if (document.referrer) o.pagina = document.referrer.slice(0, 200);
    return o;
  }, []);
  const [f, setF] = useState({ nome: '', telefone: '', email: '', cpf: '', cidade: '', uf: 'ES', instagram: '', modeloInteresse: 'nao_sei', experiencia: '', comoConheceu: '', indicadaPor: '', consentimentoLgpd: false, site: '' });
  const m = useMutation({ mutationFn: () => api('/publico/candidaturas', { corpo: { ...f, email: f.email || null, cpf: f.cpf || null, origem } }) });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const campos = m.error instanceof ErroApi ? m.error.dados.campos ?? {} : {};
  if (m.isSuccess) {
    return (
      <div className="p-app"><div className="p-entrar">
        <img src="/logo-marrom.png" alt="Aritana Semijoias" />
        <h1>Cadastro recebido!</h1>
        <p className="p-suave">Obrigada, {f.nome.split(' ')[0]}. A equipe da Aritana vai falar com você pelo WhatsApp em breve.</p>
      </div></div>
    );
  }
  const erro = (k: string) => (campos[k] ? <span className="p-erro">{campos[k]}</span> : null);
  return (
    <div className="p-app">
      <form className="p-entrar" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <img src="/logo-marrom.png" alt="Aritana Semijoias" />
        <h1>Seja uma revendedora Aritana</h1>
        <p className="p-suave">Semijoias com garantia, maleta consignada sem investimento inicial e comissão sobre o que vender. Preencha e a gente te chama no WhatsApp.</p>
        <div className="p-cartao p-col">
          <label>Nome completo<input autoComplete="name" value={f.nome} onChange={set('nome')} />{erro('nome')}</label>
          <label>WhatsApp com DDD<input inputMode="tel" autoComplete="tel" value={f.telefone} onChange={set('telefone')} placeholder="(27) 99999-9999" />{erro('telefone')}</label>
          <label>E-mail<input type="email" autoComplete="email" value={f.email} onChange={set('email')} />{erro('email')}</label>
          <div className="p-grade2">
            <label>Cidade<input autoComplete="address-level2" value={f.cidade} onChange={set('cidade')} />{erro('cidade')}</label>
            <label>Estado<select className="p-busca" value={f.uf} onChange={set('uf')}>{UFS.map((u) => <option key={u}>{u}</option>)}</select></label>
          </div>
          <label>Como você quer trabalhar?
            <select className="p-busca" value={f.modeloInteresse} onChange={set('modeloInteresse')}>
              <option value="nao_sei">Quero entender as opções</option>
              <option value="consignado">Maleta consignada (pego as peças e acerto depois)</option>
              <option value="revenda">Revenda (compro com desconto)</option>
              <option value="afiliado">Afiliada (vendo pelo link)</option>
            </select>
          </label>
          <label>Já vende alguma coisa? (opcional)<input value={f.experiencia} onChange={set('experiencia')} placeholder="Ex.: roupas, cosméticos, nunca vendi" /></label>
          <label>Instagram (opcional)<input value={f.instagram} onChange={set('instagram')} placeholder="@seuperfil" /></label>
          <label>CPF (opcional, agiliza a análise)<input inputMode="numeric" value={f.cpf} onChange={set('cpf')} />{erro('cpf')}</label>
          <label>Como conheceu a Aritana? (opcional)
            <select className="p-busca" value={f.comoConheceu} onChange={set('comoConheceu')}><option value="">—</option><option>Instagram</option><option>Facebook</option><option>Indicação de uma revendedora</option><option>Loja ou evento</option><option>Google</option><option>Outro</option></select>
          </label>
          {f.comoConheceu === 'Indicação de uma revendedora' && <label>Quem indicou?<input value={f.indicadaPor} onChange={set('indicadaPor')} /></label>}
          <input className="campo-oculto" tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.site} onChange={set('site')} />
          <label className="p-check"><input type="checkbox" checked={f.consentimentoLgpd} onChange={(e) => setF({ ...f, consentimentoLgpd: e.target.checked })} /> Autorizo a Aritana a usar estes dados para entrar em contato comigo sobre a revenda (LGPD).</label>
          {erro('consentimentoLgpd')}
          <button className="p-botao" disabled={m.isPending}>{m.isPending ? 'Enviando…' : 'Quero ser revendedora'}</button>
          {m.error && !Object.keys(campos).length && <div className="p-aviso erro">{(m.error as Error).message}</div>}
        </div>
      </form>
    </div>
  );
}
