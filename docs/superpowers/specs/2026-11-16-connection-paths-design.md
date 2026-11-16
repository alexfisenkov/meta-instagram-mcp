# Простое подключение Instagram: API и браузер

Владелец поручил изменить MCP и инструкции: сначала проверить доступность прямого Instagram Login, не направлять всех в business portfolio; сохранить несколько способов работы, включая обычный браузер. Ранее подтверждённый релиз — v0.3.0. Ошибки назначения приложения/приглашения Facebook-профиля в portfolio находятся в Meta, но наш шаблон необоснованно делал этот путь первым.

## Выбранный подход

Новый read-only `meta_connection_plan` помогает агенту выбрать путь, не запускает OAuth и не меняет конфиг. По умолчанию сначала проверяется доступность **API setup with Instagram login** в реальном Dashboard. Прямой официальный путь использует Instagram App credentials и Instagram User token. Unified остаётся отдельным вариантом для подтверждённого соответствующего setup; Facebook Login сохраняется для уже настроенных подключений. Наличие окна Unified не доказывает отсутствие другого setup. Business refusal — причина остановить административные действия и предложить проверенный браузерный вариант, а не создавать новые portfolio по кругу.

Доступность Meta setup нельзя определить по пустому `.env` или версии программы. Входные наблюдения агента обозначаются `caller_supplied`, проверка конфигурации — `configuration_only`. Успешная авторизация требует отдельного реального account/media чтения. Рабочее существующее подключение не заменяется автоматически.

Альтернативы: изменить только текст (сохраняет реальные дефекты direct OAuth и сложности браузерного Hub); перевести учеников на общий hosted broker (меняет модель сервиса и требует независимого допуска). Выбран совместимый portable runtime с существующими API/companion слоями, без новых зависимостей.

## Прямой официальный путь

- Свежий шаблон использует `META_AUTH_MODE=instagram` и минимальный `instagram_business_basic`.
- Short exchange принимает единственный однозначный flat либо `data[0]` grant; смешанные, пустые и множественные ответы отклоняются. IDs — строки или точные safe integers; OAuth code/token и provider error text наружу не выводятся.
- Fresh `/me` связывает OAuth-returned ID с профессиональным `user_id`; `id` остаётся отдельным app-scoped идентификатором. Callback проверяет нужный аккаунт до сохранения. Права берутся из фактического grant, старые labels не наследуются.
- Пользователь может лично ввести Dashboard token в приватный внешний конфиг. MCP проверит профиль и сохранит привязку для следующих чтений, не обещая неизвестные scopes или app verification.

## Браузер без Meta App

Сначала агент проверяет уже имеющееся browser control своего AI-клиента: оно может читать обычный авторизованный Chrome без дополнительной установки. Этот результат не выдаётся за проверку нашего MCP companion. Когда нужен именно наш browser source, существующее Chrome extension + Native Host читает разрешённые видимые поверхности после ручного входа владельца. Для локального ученика не нужны VPS, публичный домен и TLS certificate. Opt-in `INSTAGRAM_MCP_BROWSER_BRIDGE=true` поднимает защищённый bearer loopback Hub **в том же процессе**, который обслуживает stdio MCP. Второй runtime/общий state через разные процессы не создаётся.

Private setup helper имеет dry-run по умолчанию и явный `--apply`. Он готовит приватный bridge JSON и ограниченные env additions, использует существующие guards регистрации Native Host, сохраняет чужие registrations и существующие API credentials. Новый HTTP transport разрешён только browser companion, только literal loopback addresses; remote по-прежнему HTTPS, redirects запрещены. Локальные bearer/credentials не печатаются. Windows использует проверенный опубликованный Native Host asset, без требования сборки .NET учеником.

Browser capabilities подтверждаются отдельно. Установка extension не равна входу, heartbeat не равен owner verification. Insights, полная статистика и полнота истории не обещаются по видимому списку. Все writes по умолчанию закрыты; обход login challenge, перенос cookies и извлечение приватного storage отсутствуют.

## Готовность и выпуск

Тесты выбора маршрута, direct exchange/identity/grants, token preservation, SDK schema, local bridge same-runtime, loopback-only/redirect rejection, setup dry-run/idempotency/conflicts, startup/shutdown и installer/update/rollback. Затем полный test/typecheck/build, независимые критики, secret scan и один финальный CI для Linux/macOS/Windows Node22/24. Выпуск v0.4.0 и точный SHA/read-back отдельно. Реальный Meta вход и Chrome UI у каждого ученика не объявляются пройденными без соответствующей проверки. Telegram-уведомления в эту задачу не включены.
