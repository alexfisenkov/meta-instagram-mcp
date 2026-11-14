# Portable Unified Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Выпустить совместимое обновление локального MCP для Meta Unified Login.

**Architecture:** Отдельный AuthMode `unified` проходит через существующие OAuth/state/token-store и account-context. Graph host и scopes выбираются по grant family; Page-only требования Facebook не применяются к BISU. Hosted broker сохраняет отдельные vault/process/contracts.

**Tech Stack:** TypeScript, Node 22+, MCP SDK, Vitest, существующие shell/PowerShell installer fixtures.

**Spec:** `docs/superpowers/specs/2026-11-14-portable-unified-login-design.md`.

## Global Constraints

- Нет новых dependencies, секретов и реальных ученических данных в репозитории.
- Совместимость `instagram` и `facebook`; никаких silent migration или включения writes.
- Ошибки и cancel сохраняют старый token; state одноразовый, привязан к app/config/account.
- Unified — только официальный HTTPS redirect, BISU и `graph.facebook.com`; никакого Page requirement.
- Одна финальная hosted CI-проверка собранного набора; release отдельно от deployment/live acceptance.

## Review Focus

- Опечатка authMode не должна молча превращать Unified в Instagram Login.
- Пустой/неполный/пагинированный asset list не даёт автоматического выбора чужого аккаунта.
- Environment token имеет приоритет, но не наследует stored permissions/identity.
- SYSTEM_USER `/me` не является Instagram user id; Graph reads идут по выбранному asset id.
- Нет HTTPS callback — понятный setup failure и документированный Dashboard-token путь.

## Task 1: OAuth/config/state/identity (writer A)

Files: `src/oauth.ts`, `config.ts`, `oauth-state.ts`, `oauth-account-identity.ts`, `token-store.ts`, новый `unified-oauth.ts`, соответствующие unit tests.

- [ ] Добавить fail-first tests для Unified URL/config/state drift/BISU/grants/discovery.
- [ ] Реализовать `AuthMode=unified`, `configId`, HTTPS guard, одношаговый code exchange, live verification и ambiguous fail.
- [ ] Проверить token/state legacy regression; Unified refresh возвращает явный reauth-required.

Interface: `readUnifiedGrantedPermissions({graphApiVersion,appId?,appSecret?}, token)`; `verifyOAuthAccountIdentity` принимает app credentials и возвращает userId/permissions/clientBusinessId; `buildAuthUrl` принимает configId; state хранит appId/configId.

## Task 2: Runtime/tools/CLI (writer B)

Files: `src/runtime.ts`, `callback-server.ts`, `tools.ts`, `authorization-status.ts`, `src/cli/*`, `tools/{run,cli,doctor}.mjs`, профильные tests.

- [ ] Fail-first tests для Unified callback, live auth status, resolver и safe setup errors.
- [ ] Протянуть app/config pins и actual grants в callback до token commit.
- [ ] Маршрутизировать legacy account tools по IG asset на Facebook Graph, сохранить env credential precedence.
- [ ] Поддержать явный loopback listen для HTTPS proxy; добавить env allowlist.
- [ ] Проверить Dashboard-token discovery, cancel/error preservation и secret redaction.

## Task 3: Domain routing/docs/release (root)

Files: `src/account-context.ts`, `api-provider.ts`, `direct.ts`, `comments.ts`, tests, README, `.env.example`, docs, CHANGELOG.

- [ ] Fail-first integration tests: Unified без Page, правильный host/id/scopes, no inherited grants, rejected identity.
- [ ] Реализовать per-family routing, ограничить неподтверждённые action capabilities.
- [ ] Обновить setup/update/troubleshooting: Unified, HTTPS, Dashboard test token, challenge и client crash границы.
- [ ] Собрать typecheck/test/build и installer/update/rollback/native fixtures.
- [ ] Независимые критики и принятые fixes (не более двух раундов).
- [ ] Коммит/push без промежуточных Actions, один финальный CI, tag/assets/read-back.
- [ ] Сохранить engineering release evidence; подготовить уведомление без необоснованных live обещаний.
