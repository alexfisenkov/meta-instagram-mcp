# Статус и воспроизводимый выпуск MCP

Владелец поручил выпустить новый GitHub release, синхронизировать сервер и действующие локальные установки, обновить документацию и команды статуса. Текущая база — `f99652ce59bf3abf1b97bb4b86b91ff356655522`, предыдущий release — v0.2.7.

## Требуемый результат

- Существующие имена инструментов и legacy поля/типы сохраняются. `meta_capabilities.version: 1` остаётся версией схемы.
- Оба status инструмента получают безопасный runtime block: package version и source revision из валидированного installer stamp либо server `.VERSION` (первая строка — ровно полный SHA; далее только пустые строки или комментарии оператора с `#`). Метаданные фиксируются при создании runtime; manifest не доказывает отсутствие ручной модификации файлов. Неизвестное или несовместимое происхождение явно unknown.
- `meta_auth_status` принимает необязательный `verify: boolean` с default false. Обычный вызов не выполняет network/UI. `verify:true` проверяет текущий Facebook credential через официальный debug_token: GET, максимум 5 секунд wall-clock, без retry, refresh, записи token-store или OAuth. Неподдерживаемый auth mode, недостаточная конфигурация, ошибки и некорректный ответ дают закрытые безопасные reason codes.
- Новая authorization проекция раздельно показывает token validity, соответствие app, scope names, token expiry, data-access expiry, источник и время проверки. Срок 0 — `no_expiry_reported`, отсутствующий/невалидный — unknown; ноль не означает вечный доступ. Не выводить upstream payload, token, secret, hash/digest, raw identifier или пути в новых блоках. Старые token fragment strings заменить непрозрачным `[redacted]` с сохранением типа.
- Последняя проверка может храниться только in-memory с приватной привязкой к реально выбранному token + app + auth mode и временем; environment token имеет приоритет, смена credential исключает наследование старого proof. Cached/stale не выдавать за новую проверку. Valid false/app mismatch не маркировать как здоровую авторизацию.
- Приватный `operational-context.json` рядом token-store задаёт только публичные HTTPS privacy/deletion URLs и manual/unknown deletion workflow. Строгая разрешённая проекция, без userinfo/query/hash/локальных адресов, контактов, account/dashboard links или raw context. Configured не означает live verified. Никакой app-specific PII в public repo.
- Version v0.2.8 в package/lock/docs, актуальные примеры и limitations. Без новых requested scopes, tool names, зависимостей и UI действий.

## Выпуск и приёмка

Целевые и полные локальные проверки, typecheck/build, installer/native-registration/remote-entrypoint, независимый code/spec/security review. После этого один final GitHub CI полного SHA; Windows release assets и provenance только из этого run. GitHub tag/release exact SHA, серверный core и NativeHost/extension под общим lock, Mac installer с сохранением config и прежней установки. Основную рабочую копию обновить ff-only с побайтовым сохранением чужой правки. Каждую поверхность подтвердить отдельно. Не проверявшиеся UI/Direct/публикация/физический телефон остаются явными ограничениями.
