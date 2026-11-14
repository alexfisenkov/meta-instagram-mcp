# Unified Login в локальном Instagram MCP

Задача: обновить распространяемый MCP из урока, чтобы новая Meta App с Unified Login поддерживалась без самостоятельного программирования учениками. Сохранить Instagram Login, Facebook Login и внешний приватный конфиг существующих установок. Подтверждение безопасности Instagram и сбой приложения-клиента остаются отдельными поверхностями: MCP не обходит login challenge.

## Решение

Добавить явный `META_AUTH_MODE=unified`, используя официальный Facebook Login for Business, `META_INSTAGRAM_CONFIG_ID`, BISU token и `graph.facebook.com`. При проверке нового токена подтвердить app, тип SYSTEM_USER, актуальные scopes, business и доступный Instagram asset. Не трактовать `/me` как Instagram account. Несколько accounts требуют точного выбора; ошибки не заменяют старый token-store.

Существующий hosted student broker содержит соответствующий provider, но имеет другой процесс, tenant isolation и vault. Локальный runtime получает нативный адаптер в существующем OAuth/account-context контуре; hosted broker не подключается к пользовательскому stdio и не получает пользовательские секреты.

Альтернативы: обновить только инструкцию (не закрывает отсутствие flow); направить всех на hosted broker (меняет модель подключения и требует отдельной приёмки платформы). Выбран локальный совместимый адаптер: пользователь поручил его реализацию после разбора этих границ.

## Пользовательский путь

- Обновление выбранного опубликованного SHA штатным установщиком, затем перезапуск MCP. Приватные `.env`, token-store и backups сохраняются.
- Сначала выбрать setup по реальному Meta Dashboard. Старое рабочее подключение не мигрируется автоматически.
- Unified OAuth требует собственный зарегистрированный HTTPS redirect; локальный callback может слушать только loopback за явным TLS proxy. Автоматического стороннего туннеля нет.
- Для личной Meta App допустима ручная генерация test token в официальном Dashboard, его ввод пользователем во внешний приватный конфиг и подтверждённое discovery через MCP. Токен не передаётся в чат и не показывается в ответах.
- `meta_auth_status({verify:true})` проверяет выбранный credential; проверка account/media выполняется отдельно. Expiry без срока не объявляется бессрочным доступом. Unified refresh не вызывает несовместимый Instagram/Facebook обмен: безопасный отказ с требованием повторного входа.

## Проверка и выпуск

Синтетические тесты: URL/token exchange, state replay/config drift, actual grants/app/type/expiry, unique/pinned account discovery, wrong identity, старый token preservation, Graph host/IG id routing, безопасные diagnostics, installer/update/rollback. Затем typecheck, полный suite, build, portable и registration fixtures, независимые code/reality/security review. Один финальный GitHub CI по точному SHA. Release assets и опубликованный tag проверяются отдельно. Live OAuth требует ручного owner login; без него новая live-авторизация не объявляется пройденной.

Уведомление ученикам — после выпуска и подтверждения фактических границ: версия, способ обновления, что исправлено и где нужна личная авторизация. Текст и точная аудитория согласуются перед отправкой по правилам Telegram/проекта.
