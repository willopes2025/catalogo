import type { CapacitorConfig } from '@capacitor/cli';
import { existsSync } from 'node:fs';

/**
 * App da representante: abre o portal da representante do sistema (o mesmo do navegador).
 * Atualizar o sistema na VPS já atualiza o app; só é preciso publicar de novo nas lojas
 * quando mudar ícone, nome, permissões ou plugins.
 *
 * APP_URL muda o endereço (ex.: homologação). O ID do app não pode mudar depois de publicado.
 */
const url = process.env.APP_URL ?? 'https://aritana.wideic.com/portal';

// Sem o google-services.json o Android fecha o app ao registrar notificações.
// O portal lê esta marca no navegador do app e só registra quando o Firebase está no app.
const firebase = existsSync('android/app/google-services.json'); // caminho relativo: o cap roda dentro de app-representante

// O mesmo projeto gera também o app da equipe ("Aritana Gestão", sistema inteiro): APP_URL e APP_NOME mudam
// no GitHub Actions (workflow app-equipe.yml), que troca também o ID do Android para br.com.aritanaonline.gestao.
const config: CapacitorConfig = {
  appId: process.env.APP_ID ?? 'br.com.aritanaonline.representante',
  appName: process.env.APP_NOME ?? 'Aritana',
  webDir: 'www',
  server: {
    url,
    // Só o próprio sistema abre dentro do app; WhatsApp, Meet e outros sites abrem fora.
    allowNavigation: [new URL(url).host],
    errorPath: 'sem-internet.html',
  },
  android: { allowMixedContent: false, appendUserAgent: `AritanaApp AritanaPush/${firebase ? 1 : 0}` },
  ios: { contentInset: 'automatic', appendUserAgent: 'AritanaApp AritanaPush/1' },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
