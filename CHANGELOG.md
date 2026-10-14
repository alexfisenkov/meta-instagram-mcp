# Changelog

Изменения относятся к публичным возможностям и инструкциям. [GitHub Releases](https://github.com/alexfisenkov/meta-instagram-mcp/releases/latest) показывает опубликованные версии, commit SHA и assets; changelog описывает состав версии, но не служит доказательством её публикации или live-проверки.

## 0.2.6 — Unreleased

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
