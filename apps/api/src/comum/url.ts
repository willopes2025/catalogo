/** Endereço público do sistema (links em WhatsApp, e-mail e retorno do login do Google). */
export function urlPublica() {
  const v = process.env.PAINEL_URL ?? process.env.API_PUBLICA_URL ?? (process.env.DOMINIO ? `https://${process.env.DOMINIO}` : 'https://aritana.wideic.com');
  return v.replace(/\/$/, '');
}
