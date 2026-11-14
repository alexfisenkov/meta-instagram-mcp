# Операционный runbook

Обновлено: 2026-11-14.

## Контракты и границы

Для hosted multi-user подключений используйте отдельный [student broker runbook](student-broker.md): entrypoint `dist/student-server.js`, private registry/env/vault и ограниченный `/student/mcp`. Он не запускает legacy owner runtime или companions. Проверка `/health` относится к listener; проверка Meta grants, внешнего admission и callbacks выполняется отдельно. Публичные legal endpoints `/privacy` и `/data-deletion` требуют операторские name/contact из environment, иначе возвращают 503.

- Нативные stdio и Streamable HTTP server регистрируют 27 инструментов: 18 legacy и 9 layered/mutation. Согласованный cloud allowlist содержит 19 инструментов: прежние 18 и named exception `meta_read_source`; `meta_capabilities` уже был разрешён. Фактический deployed cloud catalog нужно читать отдельно — этот checkout не доказывает deployment приватного allowlist. Это исключение не открывает остальные layered/mutation tools; write/auth/stateful resolver операции остаются закрыты. `meta_read_source` честно помечен `readOnlyHint: false`, потому что UI-read может иметь side effect `may_mark_seen`.
- `meta_read_source` разрешает только read operations `account.inspect`, `inbox.list`, `conversation.read`, `comments.list`, `comments.replies` и `insights.read`. Это не разрешение на send/reply/reaction или другие writes. Проверяйте их результат отдельно от общего snapshot `meta_capabilities`.
- Для объединённого чтения Direct используйте `meta_read_inbox` или `meta_read_source`. Они маршрутизируют чтение API → browser → phone и возвращают источники, coverage, ограничения и ошибки.
- `meta_capabilities` показывает общий runtime status и operation-specific status. Generic browser summary может указывать на самый свежий bridge, даже если тот не прошёл account verification; operation status ищет ready bridge с нужной live capability. Ни один из этих snapshot-запросов не открывает UI и не запускает `account.inspect`. При конкретном unpinned browser read provider может по общему deadline проверить до трёх свежих same-binding bridges, заявивших `account.inspect` и нужную read capability; после owner verification он закрепляет bridge до конца этого чтения. Declared capability сама по себе не означает readiness. Явный row ref не переназначается. Ни summary, ни operation status не доказывает, что последующий live read сработал.
- Неподключённый, неподдержанный или неавторизованный источник пропускается. При отсутствии подтверждённых наблюдений результат имеет `coverage: unknown`; пустой список не означает пустой inbox. Ошибка owner preflight одного допустимого browser bridge не скрывает другой свежий bridge того же binding, но явный bridge/ref остаётся pinned и fail-closed.
- Запись в API, browser и phone остаётся отдельным подтверждаемым путём. Read fallback не переключает запись между источниками и не повторяет `OUTCOME_UNKNOWN`.

## Локально проверить установленный MCP

Из каталога установки запустите:

```bash
npm run build
node tools/doctor.mjs
```

Doctor делает локальные MCP initialize/listTools и read-only status checks. `toolCount` относится к подключённому runtime, а статусы источников не доказывают доступ Meta, авторизацию Chrome, готовность физического телефона или опубликованный серверный deployment. Если Codex использует локальный сервер, отдельно проверьте его подключение в настройках MCP-клиента.

Doctor выводит только разрешённые поля `runtime`, `authorization`, `oauthSetup` и `operationalContext` из status ответа. `app.verification: "installation_metadata_only"` относится к прочитанной установке, `runtime` — к подключённому процессу; совпадение версии файлов само по себе не подтверждает перезапуск. Doctor не включает `verify:true`; для новой проверки используйте MCP-вызов ниже.

Секреты, OAuth-коды, cookies, browser storage и полные account identifiers не копируйте в логи, issues или этот репозиторий. Конфигурация и token-store должны оставаться во внешнем приватном каталоге.

## Проверить версию и авторизацию

