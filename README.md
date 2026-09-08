# Meta Instagram MCP

Локальный MCP-сервер для официального Meta Instagram API. Сервер дает read-only инструменты для авторизации, проверки токена, чтения account info, списка media, комментариев, user insights, media insights, быстрого рейтинга контента и безопасного raw GET по разрешенным Graph endpoints. Отдельно от них стоят два инструмента публикации - они закрыты двумя предохранителями и описаны ниже, в разделе «Публикация».

Проект рассчитан на персональное использование: секреты, токены, live-логи, скриншоты и реальные аналитические отчеты остаются локально и не публикуются в git.

## Что важно про доступ Meta

- Доступ возможен только в рамках permissions, которые выдаст Meta App и подтвердит пользователь.
- `META_AUTH_MODE=facebook` использует Facebook Login + Instagram Graph API. Page-linked resolve требует Facebook Page permissions, но direct Instagram access может работать и без `/me/accounts`, если OAuth consent выдал доступ к конкретному professional account.
- `META_AUTH_MODE=instagram` нужен для отдельного Instagram Login-приложения с Instagram App ID/Secret и scopes вроде `instagram_business_basic`, `instagram_business_manage_insights`, `instagram_business_manage_comments`.
- Long-lived токены действуют около 60 дней и должны обновляться до истечения срока.
- Официального "полного бесконечного доступа ко всему Instagram" нет. Этот MCP расширяемо читает то, что разрешают Meta permissions и текущий аккаунт.

## Быстрый старт

```bash
git clone <repo-url>
cd meta-instagram-mcp
npm install
cp .env.example .env
```

Заполните `.env`:

```env
META_AUTH_MODE=facebook
META_INSTAGRAM_APP_ID=<meta-app-id>
META_INSTAGRAM_APP_SECRET=<meta-app-secret>
META_INSTAGRAM_REDIRECT_URI=http://localhost:8787/callback
```

Подробная установка: [docs/install.md](docs/install.md).

Сборка:

```bash
npm run build
```

OAuth через локальный callback:

```bash
npm run meta:callback
```

Команда напечатает login URL. После consent Meta вернет браузер на `META_INSTAGRAM_REDIRECT_URI`, а сервер сохранит long-lived token вне репозитория, если задан `META_INSTAGRAM_APP_SECRET`.

После OAuth сохраните IG user id в token-store:

```bash
# Page-linked path, если pages_show_list выдан:
# meta_resolve_instagram_account {}

# Direct path, если Meta выдала Instagram access, но declined Page scopes:
# meta_resolve_instagram_account {"userId":"<IG_USER_ID>"}
```

Запуск MCP:

```bash
npm run dev
```

Подключение к Codex после сборки:

```bash
codex mcp add meta-instagram-local -- node /absolute/path/to/meta-instagram-mcp/dist/server.js
```

## MCP Tools

- `meta_auth_status` - проверяет конфиг и redacted token metadata.
- `meta_scope_presets` - показывает поддерживаемые OAuth scope presets.
- `meta_build_login_url` - строит официальный OAuth login URL.
- `meta_exchange_code` - меняет OAuth `code` на long-lived token и сохраняет его вне репозитория.
- `meta_refresh_token` - обновляет long-lived token.
- `meta_list_facebook_pages` - показывает Facebook Pages, доступные Facebook Login token, и связанные Instagram Business accounts.
- `meta_resolve_instagram_account` - сохраняет IG user id из связанной Facebook Page или из direct IG user id.
- `meta_get_account_info` - читает account info.
- `meta_list_media` - читает список media.
- `meta_get_media` - читает один media object.
- `meta_get_top_media` - ранжирует последние media по engagement, likes, comments или date.
- `meta_get_user_insights` - читает account-level insights.
- `meta_get_post_insights` - читает insights конкретного media object.
- `meta_list_comments` - читает комментарии media object при наличии comment permission.
- `meta_get_comment_replies` - читает ответы на комментарий.
- `meta_raw_get` - выполняет read-only GET по относительному Graph path.
- `meta_create_media_container` - создает контейнер публикации по публичной ссылке на медиа и читает его `status_code`. Ничего не публикует.
- `meta_publish_media` - публикует готовый контейнер. Требует `confirm: true` и `META_INSTAGRAM_WRITE=true`.

