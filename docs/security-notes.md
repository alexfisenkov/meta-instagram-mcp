# Правила безопасности

Обновлено: 2026-05-30.

## Чувствительные локальные файлы

Эти файлы нельзя коммитить, вставлять в чат или копировать в документацию:

| Путь | Что содержит |
|---|---|
| `.env` | Реальный Meta App ID/Secret и локальные runtime-настройки. |
| `app secret.md.rtf` | Локальная копия app secret. |
| `~/.config/meta-instagram-mcp/token.json` | Long-lived access token и сохраненные IG account metadata. |

Token-store должен создаваться с правами `0600`.

## Значения, которые нельзя печатать

- `META_INSTAGRAM_APP_SECRET`.
- Raw `META_INSTAGRAM_ACCESS_TOKEN`.
- Raw long-lived token из token-store.
- OAuth callback URL после redirect, если он содержит `code=`.
- OAuth `code`.
- Browser cookies, local storage, password manager data или Chrome profile files.
- Полные raw API responses, если они содержат tokens, secrets, emails, private comments или другие чувствительные данные.

## Допустимая redacted metadata

Можно фиксировать в локальных отчетах и runbook:

- `authMode=facebook`;
- `tokenType=bearer`;
- token expiration timestamp, если это нужно операционно;
- account username только в локальных/private notes, не в публичных docs;
- признаки наличия token/userId/pageId;
- permission names и granted/declined status;
- counts и metric names;
- redacted ids вроде `1784...3343`.

## Риск ротации

Если app secret когда-либо попал в чат, docs, logs, screenshots или другое non-secret место, его нужно ротировать в Meta Dashboard:

1. Открыть Meta Developers app.
2. Rotate/regenerate app secret.
3. Обновить локальный `.env`.
4. Заново пройти OAuth, если Meta изменила поведение существующего token.
5. Повторить live smoke из `docs/operations-runbook.md`.
6. Обновить local/private handoff и verification notes.

## Правила логирования

- Любой новый CLI или smoke script должен показывать token state только как booleans или redacted fragments.
- Ошибки Meta должны проходить sanitization через `src/meta-client.ts`.
- Не добавлять debug logs, которые печатают request URL после добавления `access_token`.
- Не писать raw Graph API output в docs без review и redaction.

## Безопасность MCP tools

Текущий MCP спроектирован как read-only. Write-adjacent scopes могут быть в presets для будущего расширения, но write tools нельзя добавлять без:

1. Нового явного запроса.
2. Обновленных docs и security notes.
3. Отдельных tool names, явно показывающих write behavior.
4. Сильного подтверждения перед destructive или publishing actions.

## Безопасность браузера

При использовании Chrome для Meta OAuth:

- Можно открывать Meta Dashboard и OAuth consent pages.
- Не инспектировать cookies, local storage, passwords или Chrome profile files.
- Не копировать финальный redirected callback URL после OAuth, потому что он содержит `code=`.
- Если страница просит выдать account permissions, проверить intended account и scope перед подтверждением.
