# MCP v0.2.8 Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task.

**Goal:** Обновить диагностический контракт и выпустить один проверенный v0.2.8 для действующих установок.

**Architecture:** Additive status projection; read-only bounded Meta verifier; external operational context; startup runtime metadata; existing installers and deployment operators.

**Tech Stack:** TypeScript, Node 22/24, existing MCP SDK, Vitest, shell operators.

**Spec:** `docs/superpowers/specs/2026-11-05-status-release.md`.

## Global Constraints

Один writer за раз. Не менять OAuth, requested scopes, публикацию, аккаунты, cloud allowlist или чужой dirty test. Секреты и app-specific настройки вне public Git. Никаких intermediate Actions; commit messages `[skip ci]`, один manual final CI. Выпуск и установка уже разрешены владельцем. Максимум два раунда независимого review.

## Review Focus

Совместимость legacy status; различие stored/live/cached; zero/malformed expiry; bounded cancellation и sanitized errors; active credential binding; external config allowlist; startup revision identity; installer rollback; source/asset provenance.

## Task 1: Реализовать status contract, тесты и документацию v0.2.8

Owner: implementation worker. Files: existing `src/tools.ts`, `src/layered-tools.ts`, config/runtime/server wiring and new focused helpers; associated `tests/`; `README.md`, `CHANGELOG.md`, `docs/{operations-runbook,capabilities,file-map,install}.md`, package/lock. Не менять unrelated operational/private files, existing auth flow или dependencies. Inspect related source before edits; use project patterns.

- [ ] Прочитать spec и канон; добавить failing focused behavioral tests для runtime/authorization/context и legacy shape.
- [ ] Реализовать минимальные helpers и wiring согласно spec. Использовать `requestJsonHttp` с AbortController 5s wall-clock, timeoutMs 5000, allowRouteRetry false, catch fixed code; не OAuth wrapper с upstream message.
- [ ] Добавить meaningful cases: zero/positive/absent/malformed independent expiry; token/app mismatch; env override/cache invalidation; no token/mode unsupported/timeouts; canary secrets never in new projection; runtime stamp invalid/version mismatch/server revision; private URL whitelist; capabilities schema version/no UI.
- [ ] Обновить пользовательские docs и CHANGELOG без реальных account IDs/paths/контактов; version 0.2.8 package + lock. Явно разделить configured, runtime snapshot и live verification. Не обещать всем токенам 60 дней.
- [ ] Запустить focused tests, typecheck, build, full tests, существующие operator tests подходящие изменению. Self-review diff, commit `[skip ci]`, report exact commands/results/SHA and limits. Не push и не deploy.

## Task 2: Проверить и выпустить exact SHA

Owner: controller. Inputs: reviewed Task 1 commit and tests. Files: release notes/provenance and private engineering receipt.

- [ ] Независимый spec/code/security review, исправить принятые находки одним writer, scoped re-review максимум раунд 2.
- [ ] Secret scan staged/release tree; fast-forward main без потери dirty test; push without intermediate CI. Manual final CI один run; проверить все jobs.
- [ ] Получить Windows asset из этого run, hash и provenance; tag/release v0.2.8 exact SHA. Read back release metadata/assets.

## Task 3: Синхронизировать установки и подтвердить результат

Owner: controller. Inputs: Task 2 exact release SHA/artifacts; existing server operators and private external configs.

- [ ] Поддержанный working Node24 на Mac, installer exact clean SHA с backup/config preservation. NativeHost registrar dry-run/apply existing extension ID/config.
- [ ] Общий server lock, deploy exact SHA, read-back PID/cwd/version/health/tools, NativeHost registrar and extension stage with existing service-owned profile; rollback под тем же lock при ошибке.
- [ ] Записать private operational context, не менять токены. Проверить live verify/profile/media/reach/comments bounded reads, status runtime/source, capabilities and connected client catalog. Не запускать inbox/Direct/UI/publish/delete.
- [ ] Обновить internal receipt и school map существующим GitHub-first процессом; указать отдельные deployment/CI/runtime результаты и незавершённые границы.
