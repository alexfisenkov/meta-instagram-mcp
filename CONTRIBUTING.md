# Contributing

Изменения держат раздельно API domain, providers, transport/factory, companions и installer. Перед новым integration surface сначала проверьте `docs/architecture.md`, текущие tool registrations и [матрицу capabilities](docs/capabilities.md); модуль или интерфейс без подключения не добавляет публичное runtime обещание.

## Локальная проверка

Минимальная поддерживаемая версия — Node.js 22; рекомендуется Node.js 24 LTS:

```bash
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build
npm run test:installer
npm run test:native-registration
```

`npm run test:installer` проверяет pinned source SHA, безопасный перенос внешнего env в fixture, private-config wrapper path для HTTP/Hub/write gates, literal dotenv parsing и отказ для `META_MCP_CONFIG_DIR`, redacted doctor handshake/listTools, сохранение configuration/token-store при update, отсутствие переключения после failed build, rollback и archive-only uninstall. Fixture использует синтетические маркеры, не подключается к Meta и не проверяет owner account.

`npm run test:native-registration` stages exact-origin manifests and launchers in temporary directories; Windows registry access is replaced with a fake adapter. It does not modify the current user's Chrome registration.

CI запускает эти проверки на Node.js 22 и 24 для Linux, macOS и Windows, включая изолированные Native Messaging registration fixtures и реальную проверку ACL приватного storage на Windows. Отдельный Windows job собирает `native-host/windows/InstagramNativeHost.csproj` и сохраняет `InstagramNativeHost.exe` вместе с publish output как 14-дневный artifact; это не GitHub Release asset.

## Требования к PR

- Используйте fake transports/fixtures вместо owner token, Meta App или real account.
- Не добавляйте секреты, персональные browser sessions/cookies или account-specific paths в fixture, docs, logs и снимки.
- Для mutations показывайте preview, фиксацию request ID/source/context, no-retry поведение при неизвестном outcome и read-back. Не тестируйте запись на live Meta.
- Меняйте capability/roadmap/install docs вместе с реальной runtime surface. Разделяйте tests PASS, client connection, live Meta authorization и UI readiness.
- Изменение `.env.example` содержит только имена и безопасные пустые значения/placeholders. Не добавляйте blind dependency upgrades.
- Installer хранит runtime env/token-store вне app archive, создаёт recoverable backup и не переписывает неизвестный target или MCP client configuration.

Release tag/publication, server deploy, live OAuth setup и owner client config — отдельный release/operator gate; CI их не выполняет.
