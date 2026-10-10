# Операционный runbook

Обновлено: 2026-10-10.

## Контракты и границы

- Нативные stdio и Streamable HTTP server регистрируют 27 инструментов: 18 legacy и 9 layered/mutation. Cloud allowlist отдельно содержит 18 legacy tools; не считайте его каталогом нативного runtime.
- Для объединённого чтения Direct используйте `meta_read_inbox` или `meta_read_source`. Они маршрутизируют чтение API → browser → phone и возвращают источники, coverage, ограничения и ошибки.
- `meta_capabilities` показывает текущий runtime status. Он сам не проверяет содержимое Instagram, не запускает OAuth и не доказывает, что live read сработал.
- Неподключённый, неподдержанный или неавторизованный источник пропускается. При отсутствии подтверждённых наблюдений результат имеет `coverage: unknown`; пустой список не означает пустой inbox.
- Запись в API, browser и phone остаётся отдельным подтверждаемым путём. Read fallback не переключает запись между источниками и не повторяет `OUTCOME_UNKNOWN`.

## Локально проверить установленный MCP

Из каталога установки запустите:

```bash
npm run build
node tools/doctor.mjs
```

Doctor делает локальные MCP initialize/listTools и read-only status checks. `toolCount` относится к подключённому runtime, а статусы источников не доказывают доступ Meta, авторизацию Chrome, готовность физического телефона или опубликованный серверный deployment. Если Codex использует локальный сервер, отдельно проверьте его подключение в настройках MCP-клиента.

Секреты, OAuth-коды, cookies, browser storage и полные account identifiers не копируйте в логи, issues или этот репозиторий. Конфигурация и token-store должны оставаться во внешнем приватном каталоге.

## Получить Direct из доступного источника

Сначала вызовите `meta_read_inbox` с ограниченным `limit`. Вызов автоматически проверит доступные источники API → browser → phone. Если API сообщает `missing_scope`, `permission_blocked` или временную недоступность, роутер попробует следующий готовый источник.

Browser companion, который уже зарегистрирован, но ещё не прошёл проверку аккаунта, получает один ограниченный `account.inspect` preflight перед обычным чтением. Companion должен подтвердить ожидаемый username и Instagram surface. Эта проверка не выполняет вход в аккаунт и не переносит cookies. Если browser не зарегистрирован, его статус `not_connected` и автоматический preflight не запускается.

Если очередь содержит выбранный диалог, используйте его `accountBinding` и native ID в `meta_read_source` с `operation: "conversation.read"`. Чтение через browser или phone может пометить открытый диалог просмотренным; результат отдельно сообщает этот возможный side effect. Направление сообщения, непрочитанное состояние и ответ остаются `unknown`, если источник их не подтверждает.

История ограничена возможностями источника: API использует Graph cursors и ограниченное окно; browser older-history cursor привязан к точному диалогу и ограниченной прокрутке; phone older-history cursor не поддерживается. Cursor одного источника нельзя переносить на другой. Повтор той же страницы должен либо явно сообщить `unsupported_cursor`, либо выполняться источником, который выдал cursor.

`meta_triage_inbox` применяет те же правила чтения Direct. Комментарии включаются только для переданных точных media targets; без них account-wide сканирования комментариев нет.

## Разобрать недоступность API Direct

В `meta_capabilities` смотрите статус отдельно для `inbox.list` и `conversation.read`:

- `missing_scope` означает, что подтверждённого permission или обязательного Page task нет. Для Facebook Login Direct нужен разрешённый Page token и задача `MESSAGING`; scopes должны совпасть с выбранным auth mode.
- `permission_blocked` означает, что permission status не удалось подтвердить или Meta отклонила запрос. Не делайте вывод об исправной авторизации только по наличию token-файла.
- `offline` означает транспортную или runtime ошибку. Browser/phone могут быть fallback только если у них есть собственный проверенный источник.

Официальный OAuth flow описан в [Meta setup](meta-setup.md), а callback и token refresh — в [установке](install.md). Повторный consent, права Meta App, доступ Page и подтверждение аккаунта выполняет владелец. Cloud allowlist с legacy API tools не добавляет browser/phone fallback.

## Подключить источник

Настройку browser Native Messaging и удалённого Hub выполняйте по [установке](install.md). После регистрации проверьте `meta_capabilities`, затем вызовите `meta_read_inbox`; runtime перепроверит зарегистрированный, но ещё не подтверждённый browser аккаунт перед Direct чтением.

Для телефона используйте отдельную [инструкцию Appium/WDA](ios-appium-operator-runbook.md). Phone read проверяет ожидаемый профиль, затем проходит через точные accessibility IDs `Home` и `Messages` или `Inbox`. Этот маршрут покрыт fixtures, но ещё не подтверждён на реальном устройстве и текущей локали Instagram; если label/control не совпадает, источник закрывается со статусом `unsupported_ui_version`.

## Remote stdio proxy

Portable `tools/run.mjs` по умолчанию запускает локальный MCP. Любой непустой `INSTAGRAM_MCP_REMOTE_CONFIG`, `INSTAGRAM_MCP_REMOTE_URL` или `INSTAGRAM_MCP_REMOTE_BEARER_TOKEN` направляет stdio к `remote-proxy`; некорректная конфигурация завершает запуск без перехода на локальное ядро. Настройте HTTPS origin и bearer token в приватном внешнем `.env` или укажите приватный файл конфигурации. Публичный URL, account credentials и bearer token в репозиторий не добавляйте.
