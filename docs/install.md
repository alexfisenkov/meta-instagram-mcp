# Установка и обновление

В этом репозитории предусмотрены два способа работы:

- portable MCP для Node.js с конфигурацией и token-store вне каталога приложения;
- четыре профиля: API stdio, API + server-owned persistent Chrome/extension/Native Host, external desktop browser и connected phone companion. Shared runtime paths для stdio/HTTP/API/browser/phone подключены в checkout; server deployment, host registration, live OAuth/UI/device QA и published release остаются отдельными gates. Сверяйтесь с [матрицей возможностей](capabilities.md).

## Требования

- Git 2.30+;
- Node.js 24 LTS рекомендуется; минимальная поддерживаемая версия — Node.js 22 LTS;
- `tar` в `PATH` на всех системах, включая Windows PowerShell 7;
- интернет для получения исходного commit и зависимостей npm;
- macOS, Linux или Windows с PowerShell 7 для нативного Windows-установщика.

Нужны собственная Meta App и professional Instagram account. Meta выдаёт доступ только после нужного OAuth consent и прав приложения. Instagram Login и Facebook Login используют разные режимы и scopes; аккаунт и Page, если она участвует в выбранном OAuth flow, привязываются явно. До настройки и подтверждения прав Direct, comments и insights могут оставаться недоступными. Общая инструкция по Meta App находится в [Meta setup](meta-setup.md).

## Установить из опубликованного release

Установщик принимает полный 40-символьный commit SHA. Возьмите SHA из опубликованного release, клонируйте публичный репозиторий и переключите отдельный source checkout на этот commit:

### macOS и Linux

```bash
git clone https://github.com/alexfisenkov/meta-instagram-mcp.git meta-instagram-mcp-source
cd meta-instagram-mcp-source
git fetch --tags origin
read -r -p "Commit SHA из release: " REVISION
git checkout --detach "$REVISION"
./install.sh --revision "$REVISION"
```

### Windows PowerShell 7

```powershell
git clone https://github.com/alexfisenkov/meta-instagram-mcp.git meta-instagram-mcp-source
Set-Location meta-instagram-mcp-source
git fetch --tags origin
$Revision = Read-Host "Commit SHA из release"
git checkout --detach $Revision
.\install.ps1 -Revision $Revision
```

Установщик сверяет SHA с `HEAD`, требует чистую рабочую копию и собирает только отслеживаемые файлы указанного commit. Он не запускает `sudo`, не устанавливает Node.js, не меняет настройки MCP-клиентов и не публикует release. Версия `0.2.0` пока предварительная; не используйте её как опубликованный release, пока она не появилась в GitHub Releases с commit SHA.

Каталог программы по умолчанию — `~/.local/share/meta-instagram-mcp/app` на macOS/Linux и `%LOCALAPPDATA%\meta-instagram-mcp\app` на Windows. Конфигурация отдельно: `~/.config/meta-instagram-mcp/.env`, token-store по умолчанию `~/.config/meta-instagram-mcp/token.json`. Windows использует `%USERPROFILE%\.config\meta-instagram-mcp`. Пути можно заменить флагами `--target` и `--config-dir` (`-Target`, `-ConfigDir` в PowerShell). Каталог конфигурации должен находиться вне каталога программы.

При первой установке, если внешнего `.env` ещё нет, установщик копирует туда игнорируемый локальный `.env` source checkout, если он есть; иначе создаёт файл из `.env.example`. Исходный файл не удаляется. На macOS/Linux каталог и файл получают права `0700` и `0600`; Windows задаёт ACL текущему пользователю. При update существующий внешний `.env`, token-store, OAuth state и publish log не перезаписываются. Не передавайте секреты в аргументах командной строки.

## Подключить portable MCP

После установки соберите подключение в нужном клиенте. Сначала замените путь в примерах на свой каталог `app`; существующую конфигурацию клиента сохраните и аккуратно дополните одной записью.

### Codex CLI и IDE

Официальный OpenAI Docs описывает локальные stdio-серверы через `codex mcp add`; CLI и IDE используют одну конфигурацию:

```bash
codex mcp add meta-instagram-mcp -- node /absolute/install/path/tools/run.mjs
codex mcp get meta-instagram-mcp
```

