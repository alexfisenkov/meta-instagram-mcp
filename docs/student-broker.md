# Hosted Meta broker для пользовательских подключений

Отдельный `dist/student-server.js` обслуживает подключения разных пользователей. Legacy single-account stdio/HTTP runtime, его environment token и companions в этот процесс не подключаются. Запуск не публикует материалы, не отправляет сообщения и не меняет рекламу.

## Контракт платформы

Listener привязан к `127.0.0.1`; перед ним нужен управляемый TLS proxy. `/student/mcp` доступен только сервису платформы: `Authorization: Bearer <service-token>` и `X-Meta-Subject: <HS256-JWT>`. Подписанный subject выводит сама платформа из текущей сессии. Claims: `iss=masterskaya-platform`, `aud=meta-student-broker`, `tenantId=masterskaya`, внутренний `sub`, целые `iat/exp`, срок не больше 60 секунд. Будущее `iat`, истёкший JWT, чужие issuer/audience/tenant и повторные security headers отклоняются. Публичный браузер получает только DTO от платформы.

SDK Streamable HTTP поддерживает обычный MCP initialize, notifications, tools/list и tools/call. Для POST клиент отправляет `Content-Type: application/json` и `Accept: application/json, text/event-stream`. Каталог содержит ровно пять инструментов:

| Инструмент | Аргументы | Результат |
|---|---|---|
| `meta_connections_catalog` | `{}` | `products[]`: product, label, status, capabilities, reason? |
| `meta_connections_list` | `{}` | `connections[]`: id, product, status, account{id,label}, capabilities, updatedAt, reason? |
| `meta_connections_begin` | `{product}` | authorizationUrl, expiresAt |
| `meta_connections_disconnect` | `{connectionId}` | connection |
| `meta_connections_read` | `{connectionId,operation,limit?,cursor?,mediaId?}` | data, coverage, source, updatedAt, limitations |

Product: `instagram | facebook | messenger | threads | ads | whatsapp`. Operation: `account | posts | metrics | comments | inbox`. Connection id — UUID брокера; account id — отдельный native provider asset id. Tool schemas строгие: subject, token, произвольный Graph path, URL и дополнительные поля не принимаются. Комментарии читаются только после проверки mediaId в собственной коллекции выбранного asset; окно ограничено 1000 публикациями, за его пределами чтение закрывается. Provider URLs из paging не выдаются и не выполняются; используется только проверенный непрозрачный cursor.

## Конфигурация

`student-broker.config.example.json` — шаблон приватного реестра. Он содержит имена environment references, не credentials. Реальный файл и secret environment размещают вне checkout. `admission=disabled` по умолчанию. `test` допускает только перечисленные внутренние subject ids; остальные видят `review_required`. `live` устанавливает оператор после независимой проверки нужного App Review/Advanced Access и рабочего режима. Эта настройка описывает admission, а не доказывает свежий доступ Meta. Фактические capabilities связи выводятся из проверенного grant и обнаруженных assets.

Значение `configId: "0"` в шаблоне — заглушка оператора: до admission замените её на точный numeric configuration ID своего login setup. App IDs и secrets читаются только по названным env references. Threads требует свою пару Threads App ID/Secret, Unified — Meta App ID/Secret. Один JSON record соответствует одному продукту; config keys уникальны.

