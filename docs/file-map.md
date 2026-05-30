# Карта проекта

Обновлено: 2026-05-30.

## Как читать репозиторий

Для публичного и переиспользуемого контекста начинайте с этих файлов:

1. `README.md` - обзор, быстрый старт, список tools, граница public/private.
2. `docs/install.md` - установка с нуля и OAuth setup.
3. `docs/operations-runbook.md` - команды и процедуры для auth, smoke checks, token refresh.
4. `docs/architecture.md` - устройство системы и OAuth modes.
5. `docs/meta-setup.md` - Meta Dashboard и OAuth setup notes.
6. `src/server.ts` и `src/tools.ts` - MCP surface и поведение tools.
7. `queries/README.md` - локальный формат сохраненных Instagram-запросов и отчетов.

Не начинайте с browser history, screenshots или старого chat context, если эти файлы отвечают на вопрос. Account-specific handoff/evidence files остаются local-only и игнорируются git.

## Корневые файлы

| Путь | Назначение | Когда смотреть |
|---|---|---|
| `README.md` | Пользовательский обзор, быстрый старт, список tools, public/private boundaries. | Объяснить проект или онбордить оператора. |
| `.env.example` | Безопасный шаблон локального config. | Добавить или изменить config keys без раскрытия секретов. |
| `.env` | Реальный локальный config с app id/secret и runtime settings. Игнорируется git. | Только для локальной auth/config диагностики; значения не печатать. |
| `app secret.md.rtf` | Локальный secret file. Игнорируется git. | Не использовать без явной задачи на ротацию или восстановление config. Никогда не печатать. |
| `.gitignore` | Не пускает secrets, local reports, screenshots, `node_modules` и `dist` в git. | Добавляются новые локальные артефакты. |
| `package.json` | Scripts, package metadata, dependencies. | Проверить команды и SDK versions. |
| `package-lock.json` | Зафиксированный npm dependency graph. | Воспроизводимая установка или debug dependency drift. |
| `tsconfig.json` | TypeScript config для source/tests. | Type-check behavior или module resolution. |
| `tsconfig.build.json` | Build-specific TypeScript config. | Настройка build-only TypeScript behavior. |

## Docs

| Путь | Назначение | Заметки |
|---|---|---|
| `docs/install.md` | Установка с нуля и OAuth setup. | Для новой машины или GitHub onboarding. |
| `docs/architecture.md` | Architecture, OAuth modes, security boundaries, runtime state. | Первый файл перед изменением слоев. |
| `docs/meta-setup.md` | Meta Dashboard setup и OAuth notes. | Диагностика `Invalid platform app` и direct-user-id fallback. |
| `docs/operations-runbook.md` | Операционные команды для checks, OAuth re-auth, token refresh, common failures. | Когда нужно понять, как запустить или проверить сейчас. |
| `docs/security-notes.md` | Правила secret handling, rotation и logging. | Перед работой с `.env`, token-store, app secret или browser auth. |
| `docs/file-map.md` | Этот файл. | Быстро найти нужную зону проекта. |
| `docs/verification-log.md` | Local/private redacted proof live OAuth/Graph checks. Игнорируется git. | Evidence history, не fresh proof. |
| `docs/implementation-log.md` | Local/private chronological engineering log. Игнорируется git. | Понять историю решений. |

## Архив запросов

| Путь | Назначение | Когда смотреть |
|---|---|---|
| `queries/README.md` | Индекс и правила для сохраненных Instagram analytics-запросов. | Когда нужно начать или найти аналитический запрос. |
| `queries/YYYY-MM-DD-short-slug/query.md` | Локальный исходный вопрос пользователя и дата запуска. Игнорируется git. | Когда нужно проверить точную формулировку вопроса. |
| `queries/YYYY-MM-DD-short-slug/report.md` | Локальный отчет с методикой, ограничениями, выводами и цифрами. Игнорируется git. | Когда нужно посмотреть ответ и доказательства. |

## Исходный код

