# Roadmap

Этот файл показывает условия, после которых профиль можно называть доступным. Релиз не публикуется только потому, что отдельные модули или fake-тесты готовы.

## Для portable API release

- Повторить интегрированную typecheck, unit/integration suite и `npm run build` проверку на поддерживаемых Node.js 22 и 24 для Linux, macOS и Windows после каждого release candidate.
- Проверить portable install/update/rollback fixtures на Linux, macOS и Windows и получить артефакт самодостаточной сборки Windows Native Messaging host из CI; локальный Windows host/live browser setup остаются отдельными проверками.
- Выполнить независимые reviews, снять release-blockers и только после приёмки назначить версию, tag/SHA и publication.

## Browser profile

- Запустить per-user registration helper и установить extension на поддерживаемых узлах; сохранить стабильный extension ID и host path между обновлениями.
- Тестировать framing, host ID/account binding, approval context и негативные path/auth случаи на fake fixture.
- Пройти локальное signed-in UI smoke на собственном Chrome profile; проверить server+browser persistent profile и external desktop profile отдельно.
- Пока эти доказательства не записаны, `browser` readiness остаётся gated/`not_connected`; profile в install guide описывает цель, а не результат.

## Phone profile

- Настроить standalone companion и bounded Appium client на выбранном оператором Mac/iOS или Android host.
- Проверить readiness/device selection и fake UI paths до реального устройства.
- Отдельно подтвердить iOS с Mac/Xcode/WDA и Android только при настроенном UiAutomator2 host.
- Не переводить `phone` в `ready` по наличию Appium пакета или локального code build.

## Server and account acceptance

- Развернуть exact release SHA через одобренную private install/deploy процедуру и выполнить server-side read-back.
- Подтвердить OAuth scopes для своего account/Page и нужного login mode. Webhook должен оставаться fail-closed до ожидаемого account binding, permissions и подписанного event setup.
- Пройти один read-only smoke на подключённом MCP client и отдельные browser/phone checks. Не смешивать кодовый PASS с Meta live access, отправкой/публикацией или production readiness.

## Known maintenance issues

- A sanitized Mac DOM observation identified one visible own-profile avatar control with no `nav`, `header`, `aside`, or `main` ancestor and no `aria-label`/`title`, plus the authenticated own-profile `/accounts/edit/` control. Fixtures exercise those predicates with a neutral wrapper. A configured live bridge/read has not yet verified the flow end to end.
- A bounded read deadline can expire after a browser/phone companion has already received or started a UI task. The Hub rejects a canceled task receipt and browser/phone checks expiry before beginning a task, but an action already underway cannot be reliably stopped or rolled back; UI reads may also mark a conversation seen. Verify behavior on attached hardware before claiming cancellation of active UI work.
- `PhoneCompanion.close()` stops future interval polls but does not await a pump already in progress. Reproduction: run the full suite or `tests/companion-phone.test.ts` while its context-refresh test removes the temporary Hub directory immediately after `close()`; a delayed Hub write can make cleanup fail with `ENOTEMPTY`. The isolated test passed; the full local suite reproduced the race twice, and a later full-suite rerun passed. Track a close/drain contract and regression before relying on immediate Hub-directory removal during shutdown.

## Release/branch guardrails

- Не выполнять Meta mutations, публикацию, server deploy, owner client-config update или GitHub release из CI.
- Единственная цель для установки — [последний опубликованный GitHub Release](https://github.com/alexfisenkov/meta-instagram-mcp/releases/latest), включая SHA тега и provenance assets. Версия `package.json` описывает checkout и не подтверждает, что этот commit/tag опубликован.
- Предыдущие инсталляции, token-store, OAuth state и backup-каталоги остаются восстановимыми; cleanup выполняется только отдельной явно заданной операцией.
