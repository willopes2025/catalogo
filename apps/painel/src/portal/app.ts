import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { apiPortal } from './api';

/** Rodando dentro do app da Play Store / App Store (não no navegador). */
export const noApp = () => Capacitor.isNativePlatform();

/** O app Android só recebe notificações quando foi gerado com o Firebase (marca no navegador do app). */
const podeNotificar = () => Capacitor.getPlatform() === 'ios' || !/AritanaPush\/0/.test(navigator.userAgent);

const CHAVE_TOKEN = 'aritana.portal.push';
let ligado = false;

/**
 * Pede permissão para notificar e registra este celular para a representante logada.
 * Tocar na notificação abre a tela certa do portal. No navegador não faz nada.
 */
export async function ligarNotificacoes(abrir: (link: string) => void) {
  if (!noApp() || !podeNotificar() || ligado) return;
  ligado = true;
  try {
    await PushNotifications.addListener('registration', (t) => {
      try {
        localStorage.setItem(CHAVE_TOKEN, t.value);
      } catch {
        /* sem armazenamento: só não dá para avisar a saída */
      }
      void apiPortal('/dispositivos', { corpo: { token: t.value, plataforma: Capacitor.getPlatform() === 'ios' ? 'ios' : 'android' } }).catch(() => undefined);
    });
    await PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
      const link = String((a.notification.data as { link?: string } | undefined)?.link ?? '/portal');
      if (link.startsWith('/portal')) abrir(link);
    });
    let p = await PushNotifications.checkPermissions();
    if (p.receive === 'prompt' || p.receive === 'prompt-with-rationale') p = await PushNotifications.requestPermissions();
    if (p.receive === 'granted') await PushNotifications.register();
  } catch {
    ligado = false;
  }
}

/** Ao sair, este celular para de receber as notificações dela. */
export async function desligarNotificacoes() {
  if (!noApp()) return;
  let token: string | null = null;
  try {
    token = localStorage.getItem(CHAVE_TOKEN);
    localStorage.removeItem(CHAVE_TOKEN);
  } catch {
    token = null;
  }
  if (token) await apiPortal('/dispositivos/sair', { corpo: { token } }).catch(() => undefined);
}
