# Руководство оператора

Оператор — владелец установленной копии, своей Meta App, OAuth и устройств companions. Каждый install профиль использует отдельные локальные state и prerequisites; обзор — в [capabilities](capabilities.md), команды — в [install](install.md).

## Проверка перед началом

1. Запустите `node tools/doctor.mjs` из каталога приложения.
2. Убедитесь, что doctor установил локальное stdio MCP-соединение и перечислил tools. Doctor показывает наличие tools и runtime source status; он не проверяет Meta live, HTTP gateway, browser login или телефон.
3. Проверьте собственный OAuth mode и список permissions у Meta. Account и Page binding не выбираются по display name.
4. Для API-only профиля подключите client к stdio wrapper. HTTP transport задаётся приватной runtime-конфигурацией; перед удалённым доступом настройте bearer, host/origin allowlists и доверенный TLS reverse proxy. Browser/phone companions запускайте только после проверки account binding, host registration, readiness и отдельного UI read-back.

## Авторизация и сохранение сессий

`.env`, token-store и publish journal находятся вне каталога программы. Установщик на update их не заменяет. Не копируйте OAuth tokens, callback URL, cookies, Chrome profile или сырые Appium dumps в repo/issue.

В server+browser профиле браузерный login выполняет владелец в постоянном Chrome профиле самого узла через одобренный private admin GUI или SSH-forwarded desktop. Этот профиль хранит свою browser session локально; Mac cookies не импортируются. Host registration использует точный extension origin; команды и per-user manifest/registry paths приведены в [install guide](install.md#browser-native-messaging-host). Server runtime отдельно проверяет browser account handle и bridge binding. Без разрешённого login, stable extension ID/host path и live UI проверки browser readiness остаётся gated.

Телефон выбирается явно для своего companion. iOS app/device control требует Mac/Xcode/WDA/Appium. Android path поддерживается только когда оператор отдельно установил и настроил UiAutomator2. Phone snapshot покрывает inbox, выбранные thread/comments/replies и insights; older-history scrolling не поддерживается. MCP не выдаёт произвольный tap/selector/shell интерфейс.

## Действия с внешним эффектом

Сначала review точный объект, source и context. Mutation preview должен совпасть с подтверждаемым request ID и fingerprint; только пользователь подтверждает передачу точного текста/действия. Если результат `OUTCOME_UNKNOWN`, не отправляйте повтор: проверьте локальный sanitized journal и прочитайте этот target из того же source. Не принимайте `ACK` за доказанную доставку.

MCP не запускает внутреннюю модель. Подключённый AI-клиент может анализировать только выбранные observations; он не получает полный локальный store автоматически, и MCP не отправляет его черновики без отдельного подтверждения.
