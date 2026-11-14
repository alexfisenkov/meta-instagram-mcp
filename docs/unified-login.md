# Подключить Instagram через Unified Login

Если в Meta App Dashboard показано **API setup with Unified login**, выберите `META_AUTH_MODE=unified`. Этот режим использует Meta App ID/Secret, configuration ID и Business Integration System User token (BISU). Facebook Page не требуется. `instagram` и `facebook` остаются для соответствующих прежних настроек; тип приложения нельзя определить только по его названию.

Нужен профессиональный Instagram Business/Creator и business portfolio. Для своей Meta App используйте её Development/test setup. Доступ сторонних пользователей требует соответствующих разрешений и допуска Meta; установка MCP сама по себе их не выдаёт.

## Обновить установленный MCP

Откройте [последний опубликованный релиз](https://github.com/alexfisenkov/meta-instagram-mcp/releases/latest) и обновите его штатным установщиком по [инструкции](install.md#обновить-откатить-или-удалить). Установщик сохраняет внешний `.env`, token-store и резервную копию программы. Перезапустите MCP в клиенте и проверьте `meta_auth_status`: `runtime.packageVersion` и `runtime.sourceRevision` должны соответствовать релизу.

Рабочее подключение прежнего типа можно сохранить. При смене login family используйте отдельный config/token-store: активные credentials автоматически не переводятся в другой режим. Обновление программы само по себе не запускает вход и не меняет Meta App.

### Сохранить прежнее подключение отдельно

Если прежнее подключение уже работает, создайте рядом новый приватный каталог конфигурации, например `meta-instagram-mcp-unified`. Скопируйте в него `.env.example` из обновлённой установки как `.env`, выставив права каталога `0700` и файла `0600` на macOS/Linux либо приватный ACL своего пользователя на Windows. Значения прежнего секретного `.env` в чат не переносите. Для Windows приватную конфигурацию может подготовить штатный установщик с отдельными `-Target` и `-ConfigDir` по [инструкции](install.md).

В нужном MCP-клиенте добавьте отдельную запись подключения с прежней командой `node` и абсолютным путём к обновлённому `tools/run.mjs`, но с environment `META_MCP_CONFIG_DIR`, указывающим **абсолютный путь нового каталога**. В конфигурации Codex это отдельная секция вида:

```toml
[mcp_servers.instagram_unified]
command = "node"
args = ["/absolute/install/path/tools/run.mjs"]
env = { META_MCP_CONFIG_DIR = "/absolute/private/path/meta-instagram-mcp-unified" }
```

Для клиентов с JSON `mcpServers` тот же параметр задаётся в `env` нужной записи:

```json
{
  "mcpServers": {
    "instagram_unified": {
      "command": "node",
      "args": ["/absolute/install/path/tools/run.mjs"],
      "env": { "META_MCP_CONFIG_DIR": "/absolute/private/path/meta-instagram-mcp-unified" }
    }
  }
}
```

Замените примеры на реальные пути своей ОС; в JSON Windows обратные слэши экранируются. Прежние записи клиента сохраните. В новом каталоге wrapper сам выберет отдельный `token.json`; прежний конфиг и токен останутся нетронутыми. Перезапустите только новое подключение и выполняйте проверку через него. `META_MCP_CONFIG_DIR` задаётся в окружении клиента, а не внутри `.env`.

## Своя Meta App: тестовый токен из Dashboard

Этот путь не требует собственного HTTPS callback-сервера:

1. В Meta App откройте **Use cases → Manage messaging & content on Instagram → Customize → API setup with Unified login**. Настройте конфигурацию и права для нужных задач.
2. В **Generate access tokens** добавьте свой профессиональный аккаунт как Instagram Tester. Примите приглашение в Instagram web: **Settings → Website permissions → Apps and websites → Tester Invites**. Затем выберите **Generate token** и лично завершите вход.
3. Сами откройте внешний приватный `.env` установленного MCP. Если переходите с `facebook`/`instagram`, оставьте прежний token-store на месте и задайте `META_TOKEN_STORE_PATH` как новый абсолютный путь к ещё не существующему файлу, например `~/.config/meta-instagram-mcp/unified-token.json` с развёрнутым домашним путём (буквальная `~` не раскрывается). При нескольких MCP используйте отдельный приватный config directory и передайте его только выбранному процессу через `META_MCP_CONFIG_DIR` в env настройки MCP-клиента. Не добавляйте `META_MCP_CONFIG_DIR` внутрь `.env`: загрузчик его там отклоняет. Файл по умолчанию — `~/.config/meta-instagram-mcp/.env`, на Windows — `%USERPROFILE%\.config\meta-instagram-mcp\.env`. Введите значения непосредственно в нём. Не отправляйте токен, App Secret, code или callback URL с параметрами в чат, issue или журнал.
4. Выставьте `META_AUTH_MODE=unified`, `META_INSTAGRAM_APP_ID`, `META_INSTAGRAM_APP_SECRET`, `META_INSTAGRAM_ACCESS_TOKEN`. Используйте **Meta App ID/Secret**, а не отдельные Instagram App ID/Secret. Удалите прежний явный `META_INSTAGRAM_SCOPES` либо задайте Unified names. Удалите прежний `META_FACEBOOK_PAGE_ID`. Прежний `META_GRAPH_API_VERSION=v25.0` удалите или замените на `v27.0`; пустое/отсутствующее значение использует Unified default `v27.0`.
5. Перезапустите MCP. Вызовите `meta_auth_status` с `{"verify":true}`. Для исправного BISU должны подтвердиться действующий токен, собственная App и тип SYSTEM_USER; чтение конкретного аккаунта проверяется следующим шагом.
6. Вызовите `meta_resolve_instagram_account` без токена в аргументах. MCP сам проверит grant и найдёт доступный Instagram account. Если их несколько, сначала прочитайте `meta_raw_get` с `path: "/me/assigned_instagram_accounts"`, затем выберите нужный через аргумент `userId` в resolver. Используйте Instagram asset ID из этого списка, а не system-user ID `/me`.
7. Проверьте `meta_get_account_info` и `meta_list_media` с небольшим `limit`. Только успешное чтение нужного аккаунта подтверждает эту часть подключения. Для Direct/comments/insights нужны отдельные подтверждённые права; пустой результат не доказывает их наличие.

Для этой ручной проверки `META_INSTAGRAM_CONFIG_ID` и redirect не нужны: они относятся к запуску OAuth из MCP. `oauthSetup.ready:false` показывает отсутствие настройки OAuth, даже если Dashboard-token путь уже работает.

Токен из environment имеет приоритет над token-store. При его замене сначала выберите новый `META_TOKEN_STORE_PATH`, сохранив старый файл как резервную копию, затем повторите проверку и выбор аккаунта. Другой токен не перезаписывает занятый store автоматически. MCP не наследует права другого сохранённого токена и не подменяет им неработающий environment token. Записи и публикации остаются выключены до отдельного включения и явной команды.

## OAuth из MCP с HTTPS callback

Этот путь подходит, если у вас уже есть управляемый HTTPS endpoint. В приватном конфиге задайте:

```dotenv
META_AUTH_MODE=unified
META_INSTAGRAM_APP_ID=
META_INSTAGRAM_APP_SECRET=
META_INSTAGRAM_CONFIG_ID=
META_INSTAGRAM_REDIRECT_URI=https://your-owned-domain.example/callback
META_INSTAGRAM_SCOPES=instagram_basic,instagram_manage_insights,instagram_manage_comments
META_OAUTH_CALLBACK_LISTEN_PORT=8787
```

В Dashboard создайте или выберите **Instagram Login Compatible** конфигурацию Facebook Login for Business. Её numeric ID — `META_INSTAGRAM_CONFIG_ID`. Точный HTTPS redirect зарегистрируйте в настройках Meta. Права выдаются конфигурацией; запрашиваемый preset сам по себе не подтверждает grant.

Для standalone helper используйте `node tools/cli.mjs callback` из установленного приложения. Он слушает только `127.0.0.1` на заданном порту. Ваш TLS proxy должен передавать точный callback path и query в этот listener; его access logs должны скрывать OAuth code/state/query. MCP не создаёт публичный туннель и не открывает локальный порт в интернет. Для server runtime тот же HTTPS endpoint можно направить на OAuth route его HTTP listener.

Helper открывает официальный вход в обычном браузере. Для настроенного HTTP runtime можно открыть state-bound authorization URL из `meta_begin_oauth`. Callback завершает flow только в процессе/хранилище, выдавшем этот state. `meta_build_login_url` — URL preview, он не заменяет выдачу одноразового state. Не копируйте код или полный callback в чат. После callback перезапустите MCP при необходимости и проверьте account/media чтение.

Unified использует `graph.facebook.com`, BISU и `/me/assigned_instagram_accounts`. Поле `/me.id` — system-user ID, не Instagram account. В token-store сохраняется проверенный Instagram ID. Если конфигурация или привязка изменилась, старый state отклоняется. Ошибки входа, нехватка прав, неизвестный аккаунт и конфликт записи сохраняют прежние credentials.

`meta_refresh_token` для Unified возвращает `UNIFIED_REAUTH_REQUIRED`: нужен новый вход или новый Dashboard token. MCP не применяет несовместимый Facebook/Instagram refresh. Нулевой срок в Meta означает лишь отсутствие сообщённого expiry; отзыв разрешений и ограничения аккаунта всё равно возможны.

## Ограничения действий

Этот выпуск проверяет новую авторизацию и чтение через Unified. Private reply на комментарий и реакции Direct для Unified пока отключены; их нельзя получить включением write flag. Предыдущие проверенные пути прежних login families сохраняются. Фактическая отправка/публикация требует отдельной команды, прав Meta и проверки результата.

## Проверка безопасности Instagram и сбой клиента

Экран **Log in on another device to continue** — проверка безопасности Instagram. Подтвердите вход вручную на уже знакомом устройстве и убедитесь, что обычный вход в Instagram работает. MCP не может подтвердить её за владельца. Бесконечная загрузка на этом шаге требует отдельной проверки аккаунта/браузера; не запускайте повторные OAuth flows бесконечно.

Если встроенный браузер закрывает Codex или другой AI-клиент, сохраните без секретов версию клиента/ОС и точный шаг сбоя. Сам официальный вход можно открыть вручную в обычном браузере. Обновление MCP не считается доказанным исправлением падения приложения.

## Официальные источники

- [Unified Login: возможности и сравнение setup](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login).
- [Начало: configuration, test token, HTTPS callback и asset IDs](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started).
- [Authentication и access tokens](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication).
- [Eligibility и troubleshooting](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/eligibility-and-troubleshooting).

Документация сверена 14.11.2026. Синтетические тесты и CI не подтверждают live-доступ отдельного аккаунта.