Локальные CLI/MCP процессы автоматически читают `.env` из корня проекта. Секреты и токены не коммитятся. По умолчанию token-store находится вне репозитория: `~/.config/meta-instagram-mcp/token.json`.

## Публикация

Публикация в Instagram идет двумя шагами Graph API, и в MCP это два разных инструмента - намеренно, чтобы первый шаг можно было делать спокойно, а второй нельзя было сделать случайно.

**Шаг 1 - контейнер.** `meta_create_media_container` вызывает `POST /{ig-user-id}/media` и возвращает id контейнера и его `status_code`:

```json
{"imageUrl": "https://example.com/post.jpg", "caption": "текст поста"}
{"videoUrl": "https://example.com/reels.mp4", "mediaType": "REELS", "caption": "текст"}
```

Это сухой прогон публикации: контейнер ничего не показывает в профиле и, если его не опубликовать, истекает сам (Meta держит его около суток). По `status_code` видно главное - забрала ли Instagram файл по ссылке: `FINISHED` - забрала, `IN_PROGRESS` - еще качает, `ERROR` - нет.

Ссылка на медиа обязана быть **публичной**: файл скачивает не этот сервер, а Instagram со своей стороны. Ссылка за авторизацией, за VPN или на localhost не подойдет - Meta вернет ошибку контейнера. MCP проверяет только схему (`http`/`https`), доступность проверяет Meta.

**Шаг 2 - публикация.** `meta_publish_media` вызывает `POST /{ig-user-id}/media_publish` и делает пост видимым. Действие необратимо из этого MCP: удалять посты он не умеет. Поэтому два предохранителя, и нужны оба:

- `META_INSTAGRAM_WRITE=true` в окружении процесса - решение о среде: разрешена ли публикация здесь вообще. Ровно строка `true`, `1` и `yes` не считаются;
- `confirm: true` в самом вызове - решение об этом конкретном посте.

Нет любого из двух - инструмент отказывает и ничего не публикует; в отказе написано, чего не хватило. Проверяются оба до обращения к сети.

```json
{"creationId": "17900000000000000", "confirm": true}
```

**Журнал.** Каждая публикация пишется в `publish-log.jsonl` рядом с token-store (переопределяется `META_INSTAGRAM_PUBLISH_LOG`), по строке JSON на событие: `attempt` до вызова Meta, затем `published` с id поста или `failed` с причиной. Записи две, а не одна, чтобы прерванная посередине публикация не выглядела как несостоявшаяся. Если журнал не пишется, публикация не начинается - публиковать без следа этот MCP не будет. Отказы предохранителей в файл не пишутся: они ничего не меняют.

**Права.** Публикация требует scope `instagram_business_content_publish` (режим `instagram`) или `instagram_content_publish` (режим `facebook`) - они входят в пресет `fullStandard`, но не в `analytics`. Токен, выданный под чтение, на публикации ответит ошибкой прав: пересоберите login URL через `meta_build_login_url` с `scopePreset: "fullStandard"` и пройдите вход заново.

## Документация

- [docs/install.md](docs/install.md) - установка с нуля.
- [docs/file-map.md](docs/file-map.md) - карта проекта: что где смотреть.
- [docs/operations-runbook.md](docs/operations-runbook.md) - команды и процедуры.
- [docs/security-notes.md](docs/security-notes.md) - правила секретов, токенов и ротации.
- [docs/architecture.md](docs/architecture.md) - архитектура и OAuth modes.
- [docs/meta-setup.md](docs/meta-setup.md) - Meta Dashboard и OAuth notes.
- [queries/README.md](queries/README.md) - локальный формат архива аналитических запросов.

## Публичный и локальный состав

В публичный git должны попадать код MCP, тесты, `.env.example` и общие инструкции. Локально остаются и игнорируются:

- `.env`;
- `app secret.md.rtf`;
- `~/.config/meta-instagram-mcp/token.json`;
- `HANDOFF.md`;
- `docs/implementation-log.md`;
- `docs/verification-log.md`;
- датированные папки внутри `queries/`;
- папки со скриншотами профиля и выгрузками личной аналитики.

Правило языка для этого проекта: пользовательские Instagram-запросы, отчеты, выводы и сохраненные заметки пишутся на русском. Технические имена API/MCP/команд можно оставлять как есть.