Если `node` не находится в PATH процесса клиента, укажите абсолютный путь к Node.js в команде. Не передавайте Meta secrets через `--env`: wrapper читает приватный внешний config. См. [Codex MCP docs](https://developers.openai.com/codex/extend/mcp/).

### Claude Code

Добавьте локальный stdio-сервер на user scope, чтобы запись оставалась приватной для этой машины:

```bash
claude mcp add meta-instagram-mcp --scope user -- node /absolute/install/path/tools/run.mjs
claude mcp get meta-instagram-mcp
```

В Claude Code Desktop на вкладке Code действует конфигурация Claude Code. Чат Claude Desktop и вкладка Code имеют разные поверхности подключения. См. [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

### Cursor

Добавьте объект в существующий `mcpServers` в user-level `~/.cursor/mcp.json` либо в project-level `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "meta-instagram-mcp": {
      "command": "node",
      "args": ["/absolute/install/path/tools/run.mjs"]
    }
  }
}
```

Не заменяйте весь существующий JSON. См. [официальную документацию Cursor по MCP](https://cursor.com/docs/mcp).

### Claude Desktop chat

Текущая документация Anthropic описывает локальные custom MCP integrations через Desktop Extensions (`.mcpb`). В этом репозитории такого пакета пока нет. Подключение в Claude Code не подключает чат Claude Desktop, а неподтверждённый ручной JSON нельзя считать установленным рабочим вариантом. Следите за [инструкцией установки desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop); не устанавливайте файл `.mcpb`, которого здесь нет.

## Настроить OAuth

Отредактируйте приватный `.env` во внешнем каталоге конфигурации. Оставьте секреты только в этом файле или защищённой переменной окружения:

```env
META_AUTH_MODE=facebook
META_INSTAGRAM_APP_ID=<your-meta-app-id>
META_INSTAGRAM_APP_SECRET=<your-meta-app-secret>
META_INSTAGRAM_REDIRECT_URI=http://localhost:8787/callback
META_INSTAGRAM_SCOPES=instagram_basic,pages_show_list,pages_read_engagement,instagram_manage_insights,instagram_manage_comments
```

Для отдельной Instagram Login app выберите `META_AUTH_MODE=instagram` и её собственные scopes. Для callback запустите из каталога приложения:

```bash
npm run meta:callback
```

Команда загрузит внешний config, откроет локальный callback и не печатает token. Не копируйте callback URL с одноразовым `code=`. После consent через клиент доступны инструменты OAuth и проверки; привязка account/Page зависит от фактически выданных permissions. App Review, Advanced Access, webhook consent и Meta live access настраивает владелец своей Meta App; эта инструкция не означает, что они уже пройдены.

Wrapper читает из внешнего `.env` только явный список поддерживаемых `META_*` и `INSTAGRAM_MCP_*` ключей. Неизвестное имя, в том числе `META_MCP_CONFIG_DIR`, отклоняется; подстановка shell-переменных не выполняется, содержимое трактуется как буквальный текст. Уже заданные переменные процесса имеют приоритет над внешним `.env`, а внешний `.env` — над `.env` внутри исходного checkout. Значения и ошибки не печатаются. На POSIX config-файл должен иметь права `0600`; если doctor сообщает `CONFIG_FILE_PERMISSIONS`, выполните `chmod 600 ~/.config/meta-instagram-mcp/.env`.

### Runtime-параметры и transports

Portable wrapper запускается через `tools/run.mjs`, передаёт runtime-настройки из приватного внешнего `.env` в ту же factory, которая обслуживает stdio и Streamable HTTP. Для HTTP задайте `INSTAGRAM_MCP_TRANSPORT=http`, bearer token длиной не менее 32 байт в `INSTAGRAM_MCP_HTTP_BEARER_TOKEN` и при необходимости host/origin allowlists. Listener принимает только `127.0.0.1`; удалённый доступ размещайте за доверенным TLS reverse proxy. По умолчанию stdio запускает локальное ядро.

Для Mac или другого локального MCP-клиента, который должен подключаться к удалённому Streamable HTTP core, задайте `INSTAGRAM_MCP_REMOTE_CONFIG` либо пару `INSTAGRAM_MCP_REMOTE_URL` и `INSTAGRAM_MCP_REMOTE_BEARER_TOKEN` во внешнем приватном `.env`. URL должен быть HTTPS origin, token — не короче 32 байт. Тогда `tools/run.mjs` запускает stdio-proxy к remote core и не создаёт локальное ядро. Ошибка URL, bearer или соединения останавливает proxy без переключения на локальный server. Одноразовый запуск proxy также доступен через `node tools/cli.mjs remote-proxy`; команда использует тот же внешний `.env`.

`INSTAGRAM_MCP_HUB_STATE_PATH` задаёт durable state Hub. Write gates задаются отдельно: `META_INSTAGRAM_WRITE` для API, `INSTAGRAM_MCP_BROWSER_WRITES` для browser, `INSTAGRAM_MCP_PHONE_WRITES` для phone; удаление дополнительно требует `META_INSTAGRAM_DELETE`. Эти переключатели не создают OAuth scopes, подключение companion, подпись approval или подтверждение конкретного действия. Source readiness и coverage остаются отдельными для API, browser и phone.

## Обновить, откатить или удалить

Для обновления используйте отдельный source checkout и выбранный SHA следующего опубликованного release:

```bash
git fetch --tags origin
git checkout --detach "$REVISION"
./install.sh --revision "$REVISION"
```

```powershell
git fetch --tags origin
git checkout --detach $Revision
.\install.ps1 -Revision $Revision
```

Кандидат собирается отдельно. При неуспешном `npm ci`/build активная версия не меняется. Перед переключением текущий каталог перемещается в соседний `.backup...`; резервные копии автоматически не удаляются. Установщик отвергает существующий каталог без своего install marker, символическую ссылку и несовпадающий SHA.

Для отката выберите полный путь к нужной резервной копии из вывода установщика:

```bash
tools/rollback.sh --target "$HOME/.local/share/meta-instagram-mcp/app" --backup "/path/to/app.backup..."
```

```powershell
.\tools\rollback.ps1 -Target "$env:LOCALAPPDATA\meta-instagram-mcp\app" -Backup "C:\path\to\app.backup..."
```

Откат перемещает выбранную копию обратно в активный каталог, а прежнюю активную версию сохраняет как `.rollback...`. Удаление приложения тоже архивное и требует явного маркера подтверждения:

```bash
./uninstall.sh --confirm REMOVE-APP
```

```powershell
.\uninstall.ps1 -Confirmation REMOVE-APP
```

Uninstall перемещает каталог приложения в `.uninstalled...`; config, token-store и все backups остаются на месте. Они не удаляются автоматически.

## Профили установки и companions

В каждом профиле используется своя конфигурация и отдельный источник readiness. `node tools/doctor.mjs` проверяет локальное stdio соединение; browser/phone readiness и живой Meta access требуют своих проверок.

| Профиль | Узел и prerequisites | Статус и границы |
|---|---|---|
| API stdio | Один компьютер или сервер с Node.js и MCP client; Meta App, professional Instagram account, OAuth scopes/consent | Рабочая форма portable wrapper. Account API status не доказывает, что запрошенные Meta permissions одобрены или работают live. |
| API + server-owned browser | Server runtime и Streamable HTTP/Hub, Chrome на том же узле, MV3 extension, Native Messaging Host, постоянный отдельный Chrome profile | Factory и browser path подключены. Host registration, extension install, server profile login и live UI read-back выполняются отдельно и не подтверждены этим checkout. Владелец входит в постоянный Chrome profile узла через разрешённый private admin GUI или SSH-forwarded desktop; cookies/session с Mac не копируются. |
| External desktop browser | Core/Hub с достижимым защищённым HTTP endpoint; Chrome, extension, Native Messaging Host и собственный bridge config на desktop | `tools/register-native-host.mjs` создаёт per-user host manifest и launcher/registry registration. Extension ID, account binding, соединение с core и live read-back настраиваются отдельно; readiness остаётся gated до проверки. |
| Connected phone | Core/Hub с достижимым защищённым endpoint; iOS требует Mac с Xcode/WDA/Appium, Android — настроенный Appium/UiAutomator2 host | Runtime phone provider подключён. Установка и авторизация Instagram, выбор устройства и live UI QA выполняются отдельно. Phone older-history scrolling не поддерживается; transport readiness не доказывает выбранный аккаунт или рабочий экран. |

Extension ID должен оставаться стабильным между обновлениями: origin в Native Messaging manifest связан с ним. Загружайте unpacked extension из постоянного пути `<app>/browser-extension`; при каждом запуске используйте тот же каталог приложения. Helper откажет при чужом manifest/registry conflict и обновит только собственную подтверждённую регистрацию. Не копируйте browser cookies/session на сервер.

Для чтения runtime пробует API → browser → phone в ограниченном бюджете и сохраняет provenance, coverage, полноту истории и причины пропуска источников. Приоритет не обещает полных данных: API может не иметь scope, browser/phone могут быть offline или не подключены. Старшая история Direct через phone не реализована; API ограничивает окно и размер страницы по своим правилам. Для записи preview закрепляет один source/account/target/context; выполнение требует локального source gate, серверного signed grant для UI-действий и подтверждения точного запроса. При `OUTCOME_UNKNOWN` не повторяйте действие и не переключайте источник автоматически; выполните read-back того же target из того же source.

### Companion с подключённым телефоном

Для обязательных prerequisites, loopback readiness checks и безопасного Direct smoke используйте отдельный [iPhone/Appium operator runbook](ios-appium-operator-runbook.md). Сценарии ниже описывают формат внешней phone-конфигурации и bridge contract.

Телефонный companion запускается на том же компьютере, где доступны выбранное устройство и настроенный Appium. Для iOS нужны Xcode, Appium, WebDriverAgent (WDA) и Instagram; для Android — Appium с UiAutomator2 и Instagram. Конфигурация хранится вне каталога приложения и содержит секрет Hub и идентификатор выбранного устройства — не коммитьте её и не пересылайте вместе с логами.

Создайте `phone-companion.json` в приватном внешнем каталоге. На macOS/Linux задайте права до заполнения файла:

```bash
install -d -m 700 "$HOME/.config/meta-instagram-mcp"
touch "$HOME/.config/meta-instagram-mcp/phone-companion.json"
chmod 600 "$HOME/.config/meta-instagram-mcp/phone-companion.json"
```

На Windows создайте пустой файл в `%LOCALAPPDATA%\MetaInstagramCompanion\phone-companion.json`, закройте DACL для наследования и оставьте Full Control только текущему пользователю, SYSTEM и локальным Administrators. Команда рассчитана на новый файл; не применяйте её поверх неизвестного существующего файла:

```powershell
$ConfigDirectory = Join-Path $env:LOCALAPPDATA 'MetaInstagramCompanion'
$ConfigPath = Join-Path $ConfigDirectory 'phone-companion.json'
New-Item -ItemType Directory -Force -Path $ConfigDirectory | Out-Null
New-Item -ItemType File -Path $ConfigPath -ErrorAction Stop | Out-Null
$CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $ConfigPath /inheritance:r /grant:r `
  "*$($CurrentSid):(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set the private phone configuration ACL.' }
```

Приложение проверит защищённый DACL и отклонит файл с другими или унаследованными ACE.

Заполните файл локально. Значения ниже — placeholders: замените их на адрес защищённого Hub, его bearer, выбранный профиль и свой handle. `baseUrl` — только HTTPS origin; если доверенный reverse proxy публикует bridge под префиксом, задайте `bridgeBasePath`, например `/instagram`. Без этого поля клиент использует корневые `/bridge/*` маршруты. Префикс должен состоять из букв, цифр, `_` или `-` в сегментах пути, без завершающего `/`. `bearerToken` должен содержать не менее 32 байт. Профиль ниже read-only:

```json
{
  "baseUrl": "https://hub.example.invalid",
  "bridgeBasePath": "/instagram",
  "bearerToken": "replace-with-a-random-private-token-of-at-least-32-bytes",
  "mode": "phone_standalone",
  "source": "phone",
  "accountBinding": "instagram:replace-with-private-binding",
  "capabilities": [
    "account.inspect",
    "account.snapshot",
    "inbox.list",
    "conversation.read",
    "comments.list",
    "comments.replies",
    "insights.read",
    "context.refresh"
  ],
  "expectedAccountHandle": "replace-with-your-handle",
  "writeEnabled": false,
  "appium": {
    "serverUrl": "http://127.0.0.1:4723",
    "platform": "iOS",
    "selectedDevice": { "id": "replace-with-locally-selected-device-id" },
    "wdaStatusUrl": "http://127.0.0.1:8100/status",
    "requestTimeoutMs": 5000
  }
}
```

Для Android задайте `platform: "Android"`, замените `wdaStatusUrl` на `deviceStatusUrl` выбранного UiAutomator2 endpoint и оставьте Appium/device endpoints на loopback. `selectedDevice.id` должен точно совпадать с ID, который Appium возвращает для W3C session. Указанный handle должен совпасть с профилем Instagram в приложении; companion не выбирает устройство или аккаунт.

Из каталога установленного приложения запустите companion после сборки runtime:

```bash
INSTAGRAM_MCP_PHONE_CONFIG="$HOME/.config/meta-instagram-mcp/phone-companion.json" node dist/companion/phone.js
```

В Windows PowerShell задайте абсолютный путь и запустите тот же entry point:

```powershell
$env:INSTAGRAM_MCP_PHONE_CONFIG = Join-Path $env:LOCALAPPDATA 'MetaInstagramCompanion\phone-companion.json'
node .\dist\companion\phone.js
```

Companion проверяет Appium и WDA/UiAutomator2, открывает session для выбранного устройства, сверяет handle Instagram, затем регистрируется в Hub и записывает выданные bridge credentials в тот же приватный файл. Регистрация подтверждает только эти gates: она не доказывает, что нужные экраны доступны или UI-действия работают. При `writeEnabled: false` телефон остаётся read-only. Если запись включена отдельно, проверенный набор UI-действий ограничен `comment.like` и `comment.unlike`; остальные phone write intents отклоняются. Реальную готовность устройства, WDA/Appium, аккаунта и UI проверяйте на companion host.

### Browser Native Messaging host

Extension и Native Host source включены в runtime. Сначала установите Chrome, Node.js 22+ и приложение в постоянный каталог; bridge JSON создайте отдельно в приватном config directory с правами `0600` на macOS/Linux. Его JSON содержит `baseUrl`, необязательный `bridgeBasePath`, `bearerToken`, `mode: "browser_native_host"`, `source: "browser"`, `accountBinding`, `expectedAccountHandle` и список разрешённых `capabilities`; `allowBrowserWrites` остаётся `false`, пока запись отдельно не настроена. Не передавайте token в аргументах команд.

Загрузите extension через `chrome://extensions` → Developer mode → Load unpacked, выберите `<app>/browser-extension` и скопируйте показанный Chrome extension ID. Он должен состоять из 32 символов `a`–`p`. Не добавляйте permissions вручную.

### macOS и Linux

Из каталога установленного приложения сначала проверьте план:

```bash
node tools/register-native-host.mjs --dry-run --install-root "$HOME/.local/share/meta-instagram-mcp/app" --config-file "$HOME/.config/meta-instagram-mcp/browser-bridge.json" --extension-id '<32-character-extension-id>'
```

Затем выполните ту же команду без `--dry-run`. Она создаёт executable launcher в `$HOME/.config/meta-instagram-mcp/native-host/`, а Chrome manifest — в `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.alexfisenkov.instagram_companion.json` (macOS) или `~/.config/google-chrome/NativeMessagingHosts/com.alexfisenkov.instagram_companion.json` (Linux). Launcher указывает на абсолютный `node` и `dist/companion/browser-native-host.js`, экспортирует только путь bridge config и extension ID. В manifest записывается один точный origin `chrome-extension://<id>/`.

Если helper недоступен, создайте manifest с теми же пятью полями (`name`, `description`, абсолютный `path` launcher, `type: "stdio"`, `allowed_origins` с единственным точным origin), сохраните его по платформенному пути выше с правами `0600`, а launcher — с `0700`. До ручной записи проверьте, что целевой manifest отсутствует; не заменяйте неизвестную регистрацию.

### Windows PowerShell 7

Нужен `InstagramNativeHost.exe` из self-contained x64 build. CI workflow создаёт 14-дневный artifact для своего run; он не является GitHub Release asset. Его можно собрать из исходников с .NET SDK 8, затем скопировать в фиксированный путь приложения:

```powershell
dotnet publish native-host/windows/InstagramNativeHost.csproj --configuration Release --runtime win-x64 --self-contained true -o artifacts/native-host
```

```powershell
$InstallRoot = Join-Path $env:LOCALAPPDATA 'meta-instagram-mcp\app'
$HostDirectory = Join-Path $InstallRoot 'tools\native-host'
New-Item -ItemType Directory -Force -Path $HostDirectory | Out-Null
Copy-Item 'artifacts/native-host/InstagramNativeHost.exe' (Join-Path $HostDirectory 'InstagramNativeHost.exe')
node tools/register-native-host.mjs --dry-run --install-root $InstallRoot --extension-id '<32-character-extension-id>'
node tools/register-native-host.mjs --install-root $InstallRoot --extension-id '<32-character-extension-id>'
```

Windows host manifest: `%LOCALAPPDATA%\MetaInstagramCompanion\native-host.json`; Chrome registration: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.alexfisenkov.instagram_companion`, whose default value points to that manifest. The EXE derives its install root from `<app>\tools\native-host\InstagramNativeHost.exe`, then starts `node`; install Node.js 22+ and make `node` available in the Chrome process PATH. Bridge config defaults to `%LOCALAPPDATA%\MetaInstagramCompanion\browser-bridge.json`. If an existing registration points elsewhere, helper stops without replacing it. Manual registry fallback after creating and inspecting the manifest:

```powershell
$Manifest = Join-Path $env:LOCALAPPDATA 'MetaInstagramCompanion\native-host.json'
$Key = 'HKCU\Software\Google\Chrome\NativeMessagingHosts\com.alexfisenkov.instagram_companion'
$Existing = if (Test-Path -LiteralPath $Key) { (Get-Item -LiteralPath $Key).GetValue('') } else { $null }
if ($Existing -and $Existing -ne $Manifest) { throw 'Refusing to replace a Native Messaging registration owned by another install.' }
New-Item -Path $Key -Force | Out-Null
Set-Item -Path $Key -Value $Manifest
```

Registering the host does not install or sign the extension, establish bridge credentials, authorize the Instagram account, or prove live UI readiness. On a server-owned profile, perform first login yourself through an allowed private admin GUI or SSH-forwarded desktop on that same node. Keep the session there; do not copy Mac cookies. The fixed extension implements semantic reads with bounded scrolling and approved actions; it does not expose generic selectors, raw clicks or arbitrary page script.

### Контракт соединения

| Часть | Значение |
|---|---|
| Extension | `<app>/browser-extension`; `nativeMessaging` plus только Instagram host permissions. |
| Runtime asset | `<app>/dist/companion/browser-native-host.js`; Windows launcher — `<app>/tools/native-host/InstagramNativeHost.exe`. |
| Host name | `com.alexfisenkov.instagram_companion`; origin allowlist — один `chrome-extension://<id>/`. |
| Private bridge file | macOS/Linux путь задаётся в launcher как `INSTAGRAM_MCP_BRIDGE_CONFIG`; Windows default — `%LOCALAPPDATA%\MetaInstagramCompanion\browser-bridge.json`. |
| Required JSON fields | `baseUrl` (HTTPS origin), `bearerToken`, `mode`, `source`, `accountBinding`, `expectedAccountHandle`, `capabilities`; необязательный `bridgeBasePath` задаёт канонический mount prefix. File values не передаются через argv. |
| Hub routes | Host сам инициирует HTTPS `POST /bridge/register`, `/bridge/heartbeat`, `/bridge/poll`, `/bridge/result`; заданный `bridgeBasePath` ставится перед этими путями, например `/instagram/bridge/register`. Входящий порт на desktop не открывается. |
| MCP listener | По умолчанию `127.0.0.1:8787`; ключи `INSTAGRAM_MCP_HTTP_HOST`, `INSTAGRAM_MCP_HTTP_PORT`, `INSTAGRAM_MCP_HTTP_BEARER_TOKEN`, `INSTAGRAM_MCP_HTTP_ALLOWED_HOSTS`, `INSTAGRAM_MCP_HTTP_ALLOWED_ORIGINS`; public HTTPS ставится через доверенный reverse proxy. |
| Poll bounds | Browser host по умолчанию опрашивает раз в 1 секунду, batch 10 задач; poll interval ограничен 250–30 000 мс, Hub принимает не более 20 задач за poll. |
| Read bounds | Browser older-history scroll ограничен 5 страницами; inbox/thread operations используют переданный bounded `limit`. |
| Readiness handoff | Registration подтверждает только manifest/registry. Отдельно проверяются bridge heartbeat, `account.inspect`, ожидаемый account handle и source read-back; live UI readiness не предполагается. |

Локальный doctor запускается так:

```bash
node tools/doctor.mjs
```

Он устанавливает локальное MCP SDK соединение, делает `initialize`, перечисляет tools, вызывает `meta_auth_status` и, только если сервер выставил read-only capability/status tool, читает его статусы. Вывод содержит только booleans, число tools и известные статусы источников; account IDs, scopes, tokens и ответы API не печатаются. Doctor не проверяет доступ Meta live, Chrome login, телефон, внешний HTTPS gateway или фактическую отправку.
