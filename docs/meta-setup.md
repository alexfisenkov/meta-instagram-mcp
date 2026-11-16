# Meta Setup Notes

## Сначала выберите реальный login setup

Начните с `meta_connection_plan` и [инструкции выбора пути](connect-instagram.md). Первым проверьте доступность **API setup with Instagram login**, его Instagram App credentials и возможность получить свой Instagram User token. Отдельный [Chrome-путь](browser-only.md) обходится без Meta App и business portfolio.

Если direct setup недоступен и осознанно выбран **Unified Login**, используйте его [отдельный регламент](unified-login.md) и Meta credentials. Наличие окна Unified само по себе не доказывает отсутствие direct setup. Ошибка назначения App или приглашения в portfolio не исправляется переключением одной переменной либо повторными приглашениями.

## Facebook Login -> Instagram Graph API

Ошибка `Invalid platform app` требует проверки соответствия credentials выбранному login setup: у direct Instagram свои Instagram App ID/Secret. Не переключайте пользователя автоматически на Facebook Login. Следующие шаги применяются только когда фактически выбран и доступен соответствующий Facebook Login setup:

1. Meta App Dashboard -> `Вход через Facebook` -> `Настройки`.
2. Добавить `http://localhost:8787/callback` в `Действительные URI перенаправления для OAuth`.
3. Использовать `META_AUTH_MODE=facebook`.
4. Запросить scopes:

```text
instagram_basic
pages_show_list
pages_read_engagement
instagram_manage_insights
instagram_manage_comments
```

После OAuth нужно выполнить `meta_resolve_instagram_account`. Есть два поддержанных варианта:

- `pageId`/без аргументов: инструмент ищет Facebook Page с подключенным Instagram Business account через `/me/accounts` и сохраняет `META_INSTAGRAM_USER_ID`-эквивалент в token-store.
- `userId`: если Meta выдала direct Instagram access, но declined Page scopes, инструмент валидирует указанный IG user id прямым Graph-запросом и сохраняет его в token-store без Page permissions.

Минимальный официальный read path для проверки:

1. `GET /me/accounts`
2. `GET /{page-id}?fields=instagram_business_account`
3. `GET /{ig-user-id}/media`

Если Meta выдала Instagram permissions, но вернула `pages_show_list` или `pages_read_engagement` как `declined`, используйте direct Instagram user id path:

1. `GET /{ig-user-id}?fields=id,username,followers_count,media_count`
2. `GET /{ig-user-id}/media`
3. `GET /{ig-user-id}/insights?metric=reach&period=day`
4. `GET /{media-id}/insights`

## Прямой Instagram Login Flow

По официальной документации Meta Business Login for Instagram использует:

- `https://www.instagram.com/oauth/authorize` для получения authorization code;
- `https://api.instagram.com/oauth/access_token` для обмена code на short-lived token;
- `https://graph.instagram.com/access_token` для обмена short-lived token на long-lived token;
- `https://graph.instagram.com/refresh_access_token` для обновления long-lived token еще на 60 дней.

Для первого базового direct подключения запрашивается только:

```text
instagram_business_basic
```

Analytics/comments scopes добавляйте отдельно под нужную задачу и только если они доступны приложению.

Текущий практичный analytics preset проекта:

```text
instagram_business_basic
instagram_business_manage_insights
instagram_business_manage_comments
```

`fullStandard` дополнительно знает publish/messages scopes; запись остаётся за отдельными локальными gates и явным подтверждением конкретного действия. Для первого подключения direct default — только `instagram_business_basic`, а analytics preset выбирается по необходимости. Пошаговая инструкция — [Direct Instagram Login](direct-instagram-login.md).

## Что сделать в Meta App Dashboard

Для уже выбранного `facebook` режима:

1. Добавить продукт `Facebook Login`.
2. В `Facebook Login -> Settings` добавить OAuth redirect URI, совпадающий с `META_INSTAGRAM_REDIRECT_URI`.
3. Убедиться, что Instagram professional account выбран в OAuth consent.
4. Если нужны Page-linked flows, убедиться, что Instagram professional account подключен к Facebook Page и что пользователь может выдать `pages_show_list`.
5. Пройти OAuth consent под Facebook-пользователем, у которого есть доступ к нужному IG account/Page.
6. Выполнить `meta_resolve_instagram_account`.
7. Для чужих аккаунтов или production-доступа пройти App Review / Advanced Access.

Для `instagram` режима в Meta App Dashboard требуется подходящий setup для `API setup with Instagram login`; Meta показывает для него `Instagram App ID` и `Instagram App Secret`. Совместимость уже существующего Meta app с этим режимом здесь не подтверждена. Перед использованием проверьте доступные продукты, Login setup и callback settings в Dashboard владельца приложения; необходимость отдельного приложения зависит от фактической конфигурации Meta.

## Не хранить в git

- app secret;
- access token;
- refreshable long-lived token;
- реальные ответы API, если они содержат чувствительные данные.
