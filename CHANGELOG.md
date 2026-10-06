# Changelog

Изменения относятся к публичным возможностям и инструкциям. Кодовый интерфейс сам по себе не означает, что feature опубликована или проверена live.

## 0.2.0 — предварительная версия, не опубликована

- Общая factory связывает legacy API, API Direct/comments/insights, API→browser→phone read router, triage/analysis и source-bound prepare/execute tools для stdio и Streamable HTTP.
- Добавлены portable install/update/rollback/uninstall entrypoints, external-config wrapper, локальный doctor и fixture smoke.
- Добавлены per-user Native Messaging manifest/launcher/registry helper и изолированные fixtures; helper использует точный extension origin и отказывается заменять чужую регистрацию.
- Installer отказывает при пересечении target/config после canonical resolution ссылок; Windows CI собирает и сохраняет Native Messaging host artifact на 14 дней.
- Минимальная версия Node.js повышена до поддерживаемой 22; CI проверяет Node.js 22 и 24 на Linux, macOS и Windows.
- Добавлены профильная матрица, roadmap, operator/contributor/troubleshooting guides и CI по трём ОС.
- Browser Native Host/extension и phone companion подключены к runtime; helper не запускался на owner Chrome, а stable extension identity/path, серверный Chrome login, физический iOS/Android setup и live UI acceptance остаются отдельными gates.
- Runtime supports OAuth callback and account-bound webhook adapters when configured; Meta consent, hosted HTTPS deployment, permission approval and actual webhook delivery remain unverified.
- Приватные локальные хранилища проверяют Windows NTFS ACL и используют host-native сравнение путей; POSIX сохраняет строгие режимы файлов `0600` и каталогов `0700`.

Пока release не опубликован с точным commit SHA, используйте только уже опубликованные версии и не считайте эту предварительную запись обещанием доступного installer package.
