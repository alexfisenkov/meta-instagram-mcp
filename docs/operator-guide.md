# Руководство оператора

Оператор — владелец установленной копии, своей Meta App, OAuth и устройств companions. Каждый install профиль использует отдельные локальные state и prerequisites; обзор — в [capabilities](capabilities.md), команды — в [install](install.md).

## Проверка перед началом

1. Запустите `node tools/doctor.mjs` из каталога приложения.
2. Убедитесь, что doctor установил локальное MCP-соединение и перечислил tools. Если есть только legacy API tools, не ожидайте, что новые Direct/comments, HTTP, browser или phone routes уже подключены.
3. Проверьте собственный OAuth mode и список permissions у Meta. Account и Page binding не выбираются по display name.
4. Для API-only профиля подключите client к stdio wrapper. Для server/browser и phone используйте companion только когда готовность соответствующего источника подтверждена его status и нужной отдельной проверкой.

## Авторизация и сохранение сессий

`.env`, token-store и publish journal находятся вне каталога программы. Установщик на update их не заменяет. Не копируйте OAuth tokens, callback URL, cookies, Chrome profile или сырые Appium dumps в repo/issue.

В server+browser профиле браузерный login выполняет владелец в постоянном Chrome профиле самого узла через одобренный private admin GUI или SSH-forwarded desktop. Этот профиль хранит свою browser session локально; laptop cookies не импортируются. Без ресурсов или разрешённого login browser readiness остаётся gated.

Телефон выбирается явно для своего companion. iOS app/device control требует Mac/Xcode/WDA/Appium. Android path поддерживается только когда оператор отдельно установил и настроил UiAutomator2. MCP не выдаёт произвольный tap/selector/shell интерфейс.

## Действия с внешним эффектом

Сначала review точный объект, source и context. Mutation preview должен совпасть с подтверждаемым request ID и fingerprint; только пользователь подтверждает передачу точного текста/действия. Если результат `OUTCOME_UNKNOWN`, не отправляйте повтор: проверьте локальный sanitized journal и прочитайте этот target из того же source. Не принимайте `ACK` за доказанную доставку.

MCP не запускает внутреннюю модель. Подключённый AI-клиент может анализировать только выбранные observations; он не получает полный локальный store автоматически, и MCP не отправляет его черновики без отдельного подтверждения.
