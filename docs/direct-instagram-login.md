# Прямой официальный Instagram Login

Выбирайте этот путь после проверки, что ваша Meta App действительно предлагает **API setup with Instagram login** / **Instagram business login**. Нужен профессиональный Instagram Business/Creator. Для этого setup business portfolio и Facebook Page не обязательны; ограничения самой App и допуск Meta остаются в силе. Если нужного setup нет, вернитесь к [выбору пути](connect-instagram.md) — не подставляйте Unified credentials в прямой вход.

## Вариант 1: токен из Dashboard, без callback-сервера

1. В подходящем Instagram setup добавьте свой профессиональный аккаунт для тестирования и если Meta выдала приглашение Instagram Tester — примите его в Instagram web: **Настройки → Разрешения для сайтов (Website permissions) → Приложения и сайты (Apps and websites) → Приглашения тестировщика (Tester Invites)**. Проверьте, что это приглашение именно вашей App; это не приглашение Facebook-профиля в business portfolio. На странице **Generate token** завершите вход самостоятельно.
2. Откройте приватный внешний `.env` своего MCP. По умолчанию это `~/.config/meta-instagram-mcp/.env`; Windows — `%USERPROFILE%\.config\meta-instagram-mcp\.env`. Не помещайте секреты в рабочий репозиторий или чат. При переходе с другого режима используйте отдельный config/token-store по [регламенту изоляции](unified-login.md#сохранить-прежнее-подключение-отдельно).
3. Выставьте `META_AUTH_MODE=instagram` и лично введите полученный **Instagram User access token** в `META_INSTAGRAM_ACCESS_TOKEN`. Старый `META_FACEBOOK_PAGE_ID` для этого пути не нужен. Уберите явно заданные Unified/Facebook scopes; для первого подключения достаточно `instagram_business_basic`. API version можно явно задать `v27.0`, если старый конфиг закрепляет другое значение.
4. Для этого ручного пути App Secret, config ID и redirect не нужны: они относятся к запуску OAuth из MCP. Отсутствие этих значений в `oauthSetup` не означает, что Dashboard token непригоден.
5. Перезапустите MCP. Выполните `meta_resolve_instagram_account` без токена в аргументах. MCP делает свежий запрос `/me`, требует профессиональный `user_id` и username, проверяет ожидаемую привязку и сохраняет её для следующих чтений. App-scoped `id` не используется вместо `user_id`.
6. Выполните `meta_get_account_info`, затем `meta_list_media` с `limit:3`. Ожидаемый профиль и успешное чтение подтверждают эту часть подключения. Права на другие операции проверяются отдельно: по одному profile read нельзя объявить все scopes выданными.

Environment token имеет приоритет. Сохранённый ID используется только если он привязан к тому же токену и login family. Новый токен не перезаписывает занятый store автоматически: сохраните старый файл и выберите отдельный абсолютный `META_TOKEN_STORE_PATH`, затем повторите проверку. Буквальная `~` внутри `.env` не раскрывается.

`meta_auth_status({verify:true})` для прямого режима пока не выполняет App-bound `debug_token` проверку и честно возвращает `unsupported_auth_mode`. Проверяйте профиль/media указанными инструментами; не делайте вывод о неисправном токене только по этому коду. Права Dashboard token остаются `unknown`, если их отдельное доказательство отсутствует; MCP не переносит labels другого сохранённого credential.

## Вариант 2: официальный OAuth из MCP

В личном конфиге задайте credentials именно **Instagram App**, показанные в direct setup, и точно зарегистрированный redirect:

```dotenv
META_AUTH_MODE=instagram
META_INSTAGRAM_APP_ID=
META_INSTAGRAM_APP_SECRET=
META_INSTAGRAM_REDIRECT_URI=http://localhost:8787/callback
META_INSTAGRAM_SCOPES=instagram_business_basic
META_GRAPH_API_VERSION=v27.0
```

Loopback HTTP используется только если его принимает ваш конкретный direct setup в Dashboard. Если Meta его не позволяет, выберите Dashboard-token путь выше или собственный зарегистрированный HTTPS endpoint с настроенным proxy. Не переносите разрешение на HTTP в Unified: там действует требование HTTPS.

Из установленной папки запустите `node tools/cli.mjs callback`. Helper открывает официальный вход в обычном браузере; пользователь вводит секреты и проходит проверки сам. Не копируйте authorization code или полный callback URL в чат. Для настроенного HTTP runtime `meta_begin_oauth` использует тот же state-bound путь; URL preview `meta_build_login_url` его не заменяет.

MCP принимает однозначный ответ Meta: flat grant либо один элемент `data[0]`. Смешанные, пустые, множественные ответы и конфликтующие IDs отклоняются до замены credentials. Короткий OAuth ID сверяется со свежим профессиональным профилем; фактические permissions CSV/array сохраняются из ответа, а при их отсутствии остаются неизвестными. Старые права не наследуются. Сохранение защищено от конкурентной смены store и привязки к другому аккаунту.

Для дополнительных задач используйте только нужные permissions после проверки их доступности. Analytics/comments/inbox не запрашиваются без необходимости при первом базовом подключении. Выданные scopes и локальный write gate — разные вещи; обновление не включает публикации и отправку сообщений.

## Обновление старой привязки ID

В старых установках в userId мог быть сохранён app-scoped ID. При resolve/повторном OAuth MCP требует свежий `/me` с отдельными `id` и профессиональным `user_id`, сверяет прежнюю привязку с этим профилем и только затем сохраняет canonical user_id через прежний CAS. Новый store помечается `identityKind:instagram_professional_user_id`; такую привязку нельзя подменить совпавшим app-scoped ID другого ответа. Если старый ID не подтверждается, миграция отказывается и файл сохраняется. Явно заданный `META_INSTAGRAM_USER_ID` остаётся строгим профессиональным pin: если в старом конфиге туда вручную внесён app-scoped ID, сначала прочитайте профиль через `meta_get_account_info`, подтвердите ожидаемый аккаунт и исправьте только этот pin с сохранением копии конфига. Автоматически ослаблять явную привязку MCP не будет.

## Что делать при отказе

- `Invalid platform app`: проверьте выбранный setup и пару Instagram App ID/Secret. Meta App credentials из Unified не равны Instagram App credentials. Не переключайтесь автоматически на Facebook Login.
- `OAUTH_IDENTITY_UNVERIFIED`: ответ не подтвердил нужный профессиональный профиль. Не подменяйте `user_id` общим `id`; сохраните старый store и уточните setup/аккаунт.
- `OAUTH_IDENTITY_MISMATCH`: получен другой профиль либо не совпали подтверждаемые IDs. Остановите замену аккаунта.
- `TOKEN_STORE_NOT_EMPTY` / `TOKEN_STORE_AUTH_MODE_MISMATCH`: старое хранилище не подходит новому credential/login family. Сохраните его; для нового пути нужен отдельный приватный state.
- `INSTAGRAM_OAUTH_EXCHANGE_FAILED` / `INSTAGRAM_TOKEN_REFRESH_FAILED`: не повторяйте использованный OAuth code по кругу; уточните конфиг, сеть и выдайте новый state через новый flow.
- Ошибка добавления пользователя или App в business portfolio: остановите бизнес-настройки. Проверьте, действительно ли выбран direct setup, и рассмотрите [браузер](browser-only.md).
- Instagram просит подтвердить вход на знакомом устройстве: это действие владельца, MCP его не обходит.

## Первоисточники

- [Business Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login): authorize URL, Boolean `enable_fb_login`/`force_reauth`, exchange, actual permissions, long token.
- [Get Started](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started): Dashboard token, `/me` и различие `id`/`user_id`, media.
- [Сравнение login setups](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login): различия portfolio, token family и Graph host.

Документация сверена 16.11.2026. Синтетические проверки не заменяют личный вход и фактический доступ конкретной App.