1. Вызовите `meta_auth_status` с `{}`. `config` и legacy `storedToken` описывают настройки/сохранённые данные; это не live proof. Token strings содержат только `[redacted]`.
2. Сверьте `runtime.packageVersion` и `runtime.sourceRevision` с release SHA. `revisionSource` показывает `installer_stamp`, `server_version` или `unknown`; `capturedAt` относится к стартовому снимку. Installer stamp требует совпадения версии пакета, полного SHA и корректного `installedAt`; первая строка server `.VERSION` содержит ровно полный SHA, далее допустимы только пустые строки или комментарии оператора с `#`. Ошибочный stamp, несовпадение версий или конфликт markers дают unknown. Marker не доказывает, что файлы не меняли вручную.
3. Для новой read-only проверки Facebook или Unified credential вызовите `meta_auth_status` с `{"verify":true}`. Это один GET `debug_token`, максимум 5 секунд wall-clock, без retry, OAuth, refresh или сохранения токена. Для Instagram Login — `unsupported_auth_mode`; для отсутствующих credentials — `no_token`/`missing_app_credentials`. Ошибки транспорта/Meta и некорректные ответы дают `verification_failed`, `verification_timeout` или `malformed_response` без upstream payload.
4. Читайте `authorization.tokenValid` и `appMatches` независимо. `token_invalid` и `app_mismatch` не подтверждают исправную авторизацию. `scopes` — names из проверенного ответа, не requested presets. При `is_valid:true` обязателен массив поддерживаемых Facebook scope names (объединение текущих presets плюс `public_profile`/`email`). Отсутствующий/неверный массив, неизвестные имена или чувствительные значения дают `malformed_response`, unknown и пустой список scopes; новые имена требуют отдельного обновления allowlist, а не автоматического принятия. При invalid token scopes не проецируются. Эта проверка не меняет запрашиваемые scopes и не доказывает доступ к account/media/insights/comments или UI.
5. Читайте оба срока: `tokenExpiry` и `dataAccessExpiry`. `expires_at` содержит ISO `expiresAt`; `no_expiry_reported` соответствует числовому нулю; отсутствующие/невалидные значения имеют `unknown`. Ноль не означает бессрочный доступ. Не вычисляйте неизвестный срок из даты сохранения токена.

Обычный status не отправляет verification request. После проверки он может вернуть `verification: "cached"` с прежним `checkedAt`; спустя 5 минут — `freshness: "stale"`. Новая проверка имеет `verification: "live"`, `source: "meta_debug_token"`, `freshness: "fresh"`. Cache существует только в памяти runtime, сбрасывается при смене выбранных token/app/secret/auth mode или credential source. Environment token приоритетнее сохранённого; stored metadata не переносится в proof environment token. Ошибка новой попытки убирает прежний proof.

`meta_capabilities` сохраняет `version: 1` и `verification: "runtime_status_only"` и добавляет тот же startup `runtime`. Запрос не запускает UI или новую token verification. `operationalContext.verification: "configuration_only"` не подтверждает доступность legal URLs или выполнение удаления данных. Секреты, raw debug response и raw context не копируйте в отчёт.

## Unified Login

Подробный путь: [Unified Login](unified-login.md). `oauthSetup.ready/issues` относится к запуску OAuth; отсутствие HTTPS redirect/config ID не мешает ручному Dashboard-token пути. Сначала проверьте выбранный токен через `meta_auth_status({verify:true})`, затем разрешите Instagram asset и прочитайте account/media. Unified status требует SYSTEM_USER, правильную App, `instagram_basic` и действующие сроки. `/me` не является Instagram profile. Unified context заново проверяет grant и assigned assets; сохранённые permission labels не заменяют proof. `UNIFIED_REAUTH_REQUIRED` означает новый вход, а не бесконечный retry refresh.

## Диагностика отказа OAuth callback

Callback сохраняет общее публичное сообщение об отказе. В stderr отдельной JSON-строкой пишется `oauth_callback_failed`: этап `state`, `exchange`, `identity` или `commit`, фиксированный `reason` и, для исключений, класс из закрытого списка. Проверки state, Instagram account/Page и backup/commit остаются обязательными. `identity` включает чтение текущего token-store и проверку текущего токена до обмена, если она нужна; этап сам по себе не доказывает, что новый токен уже получен. `state_rejected` объединяет отсутствующий, неподходящий, просроченный и уже использованный state. Ошибки синхронного или асинхронного диагностического hook подавляются без вывода исходного исключения.

Для systemd-инсталляции оператор подставляет имя core unit и время начала проверки вместо `TIME`. Фильтр выводит только известные значения; остальной журнал, URL/query, exception message/stack, state, code, tokens и account identifiers не выводятся:

```bash
journalctl -u mcp-instagram.service --since TIME --no-pager -o cat |
  jq -Rc 'fromjson? | select(type == "object") | select(.event == "oauth_callback_failed") |
    select(.phase | IN("state", "exchange", "identity", "commit")) |
    select(.reason | IN("callback_rejected", "state_rejected", "authorization_rejected", "context_mismatch", "identity_mismatch", "auth_mode_mismatch", "commit_unavailable", "operation_failed", "identity_unverified", "identity_ambiguous", "page_unavailable", "page_token_unavailable", "invalid_page_response", "token_store_changed", "permissions_unverified")) |
    select(.errorClass == null or (.errorClass | IN("MetaApiError", "MetaTransportError", "TypeError", "Error", "Unknown"))) |
    {event, phase, reason} + (if .errorClass == null then {} else {errorClass} end)'
```

