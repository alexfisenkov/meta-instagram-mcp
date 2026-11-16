# Instagram Connection Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Упростить ученикам выбор прямого официального и браузерного подключения Instagram.

**Architecture:** Read-only planner отдельно от OAuth, API account resolver и browser runtime. Существующие guard/state/token-store и source-router сохраняются. Local bridge opt-in обслуживается одним runtime со stdio.

**Tech Stack:** Node22+, TypeScript, MCP SDK, Vitest, существующие Chrome extension/Native Host и shell/PowerShell installers.

**Spec:** `docs/superpowers/specs/2026-11-16-connection-paths-design.md`.

## Global Constraints

- Прямой Instagram Login проверяется первым; наблюдение Dashboard не считается подтверждённым доступом.
- Существующие Unified/Facebook credentials и регистрации сохраняются; silent migration отсутствует.
- Browser без Meta App/VPS; HTTP только exact loopback и explicit browser opt-in, remote HTTPS unchanged, redirects запрещены.
- Секреты, сырые provider payload, реальные ученики и их переписка не попадают в git/logs.
- Writes не включаются автоматически. Hosted broker и сервер владельца не изменяются этим portable выпуском.

## Review Focus

- В Dashboard есть только Unified: агент должен назвать неизвестное и предложить browser, а не объявить direct доступным.
- Имеется рабочее старое подключение: его не переключать на новый default.
- Short OAuth ответ смешан/неоднозначен или IDs расходятся: отказ до изменения store.
- Native Host/manifest занят другим профилем: dry-run и apply отказывают без перезаписи.
- Browser route без API credentials должен работать в том же stdio процессе и закрывать loopback listener при остановке.

## Task 1 — Direct API (writer A)

Files: `src/oauth.ts`, `config.ts`, `oauth-account-identity.ts`, `callback-server.ts`, `authorization-status.ts`, related tests.

- [ ] RED tests flat/wrapped/mixed grant, minimal scopes, correct Boolean URL fields, canonical/profile identity и cancellation.
- [ ] Реализовать `verifyDirectInstagramToken({graphApiVersion}, accessToken, {expectedAccountId?,expectedOAuthUserId?,signal?}, clientFactory?)` с canonical `userId`, `username`, optional `appScopedId`, `permissionsVerification:unknown`.
- [ ] Протянуть identity proof в callback, сохранить actual grants либо unknown, не наследовать прежние scopes.
- [ ] Target regression tests; сообщить контракты root, не коммитить общий worktree отдельно.

## Task 2 — Browser local profile (writer B)

Files: `src/server.ts`, `bridge-client.ts`, `transport-config.ts`, `companion/browser-native-host.ts`, `tools/run.mjs`, `tools/cli.mjs`, `tools/register-native-host.mjs`, new setup helper, relevant tests и `docs/browser-only.md`.

- [ ] RED tests explicit local browser HTTP, reject localhost/127.* and remote redirects, same-runtime stdio/Hub и shutdown.
- [ ] Добавить opt-in listener к тому же runtime и узкий production loopback bridge permission.
- [ ] Dry-run/apply setup: external private files, random bearer, existing registry preflight, idempotent preservation, no writes.
- [ ] Добавить чистый SDK/Native Host fixture без реального Chrome login и без изменения owner registration.

## Task 3 — Planner, resolver, instructions, release (root)

Files: new `src/connection-plan.ts`, `src/tools.ts`, `mcp-server.ts`, `account-context.ts`, tests, `.env.example`, README, setup/install/capabilities/file-map/runbook docs, package version/changelog.

- [ ] RED planner tests direct-first/unknown/blocked business/browser choice/existing mode, strict MCP input schema and configuration-only output.
- [ ] Manual direct Dashboard token resolver with fresh identity/CAS and credential-bound metadata, profile/media reads without inherited old token IDs.
- [ ] Expose `meta_connection_plan` (read-only, no network/UI/config write) and actual setup checks; public install/update prompt invokes it before asking for business setup.
- [ ] Rewrite student path with three distinct recipes: direct API, browser local read-only, conditional Unified; retain old working routes.
- [ ] Full checks, independent review, meaningful immutable install/update/rollback fixture, one final CI and v0.4.0 release/read-back.
- [ ] Private engineering protocol states separately synthetic/live evidence and owner actions still required.
