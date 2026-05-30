# Meta Instagram MCP Architecture

## Source Of Truth

Канон проекта: официальный Meta OAuth, Instagram Graph API и MCP TypeScript SDK. Скрейпинг, парольный логин и обход браузерного UI не входят в архитектуру.

## Цель MVP

Сделать персональный локальный MCP-сервер для read-only доступа к официальному Instagram API:

- собрать account info;
- получить media list;
- получить user insights;
- получить post/media insights;
- получить комментарии и ответы для анализа реакции аудитории;
- быстро ранжировать последние media по вовлечению;
- дать raw read-only GET для разрешенных Meta endpoints;
- не хранить секреты в коде и не выводить токены в ответы MCP.

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
- `src/meta-client.ts` выполняет GET-запросы к выбранному Graph API base URL и нормализует ошибки Meta.
- `src/tools.ts` содержит обработчики MCP tools без transport-логики.
- `src/server.ts` регистрирует MCP tools и запускает stdio transport.
- `src/cli/auth-url.ts` печатает login URL для ручной авторизации.

## Безопасность

- Скрейпинг, парольный логин и обход UI Instagram не используются.
- Токены не печатаются в MCP-ответах.
- Write-инструментов нет в MVP, даже если OAuth scope preset может запросить будущие publish/messages permissions.
- `meta_raw_get` принимает только относительный path, чтобы не превратить сервер в произвольный HTTP-клиент.

## Runtime state

Реальное состояние авторизации хранится локально и не должно попадать в публичный git:

- `.env` содержит App ID/Secret и локальные настройки;
- `~/.config/meta-instagram-mcp/token.json` содержит long-lived token и сохраненный IG user id;
- локальные handoff/live-логи могут фиксировать текущий аккаунт, expiry и smoke evidence.

Если OAuth consent возвращает Page permissions как declined, `/me/accounts` может быть пустым. Это не обязательно означает сломанный token: direct IG user id path может продолжать работать для account/media/insights endpoints.