| Environment | Требование |
|---|---|
| `META_BROKER_SERVICE_TOKEN` | Независимый случайный service secret, минимум 32 символа. |
| `META_BROKER_SUBJECT_KEY` | Base64 ключ HS256, минимум 32 декодированных байта. Тот же ключ установлен в API платформы. |
| `META_BROKER_VAULT_KEY` | Другой base64 ключ, ровно 32 декодированных байта для AES-256-GCM. |
| `META_BROKER_STATE_DIR` | Абсолютный путь приватного состояния вне checkout/install tree. |
| `META_BROKER_PLATFORM_ORIGIN` | Единственный HTTPS origin платформы без завершающего `/`; возврат всегда `/social?meta=connected\|cancelled\|error`. |
| `META_BROKER_CALLBACK_URL` | Точный зарегистрированный HTTPS redirect URI; путь `/meta/oauth/callback` или `/student/oauth/callback`. |
| `META_BROKER_CONFIG_FILE` | Необязательный приватный JSON реестр. При отсутствии все продукты `not_configured`. |
| `META_BROKER_PORT` | Порт loopback, по умолчанию 8788. |
| `META_BROKER_REFRESH_INTERVAL_MS` | Интервал lifecycle scheduler: 1000–3600000 ms, по умолчанию 60000. |
| `META_BROKER_OPERATOR_NAME` | Название оператора для публичных legal pages; не встраивается в source tree. |
| `META_BROKER_PRIVACY_CONTACT` | Контактный email оператора. Если name или email отсутствуют, legal pages возвращают 503 `not_configured`. |

```sh
npm ci
npm run typecheck
npm test
npm run build
# Secrets доставляет service manager; команда не читает legacy .env.
node dist/student-server.js
```

Proxy пропускает только публичные callbacks на внутренние `/student/oauth/callback` и `/student/webhooks/<configKey>`. В upstream Host должен быть `127.0.0.1:<port>`. `/student/mcp` и `/health` остаются в доверенном сервисном контуре. GET `/health` возвращает `{status:"ok"}`; это доказательство listener, не live Meta access. Браузерные Origin на сервисном endpoint не допускаются. Access logs proxy должны скрывать query callback, OAuth code/state и verify token. Не публикуйте systemd environment, vault, cookies или provider payload.

GET `/privacy` и `/data-deletion` — публичные русские страницы с данными оператора из environment, HTML escaping, CSP, nosniff и no-store. При внешнем префиксе proxy отображает их на `/meta/privacy` и `/meta/data-deletion`. Это текстовые инструкции без формы и сохранения ввода; POST отклоняется. Удаление данных запрашивается по email и выполняется вручную после проверки принадлежности, без запроса паролей, токенов, паспорта или личной переписки. Страница не обещает автоматического удаления оригиналов в Meta или всех backup/third-party копий.

## OAuth и шесть продуктов

State содержит hash случайного 256-bit значения и привязку к subject/product/provider/config fingerprint/точному return target, действует десять минут и атомарно потребляется до обмена кода. Denial также потребляет state. Fingerprint включает только семантику OAuth grant: product/key/provider, app id/secret, config id, API version и callback. Изменение этих полей закрывает прежний grant/flow. Admission, test subject allowlist и webhook verify token не меняют identity grant; текущая admission policy заново проверяется при callback и read. Новый begin того же subject/product повышает generation и заменяет прежний pending flow, поэтому поздний старый callback не возвращает снятые assets. Disconnect также отменяет pending OAuth и блокирует уже начатый exchange.

Успешный повторный consent в одной транзакции обновляет все подтверждённые assets выбранного subject/product и отключает отсутствующие в новом полном discovery. Их events удаляются; старый grant теряет credential, когда у него не осталось active assets. Другие продукты, субъекты и законные assets общего grant сохраняются.

