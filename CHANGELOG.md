# Changelog

## 0.3.0 — hosted student connections (not yet released)

- YouTube metadata context и проверка учитывают точные 5000 байт UTF‑8 описания, 100 Unicode characters заголовка и запрет `<`/`>` в обоих полях. Pinterest title bound передаётся из provider context. Опциональный явный `containsSyntheticMedia` закреплён в hash и передаётся провайдеру без вывода о содержимом видео; дополнительный независимый fixture проверяет явное значение.

- Исправления ревью видеопубликатора: явный YouTube categoryId закреплён в options/hash/metadata; добавлен точный официальный региональный TikTok upload host. Восстановление Pinterest берёт байты по checkpoint, а известные YouTube/TikTok операции сначала сверяются у провайдера — истёкшая source lease не блокирует уже завершённую передачу. Неизвестная финальная публикация Instagram/Pinterest по-прежнему не повторяется.

- Опциональный видеопубликатор: отдельный encrypted write-grant/checkpoint vault, subject-bound delivery IDs и согласованный SHA-256 wire fixture; Instagram staged Reels, resumable YouTube с readback видимости и обложкой, TikTok creator/privacy/disclosures/status, Pinterest media/S3/video Pin с обложкой из кадра. Unknown publish не создаётся заново. Новые OAuth TikTok/Pinterest и отдельный YouTube upload flow сохраняют совместимые read grants и стабильные resource IDs. Контур выключен без явной media-конфигурации, прежний MCP catalog сохраняется. Проверки синтетические, включая tsc output; живой допуск, OAuth, UI и публикация отдельно.

- Messenger uses separately issued, /me-verified Page tokens with actual messaging tasks and granted scopes. Missing Page tokens retain only a verified minimal profile; system grants never back Conversations. Messenger-only fingerprint revision requires fresh consent for prior scopes-only grants; other Meta fingerprints and adapters remain unchanged. App Review and live Inbox acceptance remain separate.

- Provider checkpoint audit regressions use independent real-vault cases, keeping one begin/error/consumed-state lifecycle per case instead of accumulating 24 protected filesystem cycles inside a single Windows timeout. Runtime policy and test timeouts are unchanged.

- Threads accepts the documented inspection shape without `app_id` only after a fresh dedicated app-token binding, with strict USER/scopes/identity/expiry checks; an explicit foreign app ID and all non-Threads missing app IDs are rejected. Fixed reasons expose the failing verification checkpoint without payloads.
- Read failures emit only fixed metadata and numeric provider codes. Operation permission denials remove only the selected capability; identity checks and invalid-token handling remain fail closed without discarding unrelated working assets. Conversations use minimal documented metadata fields; live Inbox acceptance remains separate.

- Direct Instagram Login retains the canonical desktop URL while trusted clients can select Meta’s current mobile/recovery `force_reauth`; the broker accepts one explicit flat/wrapped profile and bounded actual CSV/array permissions, preserves raw numeric identity precision and binds app-scoped identity to the verified professional account without returning provider payloads. Failed reauthorization retains existing connections.
- Threads long-lived exchange/refresh use the documented query token contract and fixed short/long/app/refresh diagnostic stages. Loopback health preserves its exact release-probe response. A separate service-authenticated loopback diagnostic endpoint exposes a bounded process-local callback arrival count, including unknown state, without per-request logs; restart resets it.

- Separate loopback hosted Meta broker with five subject-bound MCP tools; legacy single-account runtime preserved.
- Strict service bearer plus short HS256 subject JWT, encrypted single-writer grant/asset/state vault, one-use bound OAuth, own-asset read checks and disconnect generation fencing.
- Product-specific Instagram Unified/BISU, Facebook Pages, Messenger, Threads, Ads and WhatsApp discovery/read adapters; actual grant capabilities, safe DTOs and signature-first scoped webhooks.
- Threads long-lived upgrade and scheduled refresh with ciphertext CAS; revoked/expired grants require reconnect, disconnected assets cannot be resurrected by late OAuth/refresh.
- Generic admission/configuration/runbook and focused security/lifecycle/provider/real-MCP tests. Meta App Review, live OAuth, webhook subscription and deployment remain separate acceptance gates.
- Review fixes: complete reconsent retires missing own assets and fences superseded callbacks; operational admission/webhook configuration no longer invalidates OAuth grants; discovery follows fresh cursors after empty pages.
- Post-rename fsync uncertainty quarantines reads and ordinary writes while retaining CAS-safe disconnect recovery. Message TTL is enforced on read and scheduled sweep; verified owner deletion has an offline subject purge CLI. Privacy pages state message content, retention/history and backup limits explicitly.
- Vault commits protect temporary files before writing ciphertext, including a protected Windows DACL; failure leaves the prior vault revision intact.

