# Архив: локальная ветка, которой не было на GitHub (20.10.2026)

Ветка в этом репозитории не содержит кода и не запускает CI: у неё нет `.github/workflows`.

- `bundles/fix-companion-quiescent-close-20261010.bundle` — полный `git bundle` ветки `fix/companion-quiescent-close-20261010` (вершина `0ab74cd`, 1 коммит сверх GitHub: «drain companion shutdown work»).
- Причина: `ci.yml` в этом репозитории запускается на push в любую ветку, поэтому ветку целиком отправлять нельзя.
- Восстановить: `git fetch bundles/fix-companion-quiescent-close-20261010.bundle 'refs/heads/archive/20261020/fix/companion-quiescent-close-20261010:refs/heads/fix/companion-quiescent-close-20261010'`.