`page_unavailable` означает, что ожидаемая Page не найдена в доступных Pages при проверке identity; `identity_mismatch` — несовпадение привязки; `token_store_changed` — конкурентное изменение перед commit. Остальные неизвестные исключения дают `operation_failed` без текста. Отсутствие записи не доказывает успех: запрос мог не дойти до core, версия могла не содержать диагностику или журнал мог быть недоступен. Повторный OAuth — отдельное действие владельца; использованный code/state повторять нельзя. Локальные тесты диагностики не подтверждают live OAuth и не обновляют токен.

Для callback с уже закреплённой в consumed state ожидаемой Facebook Page отсутствие этой Page в корректном `/me/accounts` допускает один прямой lookup её точного числового ID. До принятия результата обязательны совпадение Page ID, пригодный Page token, подтверждение того же Page ID через `/me` с этим токеном и успешное чтение `id,username` связанного Instagram тем же Page token. Затем остаётся прежняя проверка ожидаемых Instagram ID и Page ID перед backup/save. Ошибки списка Pages и найденная Page без токена этот fallback не включают; без закреплённой Page прямого поиска нет. Raw Page token остаётся внутри клиента, tasks из этого доказательства не выводятся. Legacy exchange, обычные account/Direct reads и verifier по умолчанию этот внутренний callback opt-in не включают.

Facebook callback закрепляет в state тот же список запрошенных scopes, который runtime и standalone helper используют для authorization URL. Список запроса не доказывает выдачу прав: до любого backup/commit новый user token отдельно читает `/me/permissions`; каждый закреплённый scope должен иметь фактический `granted`. Сохраняются реальные новые grants, без переноса старых labels или доверия полю `permissions` из обмена. Отсутствующие, declined, malformed, неполные или недоступные данные означают отказ без изменения старого токена. `permissions_unverified` — закрытый код такого отказа; API/transport ошибки остаются без raw payload в журнале. Старые Facebook state без scope pin требуют нового flow. Новых requested scopes, прав публикации или Direct это не добавляет; Instagram Login сохраняет прежний путь.

## Остановить companion

`Ctrl+C` или штатный `SIGTERM` прекращает новые browser/phone polls. `close()` ждёт уже начатые registration, heartbeat/poll, task и receipt submission, затем закрывает Appium session; повторный вызов `close()` возвращает ту же операцию завершения. Это drain уже принятой работы, а не отмена UI-действия: открытая переписка может успеть пометиться просмотренной, а результат уже начатого write не откатывается. Для writes остаются действующими отсутствие автоматического повтора и `OUTCOME_UNKNOWN` при неопределённом исходе.

## Получить Direct из доступного источника

Сначала вызовите `meta_read_inbox` с ограниченным `limit`. Вызов автоматически проверит доступные источники API → browser → phone. Если API сообщает `missing_scope`, `permission_blocked` или временную недоступность, роутер попробует следующий готовый источник.

На Linux/macOS обычный browser read task ждёт до 8 секунд, phone task — до 4 секунд; на Windows оба лимита до 30 секунд. Это per-source верхние границы внутри общего read deadline (12 секунд на Linux/macOS, 50 секунд на Windows), а не добавочное время. Если API или browser preflight уже израсходовали часть общего бюджета, следующий источник получает только остаток; после полного браузерного ожидания телефону на Linux/macOS останется меньше обычных 4 секунд. Явный `waitMs` конкретной интеграции заменяет per-source default, но общий deadline всё равно ограничивает фактическое ожидание. Эти лимиты не гарантируют готовность страницы или успешное чтение при задержке сети, входе или проверке аккаунта.

Browser companion, который уже зарегистрирован, но ещё не прошёл проверку аккаунта, получает один ограниченный `account.inspect` preflight перед обычным чтением. Если URL и `nav` не показывают handle, браузер кликает только уникальную видимую avatar-ссылку без предков `nav`, `header`, `aside` и `main`, `aria-label` и `title`; handle из href должен совпадать с handle из `img alt`. Затем проверяются собственный `/accounts/edit/` control и точное восстановление той же вкладки на исходный Instagram URL. Companion должен подтвердить ожидаемый username и Instagram surface. Неизвестная или неоднозначная разметка и невосстановленный URL заканчиваются `needs_selection`; повторяющиеся ручные клики не предлагаются как обход. Эта проверка не выполняет вход в аккаунт и не переносит cookies. Если browser не зарегистрирован, его статус `not_connected` и автоматический preflight не запускается.

