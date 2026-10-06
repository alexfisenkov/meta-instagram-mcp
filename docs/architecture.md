# Meta Instagram MCP Architecture

## Source Of Truth

Канон проекта: официальный Meta OAuth и Instagram Graph API — основной программный источник. Для явно подключённого и авторизованного Chrome companion разрешены ограниченное semantic DOM-чтение Instagram UI и bounded scrolling через фиксированные операции; это отдельный источник API → browser → phone. Архитектура не использует парольный вход, перенос cookies/session, произвольные selectors, raw click/tap или arbitrary page script.

## Runtime

Одна factory сохраняет 18 legacy API tools и добавляет per-source reads, inbox triage/analysis и guarded action flow. Источники читаются API → browser → phone с ограниченным бюджетом и явным coverage/provenance. API auth/permission status, companion readiness и live account checks остаются отдельными доказательствами. Legacy media publish живёт отдельно от Direct/comments/phone/browser actions.

## OAuth modes

Проект поддерживает два официальных режима:

- `facebook` - основной режим для стандартного Meta App: Facebook Login выдает user token, дальше Instagram professional account резолвится либо через подключенную Facebook Page, либо direct IG user id, если Meta выдала Instagram access без Page scopes.
- `instagram` - альтернативный режим для отдельного Instagram Login-приложения с Instagram App ID/Secret.

`facebook` режим использует `graph.facebook.com`, а `instagram` режим использует `graph.instagram.com`. Для account/media/insights tools в `facebook` режиме нужен сохраненный Instagram user id; его заполняет `meta_resolve_instagram_account`.

## Слои

- `src/config.ts` читает настройки из окружения и локального `.env` в корне проекта.
- `src/token-store.ts` хранит long-lived token вне репозитория с правами `0600`.
- `src/oauth.ts` строит Instagram Login или Facebook Login URL, меняет `code` на long-lived token и обновляет long-lived token там, где это поддерживает выбранный режим.
- `src/callback-server.ts` поднимает локальный localhost callback для ручного OAuth consent и сохраняет long-lived token вне репозитория.
- `src/http-json.ts` — транспорт: JSON-запросы поверх `node:https` с запасными маршрутами,
  если системный DNS не отвечает (SNI и проверка сертификата сохраняются).
- `src/meta-client.ts` выполняет GET-запросы к выбранному Graph API base URL, ограничивает
  недоверенные path и query и нормализует ошибки Meta, вычищая из них access token.
- `src/tools.ts` содержит legacy API handlers без transport-логики; `src/api-provider.ts` подключает API Direct/comments/insights.
- `src/source-router.ts` маршрутизирует bounded reads API → browser → phone с per-source coverage/provenance; `src/layered-tools.ts` добавляет triage и host analysis.
- `src/runtime.ts` собирает legacy, layered and guarded mutation handlers один раз для stdio и Streamable HTTP; `src/server.ts` выбирает transport по `INSTAGRAM_MCP_TRANSPORT`.
- `src/companion-hub.ts` хранит durable browser/phone tasks и подписанный approval key; `src/companion/` содержит browser Native Host и phone companion adapters.
- `src/cli/auth-url.ts` печатает login URL для ручной авторизации.

## Безопасность

- API использует официальный Graph API; browser companion извлекает только поля фиксированных semantic operations из текущей авторизованной страницы и сообщает coverage/side effects. Это не гарантирует полноту UI, стабильность Instagram DOM или доступность непредоставленных Meta permissions.
- Парольный вход, перенос cookies/session, caller-supplied selectors, raw click/tap и произвольный page script запрещены.
- Токены не печатаются в MCP-ответах.
- Mutation tools используют source-specific gates, точный target/context, однократный audit attempt и per-request confirmation. UI writes дополнительно требуют свежий Hub-signed grant. Это кодовый guard, не доказательство live access или отправки.
- `meta_raw_get` не превращает сервер в произвольный HTTP-клиент: абсолютный URL принимается
  только для хостов `graph.facebook.com` и `graph.instagram.com`, любой другой отклоняется;
  зарезервированные query-параметры (`method`, `_method`, `access_token`) отклоняются независимо
  от того, переданы они объектом `query` или вшиты прямо в path. Проверка идёт по собранному
  URL до отправки, поэтому запрос и токен не уходят наружу.

## Runtime state

Реальное состояние авторизации хранится локально и не должно попадать в публичный git:

- `.env` содержит App ID/Secret и локальные настройки;
- `~/.config/meta-instagram-mcp/token.json` содержит long-lived token и сохраненный IG user id;
- локальные handoff/live-логи могут фиксировать текущий аккаунт, expiry и smoke evidence.

Если OAuth consent возвращает Page permissions как declined, `/me/accounts` может быть пустым. Это не обязательно означает сломанный token: direct IG user id path может продолжать работать для account/media/insights endpoints.