| Продукт | Семейство и discovery | Доступное чтение |
|---|---|---|
| Instagram | `instagram_unified`, Facebook authorization с config_id; direct BISU exchange; `/me?fields=id,client_business_id`, `/me/assigned_instagram_accounts`. Один grant может содержать несколько IG assets. | Профиль/публикации; reach, комментарии и inbox metadata при соответствующих фактически выданных permissions. |
| Facebook Pages | `facebook_business`; USER `/me/accounts` с Page tokens или SYSTEM_USER `/me/assigned_pages`. Каждая Page проверяется своим credential. | Профиль/публикации; комментарии при дополнительном grant. |
| Messenger | `facebook_business`, те же Page identities с отдельным product config. | Профиль и metadata списка conversations при фактических messaging/metadata/engagement grants. |
| Threads | Собственная authorization и code exchange; long-lived upgrade и отдельный app-token inspection. | Профиль/посты; replies и фиксированный набор insights при фактических grants. |
| Meta Ads | `facebook_business`, `/me/adaccounts`; granular target scopes ограничивают account ids. | Профиль ad account и account insights за последние 30 дней. |
| WhatsApp Business | `facebook_business`, `/me/assigned_whatsapp_business_accounts`, затем WABA `/phone_numbers`. Phone и parent WABA сохраняются раздельно. | Профиль номера; только сохранённые подписанные входящие text webhook events при messaging grant. Исторического Cloud API inbox здесь нет. |

Scope inspection требует `debug_token` с `is_valid`, совпадением app_id, scope names, допустимыми expiry и granular_scopes. Requested scopes не становятся granted. Unified требует SYSTEM_USER и client_business_id; `/me` не превращается в Instagram identity. Неизвестный или неподтверждённый grant отказывает до сохранения. Configured API version задаётся явно, не подменяется версией legacy runtime.