Если очередь содержит выбранный диалог, используйте его `accountBinding` и native ID в `meta_read_source` с `operation: "conversation.read"`. Чтение через browser или phone может пометить открытый диалог просмотренным; результат отдельно сообщает этот возможный side effect. Направление сообщения, непрочитанное состояние и ответ остаются `unknown`, если источник их не подтверждает.

Если browser показывает Direct row cards без native links, используйте только свежий browser `threadRef.explicitOwnerRef` из `meta_read_inbox`. Один лишь native ID или URL не доказывает, что видимые message/event nodes принадлежат выбранному диалогу; native-target read без установленного свежего row-ref proof завершится `needs_selection`. Ожидание нового thread route ограничено оставшимся deadline read-задачи Hub; если переход не подтверждён до expiry, результат остаётся unknown, без повторного клика. Любая смена route инвалидирует proof и требует нового inbox snapshot.

История ограничена возможностями источника: API использует Graph cursors и ограниченное окно; browser older-history cursor привязан к точному диалогу и ограниченной прокрутке; phone older-history cursor не поддерживается. Cursor одного источника нельзя переносить на другой. Повтор той же страницы должен либо явно сообщить `unsupported_cursor`, либо выполняться источником, который выдал cursor.

`meta_triage_inbox` применяет те же правила чтения Direct. Комментарии включаются только для переданных точных media targets; без них account-wide сканирования комментариев нет.

## Разобрать недоступность API Direct

В `meta_capabilities` смотрите статус отдельно для `inbox.list` и `conversation.read`:

- `missing_scope` означает, что подтверждённого permission или обязательного Page task нет. Для Facebook Login Direct нужен разрешённый Page token и задача `MESSAGING`; scopes должны совпасть с выбранным auth mode.
- `permission_blocked` означает, что permission status не удалось подтвердить или Meta отклонила запрос. Не делайте вывод об исправной авторизации только по наличию token-файла.
- `offline` означает транспортную или runtime ошибку. Browser/phone могут быть fallback только если у них есть собственный проверенный источник.

Официальный OAuth flow описан в [Meta setup](meta-setup.md), а callback и token refresh — в [установке](install.md). Повторный consent, права Meta App, доступ Page и подтверждение аккаунта выполняет владелец. Cloud `meta_read_source` маршрутизирует разрешённые чтения через настроенный router; фактическая cloud deployment и каталог проверяются отдельно, а один allowlist entry не доказывает доступность API/browser/phone.

## Подключить источник

Настройку browser Native Messaging и удалённого Hub выполняйте по [установке](install.md). После регистрации `meta_capabilities` даёт только общий/per-operation status snapshot; для unpinned read runtime может проверить до трёх свежих browser bridge одного binding, если они объявили `account.inspect` и нужную read capability. Успешная owner-проверка закрепляет тот же bridge для Direct read. Явный browser ref не переназначается, а declared capability без успешного account verification и live operation status не считается готовностью.

Для настройки телефона используйте публичный раздел [Connected phone](install.md). Phone read проверяет ожидаемый профиль, затем проходит через точные accessibility IDs `Home` и `Messages` или `Inbox`. Этот маршрут покрыт fixtures, но ещё не подтверждён на реальном устройстве и текущей локали Instagram; если label/control не совпадает, источник закрывается со статусом `unsupported_ui_version`.

Для browser `account.inspect` и `inbox.list` при нуле Instagram-вкладок extension может создать одну неактивную вкладку по фиксированному адресу Direct Inbox и дождаться `status: complete` в оставшемся read deadline. Если вкладок больше одной, контент не прошёл owner verification или бюджет истёк, операция остаётся `needs_selection`/`unknown`; вход в Instagram и выбор между несколькими tabs не автоматизируются.

## Remote stdio proxy

Portable `tools/run.mjs` по умолчанию запускает локальный MCP. Любой непустой `INSTAGRAM_MCP_REMOTE_CONFIG`, `INSTAGRAM_MCP_REMOTE_URL` или `INSTAGRAM_MCP_REMOTE_BEARER_TOKEN` направляет stdio к `remote-proxy`; некорректная конфигурация завершает запуск без перехода на локальное ядро. Настройте HTTPS origin или явный MCP endpoint `/instance/mcp` и отдельный bearer token в приватном внешнем `.env` либо укажите приватный файл конфигурации. Держите за каждым endpoint выделенный runtime/config/token-store для одного account: proxy прозрачно пересылает инструменты и не добавляет tenant routing. Публичный URL, account credentials и bearer token в репозиторий не добавляйте.
