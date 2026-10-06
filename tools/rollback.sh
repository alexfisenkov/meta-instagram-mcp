#!/usr/bin/env bash
set -Eeuo pipefail

target="${XDG_DATA_HOME:-${HOME:?HOME is not set}/.local/share}/meta-instagram-mcp/app"
backup=""
while (($#)); do
  case "$1" in
    --target) target="${2:-}"; shift 2 ;;
    --backup) backup="${2:-}"; shift 2 ;;
    --help|-h) echo "Usage: tools/rollback.sh --backup <installer-backup> [--target PATH]"; exit 0 ;;
    *) echo "Unknown option." >&2; exit 2 ;;
  esac
done
[[ -n "$backup" ]] || { echo "Select the exact backup path printed by install.sh." >&2; exit 2; }
target="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$target")"
backup="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$backup")"
[[ "$target" != "$backup" && ! -L "$target" && ! -L "$backup" ]] || { echo "Target/backup path is invalid." >&2; exit 1; }
[[ -f "$target/.meta-instagram-mcp-install.json" && -f "$backup/.meta-instagram-mcp-install.json" ]] || { echo "Both paths must be managed installer directories." >&2; exit 1; }
parent="$(dirname "$target")"
name="$(basename "$target")"
rollback_copy="$parent/${name}.rollback.$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$rollback_copy" ]] || { echo "Rollback backup path already exists; refusing to overwrite it." >&2; exit 1; }
mv -- "$target" "$rollback_copy"
if ! mv -- "$backup" "$target"; then
  mv -- "$rollback_copy" "$target"
  echo "Rollback failed; the current installation was restored." >&2
  exit 1
fi
printf 'Restored backup: %s\nPrevious install retained: %s\n' "$backup" "$rollback_copy"
