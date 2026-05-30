# Установка Meta Instagram MCP

Эта инструкция описывает публично безопасный путь установки. Она не требует пароля Instagram и не использует скрейпинг: только официальный Meta OAuth и Graph API.

## Требования

- Node.js `>=20`.
- Meta Developer account.
- Instagram professional account.
- Meta App с подходящим OAuth flow.
- Локальный redirect URI, например `http://localhost:8787/callback`.

## 1. Установить зависимости

```bash
git clone <repo-url>
cd meta-instagram-mcp
npm install
cp .env.example .env
```

## 2. Выбрать OAuth mode

Для стандартного Meta App чаще всего используется Facebook Login:

```env
META_AUTH_MODE=facebook
META_INSTAGRAM_SCOPES=instagram_basic,pages_show_list,pages_read_engagement,instagram_manage_insights,instagram_manage_comments
```

Для отдельной конфигурации Instagram Login используйте:

```env
META_AUTH_MODE=instagram
META_INSTAGRAM_SCOPES=instagram_business_basic,instagram_business_manage_insights,instagram_business_manage_comments
```

Если появляется `Invalid platform app`, обычно выбран не тот OAuth mode или используется обычный Facebook App ID в Instagram Login URL. Для стандартного Meta App переключитесь на `META_AUTH_MODE=facebook`.

## 3. Заполнить `.env`

Минимальные значения:

```env
META_INSTAGRAM_APP_ID=<meta-app-id>
META_INSTAGRAM_APP_SECRET=<meta-app-secret>
META_INSTAGRAM_REDIRECT_URI=http://localhost:8787/callback
META_GRAPH_API_VERSION=v25.0
```

Не коммитьте `.env`. Он уже находится в `.gitignore`.

## 4. Настроить Meta Dashboard

Для `facebook` mode:

1. Добавьте продукт `Facebook Login`.
2. В `Facebook Login -> Settings` добавьте `META_INSTAGRAM_REDIRECT_URI` в valid OAuth redirect URIs.
3. Убедитесь, что у Facebook-пользователя есть доступ к нужному Instagram professional account.
4. Если нужен Page-linked flow, подключите Instagram professional account к Facebook Page.
5. Для production/чужих аккаунтов пройдите App Review / Advanced Access.

Для `instagram` mode нужен отдельный Instagram Login app/use case с собственными Instagram App ID и Instagram App Secret.

## 5. Собрать проект

```bash
npm run build
```

## 6. Пройти OAuth

```bash
npm run meta:callback
```

Откройте напечатанный URL, подтвердите доступ и дождитесь страницы:

```text
Meta token saved
```

Не копируйте callback URL после redirect: он содержит одноразовый OAuth `code`.

## 7. Сохранить Instagram user id

Если Meta выдала Page permissions:

```json
{"tool":"meta_resolve_instagram_account","arguments":{}}
```

Если Page permissions declined, но direct IG access работает:

```json
{"tool":"meta_resolve_instagram_account","arguments":{"userId":"<IG_USER_ID>"}}
```

После этого media/insights tools смогут использовать сохраненный IG user id из token-store.

## 8. Подключить к Codex

```bash
codex mcp add meta-instagram-local -- node /absolute/path/to/meta-instagram-mcp/dist/server.js
```

Проверить регистрацию:

```bash
codex mcp get meta-instagram-local
```

## 9. Проверить read-доступ

Используйте MCP tools:

```json
{"tool":"meta_auth_status","arguments":{}}
{"tool":"meta_get_account_info","arguments":{}}
{"tool":"meta_list_media","arguments":{"limit":5}}
{"tool":"meta_get_user_insights","arguments":{}}
```

Сырые токены, app secret, OAuth code и callback URL с `code=` не должны попадать в ответы, отчеты, логи или git.
