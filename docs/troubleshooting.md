# Troubleshooting

## Установщик

- Установите поддерживаемый Node.js 22+ (рекомендуется Node.js 24 LTS). Установщик проекта не скачивает и не запускает Node.js с повышенными правами.
- `Source HEAD does not match --revision`: переключите отдельный source checkout на тот же полный commit SHA, который передан установщику.
- `Source checkout has local changes`: сохраните свою работу в другом checkout и запускайте installer из чистого release commit.
- `Installer path guard`: выберите непересекающиеся target и config пути. Установщик проверяет существующие ссылки и существующие части ещё не созданного пути; если ссылку нельзя безопасно разрешить, он остановится до создания staging/backup или изменения config.
- `Target exists but is not managed`: installer не перезаписывает неизвестный каталог. Выберите новый `--target`/`-Target` или вручную перенесите старый каталог после своей резервной копии.
- `Promotion failed`: проверьте место на диске и права на родительский каталог. При обновлении installer пытается вернуть предыдущую версию; сохранённый backup виден в выводе.
- Не удаляйте `.backup.*` или `.rollback.*`, пока не убедились, что новый MCP запускается и нужная configuration читается.

## Config и token-store

- Если doctor пишет `configReadable: false`, проверьте `KEY=value`, что каждое имя есть в поддерживаемом списке из [.env.example](../.env.example), нет `META_MCP_CONFIG_DIR` и повторов ключей, а права файла допустимы. Значения не интерпретируются как shell-код. На macOS/Linux примените `chmod 600 <config-dir>/.env`.
- Если `hasAppId`, `hasAppSecret` или `accessTokenPresent` ложны, заполните приватную внешнюю `.env` либо задайте соответствующую переменную окружения для процесса клиента. Doctor не покажет значение.
- Старый token-store не удаляется при update/uninstall. При нестандартном `META_TOKEN_STORE_PATH` проверьте путь локально; doctor покажет только true/false.
- Не вставляйте в issue/log полный callback URL, OAuth `code`, token, cookies, `username`, account/Page ID или сырые server/client output.

## MCP transport и инструменты

Запустите `node tools/doctor.mjs`. Ожидаемая диагностика локальна: install найден, `initialize` успешно прошёл, tools перечислены, `meta_auth_status` ответил и read-only source status доступен, когда он есть в server surface. `sourceStatus.toolAvailable: false` значит, что server не выставил такой status tool; это не доказывает, что browser или phone готовы.

Если в клиенте нет tools, проверьте его MCP connection status и перезапустите/обновите список servers. Убедитесь, что command указывает на `node`, а `args` — на `tools/run.mjs` из установленного каталога. Если клиент запускает другой Node или не наследует PATH, укажите полный путь к исполняемому Node без добавления секретов в JSON.

## Meta OAuth и permissions

- `Invalid platform app`: сверяйте `META_AUTH_MODE`, тип созданной Meta App, login flow и redirect URI; Facebook Login и отдельный Instagram Login — разные конфигурации.
- Недостающий scope/пустой список Page не всегда означает неисправный token. Проверяйте нужный account binding и permissions, выданные Meta во время consent.
- Direct, comments и insights доступны только в рамках scopes/API окон, которые фактически выданы. До app review/Advanced Access/consent не обещайте доступ для стороннего production account.
- Webhook, Streamable HTTP и удалённая server route не считаются подключёнными, если установленная версия не прошла mounted-route, auth, signature и read-back checks.

## Browser и телефон

- `browser: not_connected`/`offline`: проверьте extension и Native Host registration, точный 32-character extension ID в `allowed_origins`, стабильный host path, Chrome profile выбранного узла и его сеть. При потере native port extension повторяет соединение через один именованный MV3 alarm с ограниченным backoff. Первый login выполняется владельцем в browser profile узла; не копируйте cookies с другой машины.
- Зарегистрированный browser без verified heartbeat может пройти ограниченный `account.inspect` при `meta_read_inbox`; browser без live bridge ID не открывается автоматическим preflight.
- Если server не имеет desktop session или разрешённого owner login, оставьте browser gated. Документированный profile не создаёт display server и не подтверждает Instagram UI.
- `phone: offline`/`needs_selection`: телефонный bridge и выбранное устройство — отдельная readiness condition. iOS требует Mac с Xcode/WDA/Appium; Android нужен отдельно настроенный UiAutomator2.
- Phone inbox navigation сейчас покрыта fixtures только для accessibility IDs `Profile`, `Home`, `Messages`, `Inbox`. Эти labels и переходы ещё не проверены на физическом устройстве; при неизвестном или неоднозначном UI reader завершает работу с `unsupported_ui_version`.
- Локальные browser/phone fixtures не доказывают live app compatibility. Не называйте UI capability `ready`, пока не выполнены соответствующие live checks. Для телефонной процедуры смотрите [iPhone/Appium runbook](ios-appium-operator-runbook.md).

## Неизвестный исход действия

При `OUTCOME_UNKNOWN` не повторяйте запрос и не переключайте источник: действие могло примениться. Сверьте request ID в локальном журнале, затем прочитайте точный target из того же source. `ACK` не равен доставке или подтверждённому read-back.
