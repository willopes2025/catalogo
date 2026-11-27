import { useState } from 'react';

/** Link fixo do APK do app da equipe (gerado pelo GitHub Actions, workflow app-equipe.yml). */
export const LINK_APK_EQUIPE = 'https://github.com/willopes2025/catalogo/releases/download/app-equipe/aritana-gestao.apk';

const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent);
const dentroDoApp = () => /AritanaApp/.test(ua());
const android = () => /Android/i.test(ua());
const iphone = () => /iPhone|iPad|iPod/i.test(ua());

/**
 * Convite para instalar o app no celular: no Android, baixar o APK; no iPhone, pôr na tela de início.
 * Não aparece no computador nem dentro do próprio app; "Agora não" esconde por 7 dias neste aparelho.
 */
export function BaixarApp({ compacto = false }: { compacto?: boolean }) {
  const [passos, setPassos] = useState(false);
  const [oculto, setOculto] = useState(() => {
    try {
      return Number(localStorage.getItem('aritana.app.oculto') ?? 0) > Date.now();
    } catch {
      return false;
    }
  });
  if (oculto || dentroDoApp() || (!android() && !iphone())) return null;
  const esconder = () => {
    setOculto(true);
    try {
      localStorage.setItem('aritana.app.oculto', String(Date.now() + 7 * 86400_000));
    } catch {
      /* sem armazenamento */
    }
  };
  return (
    <div className="baixar-app" style={{ background: '#4e3f34', color: '#faf6ef', borderRadius: 12, padding: compacto ? '10px 12px' : 14, margin: compacto ? '0 0 12px' : '0 0 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <img src="/logo-creme.png" alt="" style={{ width: 54, flex: 'none' }} />
      <div style={{ flex: 1, minWidth: 160, fontSize: 14 }}>
        <b>Use o app Aritana Gestão no celular</b>
        <div style={{ opacity: 0.85, fontSize: 12.5 }}>
          {android() ? 'Baixe o arquivo, toque nele e permita instalar (apps desconhecidos). Depois é só entrar com seu login.' : 'No iPhone o app fica na tela de início, com o ícone da Aritana (o da App Store vem depois).'}
        </div>
        {passos && iphone() && (
          <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>
            <li>Abra este endereço no <b>Safari</b> (no Chrome do iPhone não aparece a opção).</li>
            <li>Toque em <b>Compartilhar</b> (o quadrado com a seta para cima, embaixo da tela).</li>
            <li>Role e toque em <b>Adicionar à Tela de Início</b> e depois em <b>Adicionar</b>.</li>
            <li>Abra pelo ícone <b>Aritana Gestão</b> que apareceu na tela.</li>
          </ol>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {android() && <a href={LINK_APK_EQUIPE} className="botao" style={{ background: '#c39552', borderColor: '#c39552', color: '#2b231d' }}>Baixar o app</a>}
        {iphone() && !passos && <button type="button" className="botao" onClick={() => setPassos(true)} style={{ background: '#c39552', borderColor: '#c39552', color: '#2b231d' }}>Instalar no iPhone</button>}
        <button type="button" className="botao claro" onClick={esconder} style={{ background: 'transparent', color: '#faf6ef', borderColor: '#faf6ef66' }}>Agora não</button>
      </div>
    </div>
  );
}
