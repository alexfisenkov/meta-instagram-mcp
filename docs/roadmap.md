# Roadmap

Этот файл показывает условия, после которых профиль можно называть доступным. Релиз не публикуется только потому, что отдельные модули или fake-тесты готовы.

## Для portable API release

- Свести API domains, HTTP/OAuth/webhook ports и runtime tools через общую factory без изменения существующего stdio поведения.
- Пройти полный typecheck, unit/integration suite и `npm run build` на Node.js 20 для Linux, macOS и Windows.
- Проверить portable install/update/rollback fixtures на Linux, macOS и Windows и получить артефакт самодостаточной сборки Windows Native Messaging host из CI; локальный Windows host/live browser setup остаются отдельными проверками.
- Выполнить независимые reviews, снять release-blockers и только после приёмки назначить версию, tag/SHA и publication.

## Browser profile

- Интегрировать extension, Native Host и manifest/registration для macOS/Linux/Windows.
- Тестировать framing, host ID/account binding, approval context и негативные path/auth случаи на fake fixture.
- Пройти локальное signed-in UI smoke на собственном Chrome profile; проверить server+browser persistent profile и external desktop profile отдельно.
- Пока эти доказательства не записаны, `browser` readiness остаётся gated/`not_connected`; profile в install guide описывает цель, а не результат.

## Phone profile

- Интегрировать standalone companion и bounded Appium client.
- Проверить readiness/device selection и fake UI paths до реального устройства.
- Отдельно подтвердить iOS с Mac/Xcode/WDA и Android только при настроенном UiAutomator2 host.
- Не переводить `phone` в `ready` по наличию Appium пакета или локального code build.

## Server and account acceptance

- Развернуть exact release SHA через одобренную private install/deploy процедуру и выполнить server-side read-back.
- Подтвердить OAuth scopes для своего account/Page и нужного login mode. Webhook должен оставаться fail-closed до ожидаемого account binding, permissions и подписанного event setup.
- Пройти один read-only smoke на подключённом MCP client и отдельные browser/phone checks. Не смешивать кодовый PASS с Meta live access, отправкой/публикацией или production readiness.

## Release/branch guardrails

- Не выполнять Meta mutations, публикацию, server deploy, owner client-config update или GitHub release из CI.
- `package.json` version `0.2.0` предварительная; точный опубликованный version/SHA задаётся после integrated acceptance.
- Предыдущие инсталляции, token-store, OAuth state и backup-каталоги остаются восстановимыми; cleanup выполняется только отдельной явно заданной операцией.
