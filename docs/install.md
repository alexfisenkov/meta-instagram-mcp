# Установка и обновление

В этом репозитории предусмотрены два способа работы:

- portable MCP для Node.js с конфигурацией и token-store вне каталога приложения;
- четыре целевых профиля развёртывания, у которых разная готовность. API stdio — текущая локальная форма. HTTP server mode, browser host и phone companion нельзя считать доступными, пока их интеграция и проверки не вошли в опубликованный release. Сверяйтесь с [матрицей возможностей](capabilities.md).

## Требования

- Git 2.30+;
- Node.js 20 или новее и соответствующий npm;
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

Внешний env wrapper читает только `META_*`-параметры, оставляет уже заданные переменные окружения приоритетными и не пишет значения в log. На POSIX-системах config `.env` должен иметь права `0600`; если doctor сообщает `CONFIG_FILE_PERMISSIONS`, выполните `chmod 600 ~/.config/meta-instagram-mcp/.env`.

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

## API и будущие companions

Серверный install profile, постоянный Chrome профиль, Native Host/extension и phone companion имеют отдельные prerequisites и readiness gates; схема описана в [профилях возможностей](capabilities.md). Server+browser использует отдельный профиль Chrome самого узла. Первый вход выполняет его владелец через разрешённый private admin GUI или SSH-forwarded desktop; сессия остаётся на узле. Cookies с личного Mac не копируются. iOS companion требует Mac с настроенными Xcode/WDA/Appium; Android возможен только после отдельной настройки.

Целевой порядок автоматического выбора источника для чтения: API → browser → phone. В этом checkout единый router ещё не подключён, поэтому этот приоритет пока не означает автоматический fallback; фактический ответ должен сохранять source и coverage. Для записи целевой контракт закрепляет один source в подтверждённом preview: после `OUTCOME_UNKNOWN` не повторяйте действие и не переключайте источник автоматически; выполните read-back того же target из того же source.

### Browser Native Messaging host

В checkout есть исходники extension и Windows host, но установщик пока не регистрирует host и не устанавливает extension. Для соединения Native Messaging manifest поле `allowed_origins` должно содержать точный origin установленного extension вида `chrome-extension://<32-character-extension-id>/`. Private bridge JSON должен задавать `expectedAccountHandle`; значение проверяется с текущим Instagram аккаунтом. Windows host по умолчанию читает config из `%LOCALAPPDATA%\MetaInstagramCompanion\browser-bridge.json`; путь можно переопределить переменной `INSTAGRAM_MCP_BRIDGE_CONFIG`. Храните этот файл локально с доступом только владельца и не помещайте bridge credentials или extension ID в публичные логи и отчёты.

CI публикует самодостаточный Windows x64 host как artifact `instagram-native-host-win-x64`. Для самостоятельной сборки из исходников нужны .NET SDK 8 и команда:

```powershell
dotnet publish native-host/windows/InstagramNativeHost.csproj --configuration Release --runtime win-x64 --self-contained true -o artifacts/native-host
```

Локальный doctor запускается так:

```bash
node tools/doctor.mjs
```

Он устанавливает локальное MCP SDK соединение, делает `initialize`, перечисляет tools, вызывает `meta_auth_status` и, только если сервер выставил read-only capability/status tool, читает его статусы. Вывод содержит только booleans, число tools и известные статусы источников; account IDs, scopes, tokens и ответы API не печатаются. Doctor не проверяет доступ Meta live, Chrome login, телефон, внешний HTTPS gateway или фактическую отправку.
