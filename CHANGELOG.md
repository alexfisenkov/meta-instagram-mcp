# Changelog

Изменения относятся к публичным возможностям и инструкциям. Кодовый интерфейс сам по себе не означает, что feature опубликована или проверена live.

## 0.2.0 — предварительная версия, не опубликована

- Готовятся единая API/domain surface, per-source capability status и safer mutation contracts.
- Добавлены portable install/update/rollback/uninstall entrypoints, external-config wrapper, локальный doctor и fixture smoke.
- Installer отказывает при пересечении target/config после canonical resolution ссылок; Windows CI собирает и сохраняет Native Messaging host artifact.
- Добавлены профильная матрица, roadmap, operator/contributor/troubleshooting guides и CI по трём ОС.
- HTTP route composition, browser Native Host/extension, phone companion, server deployment и live Meta/browser/phone acceptance остаются отдельными gates до публикации.

Пока release не опубликован с точным commit SHA, используйте только уже опубликованные версии и не считайте эту предварительную запись обещанием доступного installer package.