Для Threads inspector получает отдельный app access token через официальный `client_credentials` GET `https://graph.threads.com/oauth/access_token` и использует именно выданный app token в Authorization для `debug_token`, включая проверку после refresh. Facebook-форма app id/secret с разделителем не используется для Threads: его собственный app credential имеет префикс `TH|`. App token также содержит секрет и остаётся только на сервере. Источник: [Threads App Access Tokens](https://developers.facebook.com/documentation/threads/get-started/app-access-tokens), обновление 18.08.2026.

Точные fixed hosts: Facebook authorization `https://www.facebook.com/dialog/oauth`; Threads authorization `https://threads.com/oauth/authorize`, code exchange `https://graph.threads.com/oauth/access_token`. Long-lived и refresh Threads — `https://graph.threads.com/access_token` и `/refresh_access_token`. Meta Graph — `https://graph.facebook.com/<configured-version>`. Ни caller, ни реестр не могут добавить provider host или URL. Redirect upstream запрещён; каждый request ограничен временем и размером ответа, без сетевого retry.

Одна exchange/read/refresh операция ограничена 32 provider requests и общим 30-секундным deadline; один HTTP request — максимум 8 секунд/1 MiB ответа. Discovery edge ограничен десятью страницами по 100 записей. Превышение закрывает операцию с явным error, не возвращает притворно полный набор assets.

## Credential lifecycle и хранение

Vault хранит отдельные grant, connection asset, OAuth state и webhook event records. Весь файл шифруется AES-256-GCM; credentials дополнительно шифруются с AAD tenant/subject/grant/provider. Ключ не хранится рядом с ciphertext. Каталог приватный, файл 0600 на POSIX; для Windows применяются существующие ACL-проверки. Одновременно допускается один writer на весь state root через atomic directory lock, включая разные процессы. Внутри процесса транзакции сериализованы, перед записью проверяется ciphertext CAS, затем fsync/atomic rename. Несколько replicas с одним filesystem state не поддерживаются.

Если rename уже изменил файл, а последующий directory fsync завершился ошибкой, операция сообщает `vault_commit_uncertain`: кандидат data/hash остаётся согласованным с собственным rename, но snapshot/reads и обычные writes закрываются. Следующий access-reducing disconnect допускается только после точного ciphertext CAS и снимает quarantine лишь после успешной durable записи. При несовпадении файла или повторной ошибке доступ остаётся закрыт. Не повторяйте OAuth/refresh как якобы несостоявшуюся операцию; проверьте filesystem и выполните безопасный disconnect либо offline purge. Такой отказ не означает, что rename не произошёл, и не даёт гарантии переживания аварийного отключения питания до исправления fsync.

Штатный SIGTERM закрывает listener, дожидается lifecycle и освобождает lock. После аварийного падения оставшийся `.writer-lock` сам не удаляется: оператор сначала доказывает, что старый процесс остановлен, сохраняет vault/key отдельно и снимает stale lock вручную. Копирование только vault без ключа не восстанавливает grant. Не удаляйте и не ротируйте ключ без отдельного recovery плана. Смена ключа не реализована; нужна контролируемая миграция.

Threads refresh выполняется до expiry, в семидневном окне и только после первых 24 часов жизни токена. Scheduler использует реальный expires_in/inspection expiry. Результат обновляет credential только при прежнем ciphertext, active grant и хотя бы одном active asset; завершившийся после disconnect/rotation refresh не восстанавливает доступ. BISU/SUAT не получает выдуманный 60-дневный срок или Facebook long-lived exchange. Неподдерживаемая refresh-схема требует reconnect. Invalid/expired/revoked grant переводит все связанные assets в `reauth_required`; invalid token не повторяется автоматически.

После Threads refresh заново проверяются app/user/scopes и data-access expiry: обновление срока самого токена не скрывает отдельное истечение permission grant. Потеря прежнего scope требует reconnect. Неопределённый исход refresh также закрывается для автоматического повтора (`refresh_outcome_unknown`); оператор/пользователь проходит новый consent, а старый credential не используется.

Facebook Login USER token проходит официальный `fb_exchange_token` upgrade до discovery, затем повторную app/user/grant inspection. Эта ветка никогда не применяется к Unified или SYSTEM_USER. Его дальнейший неподдержанный автоматический refresh не имитируется: фактический expiry требует нового consent.

Disconnect немедленно закрывает локальный доступ. При отключении одного из нескольких assets общий grant остаётся active; после последнего credential стирается логически из новой encrypted версии файла. Meta permission revoke, WABA subscription, signup/phone registration и удаление Meta данных — отдельные внешние операции; этот сервер их автоматически не делает. Старые backup ciphertext и уже отправленный provider request нельзя отозвать локальной записью; результат concurrent read перед выдачей дополнительно сверяется со статусом connection.

Политика истории: отключённая connection сохраняет subject, продукт, native account id/label и parent asset id при наличии, внутренние connection/grant ids, статус/reason и дату. Capabilities отключённой связи очищаются. После последнего active asset grant сохраняет только служебную связь/статус/дату; provider user/business id, scope set, expiry и credential очищаются. Эти метаданные нужны для отображения истории отключения и остаются до проверенного запроса на удаление; они не дают доступ к Meta. Запрос на полное удаление subject выполняется отдельной offline-процедурой ниже.

Webhook сначала проверяет подпись исходного body секретом конкретного config key, затем распределяет каждый entry только по активным собственным connection/grant и точному native asset. Смешанный batch не передаётся целиком одному пользователю. Для WhatsApp дополнительно совпадают WABA и phone_number_id. Дедупликация — по connection/message; поддерживаются только text message events, до 30 дней/10000 событий на vault. Подписка приложения на WABA требует отдельного разрешённого Meta setup; её наличие не предполагается.

Это кэш **содержания сообщений**, а не только факта события: в encrypted record находятся текст, message id, время и connection id. Исходный webhook может содержать sender/recipient identifiers и номер отправителя WhatsApp; эти дополнительные поля обрабатываются в памяти и в текущий кэш не записываются. TTL считается от receivedAt: записи возрастом 30 дней и старше не выдаются при read, удаляются при startup lifecycle tick и каждом scheduled tick (по умолчанию минута), даже без новых webhook. Пока процесс остановлен, ciphertext может оставаться на диске до следующего startup sweep; expired content всё равно не обслуживается. Другие API read responses брокер не архивирует. Внешний AI-клиент получает данные только по явному выбору пользователя, автоматической передачи моделью по умолчанию нет.

## Проверенное удаление subject из рабочего хранилища

Это закрытая owner операция, без нового публичного MCP tool. Сначала оператор проверяет принадлежность аккаунта и согласует полный объём удаления всех Meta-подключений данного внутреннего subject. Email/публичный handle не подставляют вместо platform user id. Удаление одного subject не меняет данные другого.

1. Остановите конкретный service unit штатным SIGTERM и убедитесь, что процесс завершён. CLI использует тот же writer lock и откажет при живом процессе или stale lock; автоматического снятия lock нет.
2. В том же защищённом service environment задайте только `META_BROKER_STATE_DIR` и `META_BROKER_VAULT_KEY`. Secrets не передавайте аргументами и не печатайте. Указанный vault должен уже существовать: ошибочный путь не создаёт пустой «успешно очищенный» store.
3. Из checkout/install directory выполните `node dist/student/purge-subject.js --subject PLATFORM_INTERNAL_USER_ID --confirm-purge`. Параметр subject должен быть ровно проверенным внутренним ID. Команда удаляет его connections, grants/credentials, cached events, OAuth pending states и generation keys одной транзакцией; stdout содержит только числовые counts, stderr — безопасный error code. Отсутствие `--confirm-purge` даёт отказ. `vault_commit_uncertain` не считается успешным удалением: сначала восстановите filesystem и повторно проверьте состояние под offline lock.
4. Проверьте counts и выполните независимый read-back рабочего vault в закрытом контуре; только затем возобновите service. Старые callbacks после purge не имеют state. Последующее новое добровольное OAuth может создать новое подключение.
5. Отдельно обработайте backup/архивные ciphertext и копии у третьих сторон по согласованному запросу. CLI удаляет записи текущего рабочего vault; не обещает физическое стирание блоков filesystem, исходных данных Meta или всех внешних копий. Процедура не отправляет Meta-запросов или писем.

## Ограничения и проверка

Реализация не доказывает доступность приложения внешним ученикам: App Review, режим Live, permissions, роль пользователя, assets и фактический OAuth должны пройти отдельный live read-back. Inbox содержит conversation metadata или поддержанные события, без произвольного чтения диалогов/вложений. Page insights не объявлены до выбора актуального подтверждённого metric set. Instagram insights ограничены reach, Threads — фиксированными views/likes/replies/reposts/quotes/followers_count. Нельзя обещать полноту native app, consumer IG accounts, удалённые посты, webhook события до подключения или все assets сверх discovery bound.

Адресные тесты: `npm test -- tests/student-security.test.ts tests/student-broker.test.ts tests/student-provider.test.ts tests/student-http.test.ts tests/student-webhooks.test.ts tests/student-config.test.ts tests/student-lifecycle.test.ts tests/student-retention.test.ts tests/student-purge.test.ts`. Они проверяют реальные encrypted files, cross-process lock, MCP SDK/HTTP и подменённую только внешнюю сеть. Live Meta endpoints, сохранение dashboard, App Review и deployment этими тестами не проверяются.

Локальная инженерная проверка 09.11.2026: полный `npm test` — 58 файлов/689 тестов PASS; `npm run typecheck`, `npm run build`, remote-entrypoint, installer и native-registration fixtures — PASS. Проверен также stateless `tools/call` без предшествующего initialize для Go adapter, одновременно с обычным SDK handshake. Это локальные результаты этого изменения, без CI, live OAuth и deployment.

Источники: [Unified Login get started](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started), [Threads tokens/permissions](https://developers.facebook.com/documentation/threads/get-started/get-access-tokens-and-permissions), [Meta Threads Postman](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api), [Meta Pages tokens](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api), [Messenger Conversations](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a), [Meta Marketing insights](https://www.postman.com/meta/facebook-marketing-api/request/u38qbri/get-insight-details-from-an-adaccount-l4), [WhatsApp Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [Meta Business SDK user edges](https://github.com/meta/facebook-python-business-sdk/blob/main/facebook_business/adobjects/user.py). Проверка документации: 09.11.2026; live entitlement не подтверждён.
