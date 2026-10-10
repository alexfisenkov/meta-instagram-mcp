# Карта проекта

Обновлено: 2026-10-10.

## Как читать репозиторий

Для публичного и переиспользуемого контекста начинайте с этих файлов:

1. `README.md` - обзор, быстрый старт, список tools, граница public/private.
2. `docs/install.md` - установка, OAuth setup, stdio/HTTP и remote proxy.
3. `docs/operations-runbook.md` - текущая диагностика инструментов, readiness и Direct read.
4. `docs/ios-appium-operator-runbook.md` - подключение optional iPhone companion через Appium/WDA.
5. `docs/architecture.md` - устройство системы и OAuth modes.
6. `docs/meta-setup.md` - Meta Dashboard и OAuth setup notes.
7. `src/server.ts` и `src/tools.ts` - MCP surface и поведение tools.
8. `queries/README.md` - локальный формат сохраненных Instagram-запросов и отчетов.

Не начинайте с browser history, screenshots или старого chat context, если эти файлы отвечают на вопрос. Account-specific handoff/evidence files остаются local-only и игнорируются git.

## Корневые файлы

| Путь | Назначение | Когда смотреть |
|---|---|---|
| `README.md` | Пользовательский обзор, быстрый старт, список tools, public/private boundaries. | Объяснить проект или онбордить оператора. |
| `.env.example` | Публичный шаблон OAuth, transport, Hub, companion, webhook и Graph tuning keys. External wrapper принимает только явный whitelist. | Добавить или изменить config keys без раскрытия секретов. |
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
| `docs/ios-appium-operator-runbook.md` | Операторская инструкция для optional iPhone/Appium companion. | Когда phone source нужен для чтения Instagram UI. |
| `docs/architecture.md` | Architecture, OAuth modes, security boundaries, runtime state. | Первый файл перед изменением слоев. |
| `docs/meta-setup.md` | Meta Dashboard setup и OAuth notes. | Диагностика `Invalid platform app` и direct-user-id fallback. |
| `docs/operations-runbook.md` | Текущая диагностика MCP, API/browser/phone readiness, Direct read и remote proxy. | Когда нужно понять, как проверить доступ сейчас. |
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
| `src/read-context.ts` | Read execution context | Carries an advisory provider deadline/signal; underlying cancellation is operation-specific (currently Direct triage and companion queue reads). |
| `src/private-fs.ts` | Local storage safety | Создаёт и проверяет приватные файлы/каталоги по POSIX mode или защищённому Windows DACL; выполняет path-containment проверки средствами текущей ОС. |
| `src/token-store.ts` | Local secret storage | Загружает/сохраняет long-lived token JSON вне repo с приватными POSIX mode или Windows ACL. |
| `src/oauth.ts` | OAuth domain | Строит Instagram/Facebook login URLs, меняет auth code на long-lived token, refreshes token, задает scope presets. |
| `src/callback-server.ts` | Local OAuth helper | Стартует localhost callback, обрабатывает Meta redirect, меняет `code`, сохраняет token. |
| `src/http-json.ts` | HTTP-транспорт поверх node:https с запасными маршрутами | Правка сетевого слоя, отладка отказов DNS, отмена активного read-only запроса без запуска следующего маршрута. |
| `src/meta-client.ts` | Graph HTTP client | Выполняет safe relative-path GETs, добавляет access token, нормализует Meta API errors без раскрытия token, прокидывает read cancellation signal. |
| `src/tools.ts` | Legacy API use cases | Реализует auth, account/media/comments/insights, page list, resolver, raw GET и legacy publish handlers. |
| `src/api-provider.ts`, `src/direct.ts`, `src/comments.ts` | API provider/domain | Per-operation Meta permission status, Direct conversations/messages and comment/reply operations; bounded API triage cancellation preserves unread rows as unknown. |
| `src/source-router.ts`, `src/layered-tools.ts` | Layered reads and analysis | One shared API → browser → phone read deadline, fallback reserve, provider cancellation context, coverage/provenance, inbox triage/read and selected-observation host analysis. |
| `src/runtime.ts`, `src/mcp-server.ts`, `src/server.ts` | Runtime composition and transports | Shared runtime factory for legacy + layered + mutation tools; stdio or Streamable HTTP selected by config. |
| `src/companion-hub.ts`, `src/companion/`, `browser-extension/`, `native-host/` | Browser/phone companions | Durable task bridge, browser Native Host/extension and phone Appium companion. Graceful close stops polling and drains admitted work/receipt attempts before transport or Appium teardown; rejected read receipts may be redelivered. Expired queued/leased reads are canceled in the Hub. Presence in checkout does not prove registered/live devices. |
| `src/cli/auth-url.ts` | CLI helper | Печатает текущий OAuth login URL из local config. |
| `src/cli/callback.ts` | CLI helper | Запускает localhost OAuth callback server. |

