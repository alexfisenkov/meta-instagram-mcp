# meta-instagram-mcp

MCP для работы с собственным Instagram-аккаунтом через официальные Meta API и подключённые оператором browser/phone companions. Общая runtime factory обслуживает stdio и Streamable HTTP, сохраняет legacy API tools и добавляет source-aware чтение, inbox triage/analysis и подтверждаемые actions. Доступность зависит от Meta permissions и runtime readiness каждого источника; подключение companion и live authorization проверяются отдельно.

Секреты, token-store, OAuth state, browser session и сырые UI-evidence хранятся локально у оператора. MCP не содержит внутренней AI-модели: когда клиент подключён к MCP, анализ и черновики выполняет выбранный пользователем AI-клиент.

## Что важно про доступ Meta

- Доступ возможен только в рамках permissions, которые выдаст Meta App и подтвердит пользователь.
- `META_AUTH_MODE=facebook` использует Facebook Login + Instagram Graph API. Page-linked resolve требует Facebook Page permissions, но direct Instagram access может работать и без `/me/accounts`, если OAuth consent выдал доступ к конкретному professional account.
- `META_AUTH_MODE=instagram` нужен для отдельного Instagram Login-приложения с Instagram App ID/Secret и scopes вроде `instagram_business_basic`, `instagram_business_manage_insights`, `instagram_business_manage_comments`.
- Long-lived токены действуют около 60 дней и должны обновляться до истечения срока.
- Официального "полного бесконечного доступа ко всему Instagram" нет. Этот MCP расширяемо читает то, что разрешают Meta permissions и текущий аккаунт.

## Установка

Единственная актуальная цель для установки — [последний опубликованный release](https://github.com/alexfisenkov/meta-instagram-mcp/releases/latest): используйте commit SHA его тега и provenance приложенных assets. Версия `package.json` относится к этому checkout и сама по себе не подтверждает публикацию. Инсталлятор собирает указанный SHA до переключения и оставляет отдельную резервную копию при обновлении. Сначала прочитайте [установку, обновление и rollback](docs/install.md), затем [матрицу готовности](docs/capabilities.md).

Для разработки из чистого checkout:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:remote-entrypoint
npm run test:installer
npm run test:native-registration
```

Локальный запуск и `npm run meta:callback` читают приватный внешний config; инструкции для первичной настройки — в [docs/install.md](docs/install.md).

## Базовые API tools

Ниже перечислена существующая legacy API surface. Точный текущий набор tools проверяется через MCP client/doctor; permissions и per-source readiness ограничивают доступность функций.

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

Portable runtime запускается через `tools/run.mjs`, который читает внешний `~/.config/meta-instagram-mcp/.env`; token-store по умолчанию находится в той же внешней папке. Не запускайте установленный server через `node dist/server.js`, если хотите использовать внешний config. По умолчанию `tools/run.mjs` запускает локальный MCP по stdio. Если задан любой `INSTAGRAM_MCP_REMOTE_*`, wrapper запускает stdio-proxy к настроенному HTTPS MCP; при ошибке remote-конфигурации он завершается и не создаёт локальное ядро. Инструменты tools не отправляют Meta-запрос без соответствующего вызова, а права определяются OAuth consent.

Из приватного внешнего `.env` wrapper принимает только поддерживаемые `META_*` и `INSTAGRAM_MCP_*` имена; неизвестные ключи, включая `META_MCP_CONFIG_DIR`, завершают запуск с безопасным кодом ошибки. Значения читаются как текст без shell substitution. Переменные окружения процесса имеют приоритет над файлом. HTTP включается через `INSTAGRAM_MCP_TRANSPORT=http`; listener требует bearer secret и настраивается через `INSTAGRAM_MCP_HTTP_*`. API, browser и phone write gates независимы: `META_INSTAGRAM_WRITE`, `INSTAGRAM_MCP_BROWSER_WRITES` и `INSTAGRAM_MCP_PHONE_WRITES`. Подробнее — [runtime-параметры](docs/install.md#runtime-параметры-и-transports).

Нативный stdio/HTTP runtime регистрирует 27 инструментов: 18 legacy и 9 layered/mutation. Доступная отдельно cloud allowlist содержит 18 legacy tools; наличие cloud-каталога не подтверждает поддержку layered routing или companions в этом контуре. Для объединённого чтения Direct используйте `meta_read_inbox`: он проверяет API, затем подключённый browser и phone в порядке приоритета. Зарегистрированный, но ещё не проверенный browser проходит bounded `account.inspect` preflight перед обычным чтением. Если страница не показывает подтверждённый handle, browser ищет единственный видимый avatar Profile control без предков `nav`, `header`, `aside` и `main`, а также без `aria-label` и `title`; handle должен совпасть и в href, и в `img alt`. После точного DOM click browser проверяет `/accounts/edit/` с текстом `Редактировать профиль` в profile header и возвращает ту же вкладку к исходному Instagram URL. При неоднозначном control или неподтверждённом возврате чтение прекращается; вход в Instagram и передача cookies автоматически не выполняются. `meta_capabilities` показывает readiness, а не доказывает успешный live read. Смотрите [матрицу возможностей](docs/capabilities.md) и [операционный runbook](docs/operations-runbook.md).

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

- [docs/install.md](docs/install.md) - portable install, client setup, OAuth, update, rollback и uninstall.
- [docs/capabilities.md](docs/capabilities.md) - доступные и gated источники/профили.
- [docs/roadmap.md](docs/roadmap.md) - оставшиеся release gates.
- [docs/troubleshooting.md](docs/troubleshooting.md) - диагностика установки, OAuth и companions.
- [docs/operator-guide.md](docs/operator-guide.md) - безопасная работа с профилями и actions.
- [CONTRIBUTING.md](CONTRIBUTING.md) - локальные checks и вклад.
- [CHANGELOG.md](CHANGELOG.md) - изменения по версиям.
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
