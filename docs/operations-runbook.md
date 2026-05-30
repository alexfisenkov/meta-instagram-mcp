# Операционный runbook

Обновлено: 2026-05-30.

## Правила

- Использовать только официальный Meta OAuth и Graph API.
- Держать MCP read-only, пока отдельная будущая задача явно не добавит write tools.
- Не печатать raw access tokens, app secrets, OAuth codes, callback URLs с `code=`, cookies или browser storage.
- Считать `.env`, `app secret.md.rtf` и `~/.config/meta-instagram-mcp/token.json` чувствительными локальными файлами.
- Хранить live evidence и account-specific notes в local/private files, не в публичном репозитории.

## Проверить текущий доступ

```bash
cd /absolute/path/to/meta-instagram-mcp
npm run build
codex mcp get meta-instagram-local
```

Запустить redacted token metadata check:

```bash
node --input-type=module - <<'NODE'
import { loadConfig } from './dist/config.js';
import { loadStoredToken } from './dist/token-store.js';
const config = loadConfig();
const token = await loadStoredToken(config.tokenStorePath);
console.log(JSON.stringify({
  authMode: token?.authMode,
  tokenType: token?.tokenType,
  hasAccessToken: Boolean(token?.accessToken),
  expiresAt: token?.expiresAt,
  hasUserId: Boolean(token?.userId),
  username: token?.username,
  hasPageId: Boolean(token?.pageId),
}, null, 2));
NODE
```

Ожидаемая форма:

```json
{
  "authMode": "facebook",
  "tokenType": "bearer",
  "hasAccessToken": true,
  "hasUserId": true,
  "username": "<your_username>"
}
```

## Live read smoke

Используйте это, чтобы подтвердить, что MCP читает реальные Meta data без раскрытия секретов:

```bash
node --input-type=module - <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['/absolute/path/to/meta-instagram-mcp/dist/server.js'],
});
const client = new Client({ name: 'manual-smoke-client', version: '0.0.1' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const account = await client.callTool({ name: 'meta_get_account_info', arguments: {} });
  const accountJson = JSON.parse(account.content?.[0]?.text ?? '{}');
  const media = await client.callTool({ name: 'meta_list_media', arguments: { limit: 2 } });
  const mediaJson = JSON.parse(media.content?.[0]?.text ?? '{}');
  const insights = await client.callTool({ name: 'meta_get_user_insights', arguments: {} });
  const insightsJson = JSON.parse(insights.content?.[0]?.text ?? '{}');

  console.log(JSON.stringify({
    toolCount: tools.tools.length,
    account: {
      username: accountJson.username,
      followersCountPresent: typeof accountJson.followers_count === 'number',
      mediaCountPresent: typeof accountJson.media_count === 'number',
    },
    media: {
      count: Array.isArray(mediaJson.data) ? mediaJson.data.length : 0,
      hasPaging: Boolean(mediaJson.paging),
    },
    userInsights: {
      count: Array.isArray(insightsJson.data) ? insightsJson.data.length : 0,
      metrics: Array.isArray(insightsJson.data) ? insightsJson.data.map((metric) => metric.name) : [],
    },
  }, null, 2));
} finally {
  await client.close();
}
NODE
```

Ожидаемая форма:

```json
{
  "toolCount": 16,
  "account": {
    "username": "<your_username>",
    "followersCountPresent": true,
    "mediaCountPresent": true
  },
  "media": {
    "count": 2,
    "hasPaging": true
  },
  "userInsights": {
    "count": 1,
    "metrics": ["reach"]
  }
}
```

## Повторный OAuth

Используйте только если token отсутствует, expired, revoked или scopes нужно запросить заново:

```bash
cd /absolute/path/to/meta-instagram-mcp
npm run build
npm run meta:callback
```

Откройте напечатанный Login URL в Chrome и пройдите consent. Callback должен прийти на страницу:

```text
Meta token saved
```

Не копируйте полный callback URL после redirect, потому что он содержит `code=`.

После OAuth сохраните IG account:

```bash
# Если Page scopes granted:
# call MCP tool meta_resolve_instagram_account with {}

# Если Page scopes declined, но direct IG access работает:
# call MCP tool meta_resolve_instagram_account with {"userId":"<IG_USER_ID>"}
```

## Обновить token

Обновляйте long-lived tokens до expiration:

```json
{"tool":"meta_refresh_token","arguments":{"save":true}}
```

После этого повторите live read smoke и обновите local/private handoff notes с новой expiration date.

## Если `/me/accounts` пустой

Проверьте permission metadata через `meta_auth_status`. Если Meta вернула:

```text
pages_show_list=declined
pages_read_engagement=declined
```

Не считайте token сломанным, если direct account/media/insights продолжают работать. Используйте direct IG user-id resolve.

## Если появляется `Invalid platform app`

Обычно это означает, что URL использует Instagram Login со стандартным Facebook app id. Для стандартного Meta App используйте:

```text
META_AUTH_MODE=facebook
https://www.facebook.com/v25.0/dialog/oauth
```

Не используйте `https://www.instagram.com/oauth/authorize`, если нет отдельной Instagram Login app configuration.