## Tool surface

Legacy API tools remain available alongside layered and mutation tools from the shared runtime factory. Exact names are listed from the running server/doctor because availability is separate from per-source readiness.

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
| `meta_create_media_container`, `meta_publish_media` | Legacy two-step media publishing; publishing has a separate confirmation and environment gate. |
| `meta_capabilities`, `meta_read_source`, `meta_triage_inbox`, `meta_read_inbox`, `meta_analyze_inbox` | Runtime capability status, bounded source reads, inbox review and selected-observation analysis. |
| `meta_begin_oauth` | Prepares configured OAuth authorization using the runtime's state-bound flow. |
| `meta_prepare_action`, `meta_execute_action` | Source-bound preview and confirmed one-shot action flow; UI actions additionally require Hub-signed grant. |

## Tests

| Путь | Что покрывает |
|---|---|
| `tests/config.test.ts` | Config parsing, scope parsing, token redaction. |
| `tests/token-store.test.ts` | Token store write/read behavior and file mode. |
| `tests/oauth.test.ts` | Instagram and Facebook OAuth URL/exchange/refresh logic. |
| `tests/meta-client.test.ts` | Graph URL construction and token-safe error normalization. |
| `tests/http-json.test.ts`, `tests/account-context.test.ts` | Active read cancellation stops HTTPS route retries and reaches Facebook Page/permission lookup. |
| `tests/callback-server.test.ts` | Callback parsing and redacted callback HTML rendering. |
| `tests/api-provider.test.ts`, `tests/direct.test.ts` | Direct triage cancellation stops later message GETs, threads signal through repeated context resolution, and preserves remaining conversations as unknown. |
| `tests/tools.test.ts` | Tool handlers, Facebook Login URL, account resolver, safe defaults, ranking. |
| `tests/source-router.test.ts`, `tests/layered-tools.test.ts`, `tests/runtime-integration.test.ts` | Shared source deadlines and context, triage cancellation/fallback, coverage/analysis contracts and runtime read receipts. |
| `tests/direct.test.ts`, `tests/api-provider.test.ts`, `tests/meta-client.test.ts`, `tests/http-json.test.ts` | Direct API triage stops after cancellation, preserves unknown conversations and cancels in-flight HTTP without route retry. Other Graph GET domains use an advisory context and do not claim transport cancellation. |
| `tests/companion-hub.test.ts`, `tests/companion-source-provider.test.ts` | Hub cancellation is limited to queued/leased read tasks; companion queue exits on abort/deadline and stops polling. |
| `tests/browser-native-host.test.ts`, `browser-extension/tests/service-worker.test.ts`, `tests/companion-phone.test.ts` | Browser receipts may safely redeliver reads after rejection; expired browser/phone UI reads do not start after task expiry. |
| `browser-extension/tests/content-script.test.ts` | Own-profile account verification requires the observed unique avatar control, verified Edit profile marker, same-tab restoration and stable identity on subsequent reads. |
| `tools/test-installer.mjs` | Portable install/update/rollback fixture and external config wrapper smoke. |
| `tools/test-native-registration.mjs` | Native Messaging manifest, launcher and registry staging fixtures without changing the user's browser registration. |

Состояние проверок зависит от текущего run. Перед отчетом запускайте существующие package scripts; scoped fixture PASS не доказывает полный suite/build, live Meta access или companion readiness.

## Scripts и generated files

| Путь | Назначение |
|---|---|
| `scripts/build.mjs` | esbuild-based build for `src/**/*.ts` into `dist/`. |
| `tools/run.mjs` | Portable MCP wrapper. Loads a private external `.env`, applies explicit variable allowlist and starts the shared runtime. |
| `tools/test-remote-entrypoint.mjs` | Native Node fixture for local/remote stdio selection and fail-closed remote startup. |
| `tools/test-installer.mjs` | Portable install/update/rollback fixture, wrapper config handoff and doctor redaction checks. |
| `tools/register-native-host.mjs` | Per-user Chrome Native Messaging manifest/launcher registration with exact-origin and existing-owner conflict guards. |
| `tools/test-native-registration.mjs` | Isolated macOS/Linux/Windows registration staging fixtures. |
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

Используйте `docs/operations-runbook.md` -> «Локально проверить установленный MCP» и «Получить Direct из доступного источника».

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
