# Правила безопасности

Обновлено: 2026-05-30.

## Чувствительные локальные файлы

Эти файлы нельзя коммитить, вставлять в чат или копировать в документацию:

| Путь | Что содержит |
|---|---|
| `.env` | Реальный Meta App ID/Secret и локальные runtime-настройки. |
| `app secret.md.rtf` | Локальная копия app secret. |
| `~/.config/meta-instagram-mcp/token.json` | Long-lived access token и сохраненные IG account metadata. На POSIX файл ограничен режимом `0600`; на Windows применяется защищённый NTFS DACL только для текущего пользователя, SYSTEM и локальных администраторов. |

Token-store должен быть приватным: режим `0600` на POSIX; защищённый NTFS DACL на Windows. Windows mode bits не подтверждают приватность, поэтому приложение проверяет ACL и отказывает при неразрешённых allow-правилах.

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

Чтение в этом MCP свободно, запись - нет. Write tools нельзя добавлять без:

1. Нового явного запроса.
2. Обновленных docs и security notes.
3. Отдельных tool names, явно показывающих write behavior.
4. Сильного подтверждения перед destructive или publishing actions.

Единственная запись сегодня - публикация (08.09.2026), и все четыре условия у нее выполнены:

- `meta_create_media_container` создает контейнер публикации. В профиле он ничего не показывает и истекает сам, если его не опубликовать, - это сухой прогон, поэтому дополнительного подтверждения он не требует.
- `meta_publish_media` делает пост видимым и необратим из этого MCP. Требует `META_INSTAGRAM_WRITE=true` в окружении процесса (решение о среде) и `confirm: true` в вызове (решение о конкретном посте). Оба предохранителя проверяются до обращения к сети; без любого из них инструмент отказывает и ничего не публикует.
- Каждая попытка публикации пишется в журнал `publish-log.jsonl` рядом с token-store: `attempt` до вызова Meta, затем `published` или `failed`. Если журнал не пишется, публикация не начинается.
- `MetaClient.post` сохраняет защиты read-пути: зарезервированные ключи (`method`/`_method`/`access_token`) отклоняются и из тела, и из `path`, абсолютные адреса - только на Graph-хосты, токен вычищается из текста ошибок. Параметры едут телом, а не в строке запроса, чтобы `access_token` не осел в журналах прокси.
- Развертывание по умолчанию остается read-only: без `META_INSTAGRAM_WRITE` в окружении публикация выключена.

## Безопасность браузера

При использовании Chrome для Meta OAuth:

- Можно открывать Meta Dashboard и OAuth consent pages.
- Не инспектировать cookies, local storage, passwords или Chrome profile files.
- Не копировать финальный redirected callback URL после OAuth, потому что он содержит `code=`.
- Если страница просит выдать account permissions, проверить intended account и scope перед подтверждением.
