# Meta Instagram MCP

Локальный MCP-сервер для официального Meta Instagram API. Сервер дает read-only инструменты для авторизации, проверки токена, чтения account info, списка media, комментариев, user insights, media insights, быстрого рейтинга контента и безопасного raw GET по разрешенным Graph endpoints.

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

Локальные CLI/MCP процессы автоматически читают `.env` из корня проекта. Секреты и токены не коммитятся. По умолчанию token-store находится вне репозитория: `~/.config/meta-instagram-mcp/token.json`.

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
