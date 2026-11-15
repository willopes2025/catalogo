import type { CapacitorConfig } from '@capacitor/cli';

/**
 * App da representante: abre o portal da representante do sistema (o mesmo do navegador).
 * Atualizar o sistema na VPS já atualiza o app; só é preciso publicar de novo nas lojas
 * quando mudar ícone, nome, permissões ou plugins.
 *
 * APP_URL muda o endereço (ex.: homologação). O ID do app não pode mudar depois de publicado.
 */
const url = process.env.APP_URL ?? 'https://aritana.wideic.com/portal';

const config: CapacitorConfig = {
  appId: 'br.com.aritanaonline.representante',
  appName: 'Aritana',
  webDir: 'www',
  server: {
    url,
    // Só o próprio sistema abre dentro do app; WhatsApp, Meet e outros sites abrem fora.
    allowNavigation: [new URL(url).host],
    errorPath: 'sem-internet.html',
  },
  android: { allowMixedContent: false },
  ios: { contentInset: 'automatic' },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
