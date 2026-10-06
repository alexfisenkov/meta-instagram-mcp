# Возможности и границы готовности

Эта матрица разделяет локальный stdio runtime, модули в текущей разработке и live-подтверждения. Наличие интерфейса/модуля или зелёного fake-теста не доказывает рабочее подключение аккаунта, браузера или телефона.

| Источник/профиль | Что делает | Статус в текущем checkout |
|---|---|---|
| Официальный Meta Graph API через stdio | OAuth status/flows, чтение account, media, comments и insights; media publish остаётся отдельно закрытым предохранителями | Существующая legacy API surface; права зависят от OAuth scopes/consent. Это не проверка чужого аккаунта или live-доступа Meta. |
| Новые API domains: Direct, comments, replies, moderation | API read/write с точным account/target и confirmation gates | Domain modules и tests не означают, что общий MCP factory уже выставил их в tools. Проверьте tool list после опубликованной интеграции. |
| API over Streamable HTTP и CompanionHub | Защищённый серверный transport и durable bridge tasks | Кодовые модули не равны готовому mounted service. Здесь нет deploy, действующего gateway URL, Meta app setup или multi-user production acceptance. |
| Server + browser companion | Отдельный постоянный Chrome profile, extension и Native Host на собственном узле | Исходники extension и Windows host присутствуют; регистрация host, установка extension, login и browser UI не подтверждены. Capability остаётся gated до установки, authorization и UI проверки. |
| External desktop browser | Browser companion работает на собственной машине, подключается к своему core | Целевой профиль; registration/installation и live browser readiness ещё не подтверждены. |
| Connected phone | Semantic UI observations/actions с локального companion; iOS на Mac, Android только при отдельной Appium/UiAutomator2 настройке | Целевой профиль; live phone/WDA/Appium и реальные экраны не подтверждены в этом release. |
| Анализ через подключённый AI host | AI может анализировать только выбранные observations и создавать черновики | Модель не запускается внутри MCP. Текст, смысл и черновики делает выбранный клиент; никакой автоматической отправки. |

## Чтение, coverage и история

Каждое observation сохраняет source, coverage и полноту истории. API/браузер/телефон не объединяются по похожему имени или тексту: связать данные можно только по проверенному native ID либо явной ссылке владельца. `unread` означает состояние уведомления, `unanswered` — отсутствие ответа; одно не подменяет другое. Если направление, identity или история не подтверждены, статус остаётся `unknown`/`partial`.

Graph API имеет ограничения доступа и окна чтения. Текущий контракт ограничивает чтение Direct до 20 сообщений на разговор и помечает запросы по inactive conversation older than 30 days как отдельный permission/window boundary. Это не означает, что UI companion подключён или восстановил более старую историю. Читайте поле limits/coverage конкретного ответа; не выводите полный охват из одного успешного API вызова.

Целевой приоритет автоматического чтения — API → browser → phone. В текущем checkout единый router ещё не подключён, поэтому не считайте порядок реализованным fallback; фактические observations должны сохранять source и coverage. Целевой контракт записи закрепляет один source в write preview: при `OUTCOME_UNKNOWN` действие не повторяется и source не меняется автоматически; сверяется тот же target через тот же source.

## Записи и подтверждения

Для нового mutation workflow MCP сперва готовит preview с точной source/account/target/context, fingerprint и request ID. Исполнение требует явного `dryRun:false`, `confirm:true`, совпадающих fingerprint и request ID; удаление требует отдельного delete confirmation. Диспетчер делает одну попытку. Timeout или неопределённый сетевой/click результат возвращает `OUTCOME_UNKNOWN`: автоматически не повторять, не переключать источник, проверить журнал и прочитать объект из того же source. `ACK`, read-back и доставка — разные утверждения.

Media publishing — отдельная API операция. Её второй шаг требует `confirm:true` и `META_INSTAGRAM_WRITE=true`; подробности — в разделе [Публикация](../README.md#публикация). Наличие этого guard не даёт permission для Direct/comments mutation без отдельной интеграции и confirmation.

## Установка

Все четыре профиля, их prerequisites и текущие ограничения собраны в [инструкции установки](install.md). Для machine-readable локальной проверки используйте `node tools/doctor.mjs`; doctor выполняет только MCP initialize/listTools/status read, не отправляет Meta data write и не подтверждает live browser/phone readiness.