| Путь | Слой | Назначение |
|---|---|---|
| `src/config.ts` | Config | Читает `.env`/environment, парсит auth mode/scopes, находит token store path, редактирует tokens. |
| `src/token-store.ts` | Local secret storage | Загружает/сохраняет long-lived token JSON вне repo с правами `0600`. |
| `src/oauth.ts` | OAuth domain | Строит Instagram/Facebook login URLs, меняет auth code на long-lived token, refreshes token, задает scope presets. |
| `src/callback-server.ts` | Local OAuth helper | Стартует localhost callback, обрабатывает Meta redirect, меняет `code`, сохраняет token. |
| `src/meta-client.ts` | Graph HTTP client | Выполняет safe relative-path GETs, добавляет access token, нормализует Meta API errors без раскрытия token. |
| `src/tools.ts` | MCP use cases | Реализует handlers: auth status, login URL, exchange/refresh, account/media/comments/insights, page list, account resolver, raw GET. |
| `src/server.ts` | MCP transport | Регистрирует MCP tools со schemas/annotations и запускает stdio transport. |
| `src/cli/auth-url.ts` | CLI helper | Печатает текущий OAuth login URL из local config. |
| `src/cli/callback.ts` | CLI helper | Запускает localhost OAuth callback server. |

## Tool surface

MCP exposes 16 tools:

| Tool | Назначение |
|---|---|
| `meta_auth_status` | Показывает config и redacted token metadata. |
| `meta_scope_presets` | Показывает OAuth scope presets для текущего auth mode. |
| `meta_build_login_url` | Строит официальный OAuth login URL. |
| `meta_exchange_code` | Меняет OAuth code на long-lived token и опционально сохраняет. |
| `meta_refresh_token` | Обновляет текущий long-lived token и опционально сохраняет. |
| `meta_list_facebook_pages` | Показывает Pages, доступные Facebook token. |
| `meta_resolve_instagram_account` | Сохраняет IG user id из Page-linked account или direct `userId`. |
| `meta_get_account_info` | Читает account metadata. |
| `meta_list_media` | Читает media list. |
| `meta_get_media` | Читает один media object. |
| `meta_get_top_media` | Читает recent media и локально ранжирует по engagement/likes/comments/timestamp. |
| `meta_get_user_insights` | Читает account-level insights. |
| `meta_get_post_insights` | Читает media-level insights. |
| `meta_list_comments` | Читает comments для media object. |
| `meta_get_comment_replies` | Читает replies для comment. |
| `meta_raw_get` | Read-only Graph GET для relative paths. |

## Tests

| Путь | Что покрывает |
|---|---|
| `tests/config.test.ts` | Config parsing, scope parsing, token redaction. |
| `tests/token-store.test.ts` | Token store write/read behavior and file mode. |
| `tests/oauth.test.ts` | Instagram and Facebook OAuth URL/exchange/refresh logic. |
| `tests/meta-client.test.ts` | Graph URL construction and token-safe error normalization. |
| `tests/callback-server.test.ts` | Callback parsing and redacted callback HTML rendering. |
| `tests/tools.test.ts` | Tool handlers, Facebook Login URL, account resolver, safe defaults, ranking. |

Текущее ограничение: Vitest и `tsc --noEmit` зависали в этой локальной среде. Не сообщать, что они проходят, пока они не будут запущены заново и не завершатся успешно.

## Scripts и generated files

| Путь | Назначение |
|---|---|
| `scripts/build.mjs` | esbuild-based build for `src/**/*.ts` into `dist/`. |
| `dist/` | Generated runtime output used by `meta-instagram-local`. Ignored by git. |
| `node_modules/` | Installed npm dependencies. Ignored by git. |

## Runtime state вне repo

| Путь/имя | Назначение | Безопасность |
|---|---|---|
| `~/.config/meta-instagram-mcp/token.json` | Long-lived Meta token и saved IG metadata. | Sensitive. Не печатать и не коммитить. |
| `meta-instagram-local` | Codex MCP registration. | Проверить через `codex mcp get meta-instagram-local`. |
| Local/private handoff и verification notes | Current account, token expiry, live smoke evidence. | Не публиковать в git. |

## Частые вопросы

### Где проверить, что работает?

Используйте `docs/operations-runbook.md` -> "Проверить текущий доступ" и "Live read smoke".

### Где обновлять текущую правду?

Сначала обновить local/private handoff, затем local verification notes, затем chronological detail, если проект ведет такой файл.

### Где добавить новый MCP read tool?

1. Implement handler logic in `src/tools.ts`.
2. Register schema in `src/server.ts`.
3. Add focused tests in `tests/tools.test.ts` or a more specific test file.
4. Обновить `README.md`, `docs/file-map.md` и local implementation notes, если они есть.

### Где debug OAuth?

Начать с `docs/meta-setup.md`, затем смотреть `src/oauth.ts` и `src/callback-server.ts`.

### Где debug Meta API errors?

Начать с `src/meta-client.ts` для error shape и token redaction, затем использовать `meta_raw_get` только с relative Graph paths.
