# Операционный runbook

Обновлено: 2026-10-10.

## Контракты и границы

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

Секреты, OAuth-коды, cookies, browser storage и полные account identifiers не копируйте в логи, issues или этот репозиторий. Конфигурация и token-store должны оставаться во внешнем приватном каталоге.

## Остановить companion

`Ctrl+C` или штатный `SIGTERM` прекращает новые browser/phone polls. `close()` ждёт уже начатые registration, heartbeat/poll, task и receipt submission, затем закрывает Appium session; повторный вызов `close()` возвращает ту же операцию завершения. Это drain уже принятой работы, а не отмена UI-действия: открытая переписка может успеть пометиться просмотренной, а результат уже начатого write не откатывается. Для writes остаются действующими отсутствие автоматического повтора и `OUTCOME_UNKNOWN` при неопределённом исходе.

## Получить Direct из доступного источника

Сначала вызовите `meta_read_inbox` с ограниченным `limit`. Вызов автоматически проверит доступные источники API → browser → phone. Если API сообщает `missing_scope`, `permission_blocked` или временную недоступность, роутер попробует следующий готовый источник.

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

Для телефона используйте отдельную [инструкцию Appium/WDA](ios-appium-operator-runbook.md). Phone read проверяет ожидаемый профиль, затем проходит через точные accessibility IDs `Home` и `Messages` или `Inbox`. Этот маршрут покрыт fixtures, но ещё не подтверждён на реальном устройстве и текущей локали Instagram; если label/control не совпадает, источник закрывается со статусом `unsupported_ui_version`.

Для browser `account.inspect` и `inbox.list` при нуле Instagram-вкладок extension может создать одну неактивную вкладку по фиксированному адресу Direct Inbox и дождаться `status: complete` в оставшемся read deadline. Если вкладок больше одной, контент не прошёл owner verification или бюджет истёк, операция остаётся `needs_selection`/`unknown`; вход в Instagram и выбор между несколькими tabs не автоматизируются.

## Remote stdio proxy

Portable `tools/run.mjs` по умолчанию запускает локальный MCP. Любой непустой `INSTAGRAM_MCP_REMOTE_CONFIG`, `INSTAGRAM_MCP_REMOTE_URL` или `INSTAGRAM_MCP_REMOTE_BEARER_TOKEN` направляет stdio к `remote-proxy`; некорректная конфигурация завершает запуск без перехода на локальное ядро. Настройте HTTPS origin и bearer token в приватном внешнем `.env` или укажите приватный файл конфигурации. Публичный URL, account credentials и bearer token в репозиторий не добавляйте.
