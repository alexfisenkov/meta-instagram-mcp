#!/usr/bin/env bash
set -Eeuo pipefail

target="${XDG_DATA_HOME:-${HOME:?HOME is not set}/.local/share}/meta-instagram-mcp/app"
confirm=""
while (($#)); do
  case "$1" in
    --target) target="${2:-}"; shift 2 ;;
    --confirm) confirm="${2:-}"; shift 2 ;;
    --help|-h) echo "Usage: uninstall.sh --confirm REMOVE-APP [--target PATH]"; exit 0 ;;
    *) echo "Unknown option." >&2; exit 2 ;;
  esac
done
[[ "$confirm" == "REMOVE-APP" ]] || { echo "Pass --confirm REMOVE-APP to archive the installed app. Config and backups are retained." >&2; exit 2; }
target="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$target")"
[[ ! -L "$target" && -f "$target/.meta-instagram-mcp-install.json" ]] || { echo "Managed installation not found; refusing to move this path." >&2; exit 1; }
parent="$(dirname "$target")"
name="$(basename "$target")"
archive="$parent/${name}.uninstalled.$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$archive" ]] || { echo "Archive path already exists; refusing to overwrite it." >&2; exit 1; }
mv -- "$target" "$archive"
printf 'App archived: %s\nConfig and prior backups were retained.\n' "$archive"
