# App da representante: como publicar

O app abre o portal da representante (`https://aritana.wideic.com/portal`) e recebe notificações.
Atualizar o sistema na VPS já atualiza o app. Só é preciso publicar de novo nas lojas quando mudar
ícone, nome, permissões ou plugins.

- **ID do app:** `br.com.aritanaonline.representante` (não pode mudar depois de publicado)
- **Nome:** Aritana
- **Política de privacidade:** `https://aritana.wideic.com/privacidade` (revise o texto antes de publicar)
- **Excluir conta / dados:** `https://aritana.wideic.com/privacidade#excluir`

Nada de chave, senha ou arquivo do Firebase vai para o repositório (ele é público). Tudo fica nos
**segredos do GitHub** (Settings › Secrets and variables › Actions) ou na tela Integrações do sistema.

---

## O que a Aritana precisa ter

| Item | Onde | Custo |
| --- | --- | --- |
| Conta Google Play Console (empresa) | play.google.com/console | US$ 25, uma vez |
| Conta Apple Developer (empresa, com D-U-N-S) | developer.apple.com | US$ 99 por ano |
| Projeto no Firebase | console.firebase.google.com | grátis |
| Um Mac com Xcode (só para enviar à App Store) | — | — |

---

## 1. Firebase (notificações no Android)

1. Crie o projeto "Aritana" no Firebase.
2. Adicione um app **Android** com o pacote `br.com.aritanaonline.representante` e baixe o `google-services.json`.
3. No GitHub, crie o segredo `GOOGLE_SERVICES_JSON` e cole o conteúdo inteiro do arquivo.
4. Em Configurações do projeto › Contas de serviço › **Gerar nova chave privada**: baixa um `.json`.
   No sistema, em Configurações › Integrações › **Notificações do app da representante**, cole o conteúdo
   inteiro no campo "Firebase: conta de serviço".

## 2. Apple (notificações no iPhone)

1. Em developer.apple.com › Certificates, IDs & Profiles › Identifiers, crie o App ID
   `br.com.aritanaonline.representante` com **Push Notifications** marcado.
2. Em Keys, crie uma chave com **Apple Push Notifications service (APNs)** e baixe o `.p8` (só baixa uma vez).
3. No sistema, em Integrações › Notificações do app, cole o conteúdo do `.p8`, o **Key ID** e o **Team ID**
   (canto superior direito da conta Apple). Ambiente: Produção.

O iPhone recebe direto da Apple, sem o Firebase.

## 3. Android: gerar e publicar

### Chave de assinatura (uma vez só, guarde muito bem)

Sem esse arquivo e as senhas, **não dá para atualizar o app** na Play Store.

```bash
keytool -genkeypair -v -keystore aritana.keystore -alias aritana -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 aritana.keystore > aritana.keystore.b64
```

No GitHub, crie os segredos:

- `ANDROID_KEYSTORE_BASE64`: conteúdo do `aritana.keystore.b64`
- `ANDROID_KEYSTORE_SENHA`: senha do keystore
- `ANDROID_CHAVE_ALIAS`: `aritana`
- `ANDROID_CHAVE_SENHA`: senha da chave

Guarde o `aritana.keystore` e as senhas fora do computador (cofre de senhas da empresa).

### Gerar

No GitHub: **Actions › App da representante › Run workflow**. Ao terminar, em "Artifacts":

- `aritana-teste-apk`: instala direto no Android para testar (permitir "fontes desconhecidas").
- `aritana-play-store-aab`: o arquivo para enviar à Play Store (só aparece com os segredos da chave).

### Publicar

1. Play Console › Criar app › nome "Aritana", app, gratuito.
2. Preencha: política de privacidade (link acima), acesso ao app (o app exige login: informe um acesso
   de teste de representante para a revisão do Google), classificação de conteúdo, público-alvo (adultos),
   segurança dos dados (o app usa nome, telefone, e-mail e identificador do aparelho para notificações;
   não vende dados; dá para pedir exclusão).
3. Teste interno › Criar versão › envie o `.aab`. Ative a **Assinatura de apps do Google Play**.
4. Contas pessoais novas precisam de teste fechado com 12 pessoas por 14 dias; conta de **empresa** não.
5. Depois do teste, promova para Produção.

Cada nova versão para a loja: aumente `versionCode` e `versionName` em `android/app/build.gradle`.

## 4. iPhone: gerar e publicar

O GitHub só confere que o app compila. O envio à App Store é feito num Mac:

```bash
cd app-representante
npm ci
npx cap sync ios
npx cap open ios
```

No Xcode:

1. Target **App** › Signing & Capabilities: escolha o time da Aritana. Confira que aparecem
   **Push Notifications** e **Background Modes › Remote notifications**.
2. Product › Archive › Distribute App › App Store Connect.
3. No App Store Connect: crie o app com o mesmo ID, preencha privacidade, capturas de tela (iPhone 6,7"
   e 6,5"), descrição, e em "Informações para revisão" um acesso de teste de representante.
4. Teste pelo TestFlight e envie para revisão.

Cada nova versão: aumente Version e Build no Xcode.

### Atenção na revisão da Apple

A Apple recusa apps que são "só um site dentro de um app" (regra 4.2). O que pesa a favor:
notificações, área restrita para representantes, uso de trabalho. Na nota para o revisor, explique
que é a ferramenta de trabalho das representantes da Aritana (maleta, pedidos, clientes, agenda,
comissões) e que avisa no celular. Se mesmo assim recusar, a alternativa é distribuir pelo
**Apple Business Manager** (app personalizado, só para a empresa).

## 5. Ícone e tela de abertura

Os arquivos ficam em `assets/` (`icon.png` 1024×1024, `splash.png` 2732×2732). Para trocar:

```bash
npx @capacitor/assets generate --iconBackgroundColor '#4e3f34' --splashBackgroundColor '#4e3f34'
```

O ícone atual foi ampliado de 512 px: para a loja, o ideal é a Aritana mandar o logo em 1024 px.

## 6. Testar apontando para outro endereço

```bash
APP_URL=https://homologacao.exemplo.com/portal npx cap sync
```