Изменения относятся к публичным возможностям и инструкциям. [GitHub Releases](https://github.com/alexfisenkov/meta-instagram-mcp/releases/latest) показывает опубликованные версии, commit SHA и assets; changelog описывает состав версии, но не служит доказательством её публикации или live-проверки.

## 0.2.8 — 2026-11-05

- `meta_auth_status` сохраняет legacy поля и добавляет `verify` (default false), безопасную проекцию Meta `debug_token`, независимые token/data-access expiry и закрытые reason codes. Facebook verification ограничена одним GET и 5 секундами с отменой, без retry/refresh/token-store write. In-memory proof привязан к выбранным credentials; cache/stale помечены явно. Token fragments заменены на `[redacted]` с сохранением типа.
- Оба status tools показывают startup package/source identity из валидированного installer stamp или server `.VERSION`. Неизвестное, несовместимое или конфликтующее происхождение остаётся unknown; marker не проверяет целостность файлов. Capability schema version остаётся 1.
- Приватный `operational-context.json` проецируется только в public HTTPS privacy/deletion URLs и manual/unknown deletion workflow; конфигурация не выдаётся за live verification.
- Dependency refresh: MCP SDK 1.32.2, Zod 4.6.7, поддерживаемый SDK Hono override 2.1.6 и исправленные transitive packages. Dev-инструменты обновлены в текущих диапазонах: Vitest 4.1.12, tsx 4.23.15, Node 24 types 24.19.2; test-only happy-dom закреплён на 21.0.4 для исправления security advisories. TypeScript остаётся 5.9.3. Новых requested scopes, tools и прямых dependencies нет. SDK v2, Vitest 5 и TypeScript 7 требуют отдельной миграции.
- Документация различает конфигурацию, runtime snapshot и новую проверку. Публикация release, установка конкретного SHA и live acceptance проверяются отдельно.

## 0.2.7

- The production dependency graph now resolves patched, semver-compatible SDK and transitive packages. No MCP tools or API contracts changed; development-only audit findings remain separate.

## 0.2.6 — 2026-10-15

- `meta_exchange_code` refuses to save into an occupied token-store before exchanging the code; state-bound OAuth callback verifies the fresh Instagram account/Page before backup and save. Refresh and account resolution serialize token-store changes and preserve the active account metadata.
- Instagram OAuth requires `user_id` in the short exchange response, preserves it when the long-lived response omits it, and compares the long-response `user_id` when present; generic `id` is not treated as an alias. Facebook provider `user_id` is not treated as an Instagram account ID. OAuth token-endpoint requests do not retry fallback routes after an uncertain outcome.
- Remote stdio proxy accepts an explicit restricted HTTPS MCP endpoint path for a dedicated single-account core while preserving origin-to-`/mcp` configuration.
- One runtime/token-store remains single-account. A dedicated remote core can retain the Meta App Secret server-side; separate config, token and OAuth-state roots remain isolated.
- CI ignores `v*` version tags to avoid a duplicate workflow run after the final branch check; branch pushes, pull requests and manual runs remain enabled.
- Local mock regressions and fixtures cover identity verification, overwrite refusal, store locking, refresh metadata, endpoint/path isolation and no-replay behavior. They do not establish Meta app eligibility, permissions or live OAuth acceptance.

## 0.2.5 — 2026-10-11

- На Linux/macOS browser companion получает до 8 секунд на отдельную read task, чтобы ограниченное создание и проверка холодной Inbox-вкладки успевали завершиться в пределах общего 12-секундного router deadline. Телефонный default остаётся 4 секунды, Windows defaults — 30 секунд; caller deadline и явный `waitMs` продолжают ограничивать ожидание. Это не гарантирует чтение при задержке сети, входе или проверке аккаунта.
- Регрессионные тесты покрывают задержанное завершение через собранный runtime provider, короткий caller deadline, сохранённый override и оставшийся бюджет phone fallback.

## 0.2.4 — 2026-10-11

- MCP initialize metadata now reports the product version from package metadata; the version remains consistent in source and compiled distribution.
- Browser targetless `inbox.list` can prepare one inactive, session-managed Inbox tab when the sole Instagram tab is already a Direct thread. The managed surface follows the same account binding across Native Host bridge registration changes, while existing row refs remain pinned to their original bridge.
- Managed-tab activation revokes ownership. Ownership and inactive state are checked around bounded route navigation and immediately before data dispatch. If writing the revoked marker fails, the reader rechecks the exact tab/account assignment and makes one bounded removal attempt; if both writes fail, revocation is not durable across a later service-worker restart. Chrome provides no atomic compare-and-navigate operation, so a narrow activation race remains.
- Phone setup references now point to the tracked install guide. Device/UI readiness remains unverified on a physical device; the phone fixtures and these documentation fixes do not establish live compatibility.
- The previous live conversation-read failure remains unverified as a production cause; source tests do not prove a live account read.

## 0.2.3 — 2026-10-11

- Browser Direct row navigation waits for a verified thread-route transition within the remaining Hub read-task deadline. Expiry or an unchanged route remains unknown; the operation does not click again. This source-level regression does not establish the cause of any earlier live failure or a live account read.

## 0.2.2 — 2026-10-10

- Для unpinned browser read runtime может проверить до трёх свежих bridge того же account binding, которые объявили `account.inspect` и запрошенную read capability. Первый bridge, прошедший account verification и live operation check, закрепляется для чтения; API → browser → phone порядок и общий read deadline сохраняются. Явные bridge/row refs не переназначаются; discovery не работает в фоне и не разрешает writes.
- RED→GREEN regression воспроизводит ранее наблюдавшийся выбор: API Direct отвечает `missing_scope`, новый server browser bridge не проходит `account.inspect`, хотя более старый Mac bridge зарегистрирован с тем же binding. До исправления browser не попадал в `triedSources`; после исправления проверка доходит до Mac, а inbox task ставится только этому же проверенному bridge. Отдельный `account.inspect` возвращает первый успешный inspect без повторного вызова; abort не запускает следующего кандидата.
- Browser-only row ref остаётся привязан к выдавшему его bridge и при прямом provider вызове без router context; если исходный bridge устарел/недоступен, read завершается unknown вместо переназначения на новейший bridge.
- Cloud — отдельное private deployment: согласованный целевой gateway allowlist — 19 entries (старые 18 плюс named exception `meta_read_source`; `meta_capabilities` уже был в прежнем allowlist). Read exception охватывает `account.inspect`, `inbox.list`, `conversation.read`, `comments.list`, `comments.replies` и `insights.read`; остальные layered/mutation, write/auth и stateful resolver operations остаются закрыты. `meta_read_source` сохраняет `readOnlyHint: false`, так как UI conversation read может пометить диалог просмотренным (`may_mark_seen`). Этот public source change не доказывает private gateway deployment или фактический cloud catalog.
- Synthetic regression tests и CI подтверждают ограниченный source behavior, но не deployment или readiness конкретного аккаунта. Перед установкой/приёмкой проверьте exact deployed SHA, отдельный private cloud tool catalog и operator read-back, затем выполните bounded read-only Direct вызов через целевой MCP. Результат другого SHA не доказывает этот release; OAuth permissions и readiness browser/phone проверяются отдельно.

## 0.2.1

- Подключается ограниченный browser `account.inspect` перед автоматическим Direct read, если bridge зарегистрирован, но ещё не проверил аккаунт.
- Browser `account.inspect` can verify the owner from the observed unique visible avatar link (outside `nav`/`header`/`aside`/`main`, without `aria-label`/`title`) and own `/accounts/edit/` control when the Direct DOM has no profile link in `nav`; it restores the original tab URL and fails closed on ambiguous or changed identity markers.
- Browser owner verification reports fixed, value-free stage codes; Native Messaging passes the read-task expiry to the content script, which stops before returning data after its deadline.
- Native Messaging extension восстанавливает соединение через ограниченный MV3 alarm backoff; browser inbox/comment cursors явно отклоняются, если UI pagination не поддерживается.
- `tools/run.mjs` выбирает remote stdio proxy по внешней private config и не переключается на local core при ошибке remote. В phone inbox добавляется ограниченная semantic-навигация через exact accessibility IDs с fail-closed для неподтверждённого UI.
- Unified read router оставляет запас до стандартного 60-секундного MCP request timeout; API Direct triage отменяет текущий GET и прекращает следующие conversation GET в своём ограниченном бюджете, сохраняя недочитанные диалоги как `unknown` и время для companion fallback.
- Browser Native Host держит task id активным до завершения попытки отправить Hub receipt, чтобы параллельная повторная выдача leased read task не создавала второй semantic read. После rejected receipt Hub может повторно выдать read task; повторное чтение безопасно, а UI writes автоматически не повторяются.
- Перед browser task extension отправляет пустой readiness ping; только точная ошибка отсутствующего message receiver разрешает один раз внедрить фиксированный `content-script.js` в выбранную Instagram-вкладку. После повторного ping операция отправляется один раз; ошибки/timeout уже отправленной операции не запускают повтор.
- Общий read deadline теперь передаётся через browser preflight и companion queue. По expiry queued/leased read помечается отменённым в Hub; если браузер уже получил task, service worker не начинает UI-чтение после его expiry. Уже начатое UI-действие отмена не откатывает.
- Companion readiness selection is pinned to one bridge ID through preflight, status checks, and task enqueue; an expired selected bridge is not silently replaced by another same-account companion.
- For UI layouts without Direct href rows, the browser reads only visible, uniquely grouped semantic row cards. It returns short-lived bridge/tab/document-bound read-only refs; one explicit conversation.read may open one row and returns unknown rather than empty if the thread does not load. Operation-specific readiness prefers a ready capable same-account bridge; an existing row ref stays pinned to its origin.
- Layered inbox formatting preserves a bounded visible row preview alongside the browser-only ref; unread/unanswered remain unknown without an exact UI marker.
- Browser inbox reads also accept the verified Direct sidebar on an already-open thread route. A new row ref must prove a route change from the current thread; only the exact previously proven DOM row/thread/account association can be reused on the same route. One content-script admission guard rejects overlapping UI operations as `browser_ui_busy` instead of allowing navigation reads to race; it does not queue or replay an operation.
- Conversation reads snapshot every existing message/event candidate before row navigation and parse only newly created visible nodes in the current main. Supported visible entries are returned as bounded `visibleEntries` with `type: unknown`; the reader does not distinguish DM text from system/history events or invent IDs, authors, directions, or timestamps.
- Browser Native Host and phone companion graceful shutdown now stop new polling, drain admitted startup/poll/task/receipt work, then close their transport or Appium session. This does not cancel or roll back a UI operation already dispatched; writes keep their existing no-retry and unknown-outcome rules.
- Browser conversation reads with native targets now require fresh same-document/account/route proof established from an explicit inbox row ref; a native ID or URL alone cannot bind visible message or event nodes to the requested thread. Any observed route change invalidates the row proof. After any awaited tab selection, ping or fixed-script injection, the service worker rechecks the originating Native Messaging port before it can dispatch a UI operation; late results from a disconnected port are not sent to a replacement host.
- When a read-only `account.inspect` or `inbox.list` finds no Instagram tab in the assigned Chrome profile, the extension may create one inactive tab at the fixed Direct Inbox URL and wait for load within the task deadline. Multiple tabs, writes, stale conversation targets, unsupported UI and signed-out state remain fail-closed; no login, cookies or message actions are automated.
- Fixed value-free browser readiness stages distinguish bootstrap refusal, ambiguous tabs, tab creation failure and load failure; deadline expiry remains `task_deadline_expired`.
- Операционный runbook различает 27 нативных tools и 18 cloud allowlisted legacy tools, показывает текущие readiness boundaries и вводит iPhone/Appium runbook. Live browser/phone readiness остаётся отдельной runtime-проверкой.

Устанавливайте только commit SHA, опубликованный в [GitHub Releases](https://github.com/alexfisenkov/meta-instagram-mcp/releases/latest).

## 0.2.0 — Published 2026-10-06

- Общая factory связывает legacy API, API Direct/comments/insights, API→browser→phone read router, triage/analysis и source-bound prepare/execute tools для stdio и Streamable HTTP.
- Добавлены portable install/update/rollback/uninstall entrypoints, external-config wrapper, локальный doctor и fixture smoke.
- Добавлены per-user Native Messaging manifest/launcher/registry helper и изолированные fixtures; helper использует точный extension origin и отказывается заменять чужую регистрацию.
- Installer отказывает при пересечении target/config после canonical resolution ссылок; Windows CI собирает и сохраняет Native Messaging host artifact на 14 дней.
- Минимальная версия Node.js повышена до поддерживаемой 22; CI проверяет Node.js 22 и 24 на Linux, macOS и Windows.
- Добавлены профильная матрица, roadmap, operator/contributor/troubleshooting guides и CI по трём ОС.
- Browser Native Host/extension и phone companion подключены к runtime; helper не запускался на owner Chrome, а stable extension identity/path, серверный Chrome login, физический iOS/Android setup и live UI acceptance остаются отдельными gates.
- Phone broker принимает account.inspect/account.snapshot read tasks с пустым target list и передаёт их в выбранный phone provider.
- Runtime supports OAuth callback and account-bound webhook adapters when configured; Meta consent, hosted HTTPS deployment, permission approval and actual webhook delivery remain unverified.
- Приватные локальные хранилища проверяют Windows NTFS ACL и используют host-native сравнение путей; POSIX сохраняет строгие режимы файлов `0600` и каталогов `0700`.

Release `v0.2.0` опубликован. Установка и rollback описаны в [install runbook](docs/install.md); этот раздел фиксирует состав опубликованного release.
