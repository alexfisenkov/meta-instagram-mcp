# Changelog

Изменения относятся к публичным возможностям и инструкциям. Кодовый интерфейс сам по себе не означает, что feature опубликована или проверена live.

## После v0.2.0 — текущие изменения кандидата

- Подключается ограниченный browser `account.inspect` перед автоматическим Direct read, если bridge зарегистрирован, но ещё не проверил аккаунт.
- Native Messaging extension восстанавливает соединение через ограниченный MV3 alarm backoff; browser inbox/comment cursors явно отклоняются, если UI pagination не поддерживается.
- `tools/run.mjs` выбирает remote stdio proxy по внешней private config и не переключается на local core при ошибке remote. В phone inbox добавляется ограниченная semantic-навигация через exact accessibility IDs с fail-closed для неподтверждённого UI.
- Операционный runbook различает 27 нативных tools и 18 cloud allowlisted legacy tools, показывает текущие readiness boundaries и вводит iPhone/Appium runbook. Live browser/phone readiness остаётся отдельной runtime-проверкой.

Эти изменения ещё не вошли в опубликованный release.

## 0.2.0 — Published 2026-10-06

- Общая factory связывает legacy API, API Direct/comments/insights, API→browser→phone read router, triage/analysis и source-bound prepare/execute tools для stdio и Streamable HTTP.
- Добавлены portable install/update/rollback/uninstall entrypoints, external-config wrapper, локальный doctor и fixture smoke.
- Добавлены per-user Native Messaging manifest/launcher/registry helper и изолированные fixtures; helper использует точный extension origin и отказывается заменять чужую регистрацию.
- Installer отказывает при пересечении target/config после canonical resolution ссылок; Windows CI собирает и сохраняет Native Messaging host artifact на 14 дней.
- Минимальная версия Node.js повышена до поддерживаемой 22; CI проверяет Node.js 22 и 24 на Linux, macOS и Windows.
- Добавлены профильная матрица, roadmap, operator/contributor/troubleshooting guides и CI по трём ОС.
- Browser Native Host/extension и phone companion подключены к runtime; helper не запускался на owner Chrome, а stable extension identity/path, серверный Chrome login, физический iOS/Android setup и live UI acceptance остаются отдельными gates.
- Phone broker принимает account.inspect/account.snapshot read tasks с пустым target list и передаёт их в выбранный phone provider.
- Runtime supports OAuth callback and account-bound webhook adapters when configured; Meta consent, hosted HTTPS deployment, permission approval and actual webhook delivery remain unverified.
- Приватные локальные хранилища проверяют Windows NTFS ACL и используют host-native сравнение путей; POSIX сохраняет строгие режимы файлов `0600` и каталогов `0700`.

Release `v0.2.0` опубликован. Установка и rollback описаны в [install runbook](docs/install.md); этот раздел фиксирует состав опубликованного release.
