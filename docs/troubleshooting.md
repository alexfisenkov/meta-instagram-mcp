# Troubleshooting

## Установщик

- `Node.js 20 or newer is required`: установите поддерживаемый Node.js у себя как обычный пользователь и повторите проверку `node --version`; установщик Node не скачивает и не запускает с повышенными правами.
- `Source HEAD does not match --revision`: переключите отдельный source checkout на тот же полный commit SHA, который передан установщику.
- `Source checkout has local changes`: сохраните свою работу в другом checkout и запускайте installer из чистого release commit.
- `Installer path guard`: выберите непересекающиеся target и config пути. Установщик проверяет существующие ссылки и существующие части ещё не созданного пути; если ссылку нельзя безопасно разрешить, он остановится до создания staging/backup или изменения config.
- `Target exists but is not managed`: installer не перезаписывает неизвестный каталог. Выберите новый `--target`/`-Target` или вручную перенесите старый каталог после своей резервной копии.
- `Promotion failed`: проверьте место на диске и права на родительский каталог. При обновлении installer пытается вернуть предыдущую версию; сохранённый backup виден в выводе.
- Не удаляйте `.backup.*` или `.rollback.*`, пока не убедились, что новый MCP запускается и нужная configuration читается.

## Config и token-store

- Если doctor пишет `configReadable: false`, проверьте syntax только `KEY=value`, отсутствие не-META переменных и права файла `.env`. На macOS/Linux примените `chmod 600 <config-dir>/.env`.
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

- `browser: not_connected`/`offline`: проверьте extension и Native Host installation, совпадение 32-character host ID, Chrome profile выбранного узла и его сеть. First login выполняется владельцем в browser profile узла; не копируйте cookies с другой машины.
- Если server не имеет desktop session или разрешённого owner login, оставьте browser gated. Документированный profile не создаёт display server и не подтверждает Instagram UI.
- `phone: offline`/`needs_selection`: телефонный bridge и выбранное устройство — отдельная readiness condition. iOS требует Mac с Xcode/WDA/Appium; Android нужен отдельно настроенный UiAutomator2.
- Локальный fake UI тест не доказывает live app compatibility. Не называйте UI capability `ready`, пока не выполнены соответствующие live checks.

## Неизвестный исход действия

При `OUTCOME_UNKNOWN` не повторяйте запрос и не переключайте источник: действие могло примениться. Сверьте request ID в локальном журнале, затем прочитайте точный target из того же source. `ACK` не равен доставке или подтверждённому read-back.
