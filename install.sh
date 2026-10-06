#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage: install.sh --revision <full-commit-sha> [--source-dir PATH] [--target PATH] [--config-dir PATH]

Install a clean checkout of exactly the selected commit. The source checkout
must be clean; credentials and OAuth state stay in the separate config directory.
EOF
}

revision=""
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
target="${XDG_DATA_HOME:-${HOME:?HOME is not set}/.local/share}/meta-instagram-mcp/app"
config_dir="${XDG_CONFIG_HOME:-${HOME:?HOME is not set}/.config}/meta-instagram-mcp"
while (($#)); do
  case "$1" in
    --revision) revision="${2:-}"; shift 2 ;;
    --source-dir) source_dir="${2:-}"; shift 2 ;;
    --target) target="${2:-}"; shift 2 ;;
    --config-dir) config_dir="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$revision" =~ ^[[:xdigit:]]{40}$ ]] || { echo "Pass a full 40-character commit SHA with --revision." >&2; exit 2; }
for command in git node npm tar; do command -v "$command" >/dev/null 2>&1 || { printf 'Required command is missing: %s\n' "$command" >&2; exit 1; }; done
node -e 'const m=Number(process.versions.node.split(".")[0]); if (m < 20) process.exit(1)' || { echo "Node.js 20 or newer is required." >&2; exit 1; }

source_dir="$(cd "$source_dir" && pwd -P)"
target="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$target")"
config_dir="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$config_dir")"
actual_revision="$(git -C "$source_dir" rev-parse HEAD 2>/dev/null)" || { echo "Source directory is not a Git checkout." >&2; exit 1; }
actual_revision_lower="$(printf '%s' "$actual_revision" | tr '[:upper:]' '[:lower:]')"
revision_lower="$(printf '%s' "$revision" | tr '[:upper:]' '[:lower:]')"
[[ "$actual_revision_lower" == "$revision_lower" ]] || { echo "Source HEAD does not match --revision." >&2; exit 1; }
[[ -z "$(git -C "$source_dir" status --porcelain)" ]] || { echo "Source checkout has local changes; use a clean release checkout." >&2; exit 1; }
[[ -z "$(git -C "$source_dir" ls-tree -r --name-only "$actual_revision" -- .env)" ]] || { echo "Refusing a source revision that tracks .env." >&2; exit 1; }
[[ "$target" != "/" && "$target" != "$HOME" ]] || { echo "Refusing an unsafe installation target." >&2; exit 1; }
node "$source_dir/tools/guard-install-paths.mjs" "$target" "$config_dir"

target_parent="$(dirname "$target")"
target_name="$(basename "$target")"
mkdir -p "$target_parent"
target_parent="$(cd "$target_parent" && pwd -P)"
target="$target_parent/$target_name"
[[ ! -L "$target" ]] || { echo "Refusing a symlink installation target." >&2; exit 1; }
if [[ -e "$target" && ! -f "$target/.meta-instagram-mcp-install.json" ]]; then
  echo "Target exists but is not managed by this installer; move it or choose another --target." >&2
  exit 1
fi

stage="$(mktemp -d "$target_parent/.${target_name}.stage.XXXXXXXX")"
cleanup() { [[ -z "${stage:-}" || ! -d "$stage" ]] || rm -rf -- "$stage"; }
trap cleanup EXIT
git -C "$source_dir" archive "$actual_revision" | tar -xf - -C "$stage"
[[ -f "$stage/package.json" && -f "$stage/package-lock.json" && -f "$stage/.env.example" ]] || { echo "Selected revision is missing required package files." >&2; exit 1; }
(cd "$stage" && npm ci --no-audit --no-fund && npm run build)

mkdir -p "$config_dir"
chmod 700 "$config_dir"
if [[ ! -e "$config_dir/.env" ]]; then
  if [[ -f "$source_dir/.env" ]]; then
    cp "$source_dir/.env" "$config_dir/.env"
  else
    cp "$stage/.env.example" "$config_dir/.env"
  fi
  chmod 600 "$config_dir/.env"
fi

node -e 'const fs=require("node:fs"); const p=require("node:path"); const pkg=JSON.parse(fs.readFileSync(p.join(process.argv[1],"package.json"),"utf8")); fs.writeFileSync(p.join(process.argv[1],".meta-instagram-mcp-install.json"),JSON.stringify({revision:process.argv[2].toLowerCase(),version:pkg.version,installedAt:new Date().toISOString()},null,2)+"\n",{mode:0o600});' "$stage" "$actual_revision"

backup=""
if [[ -e "$target" ]]; then
  backup="$target_parent/${target_name}.backup.$(date -u +%Y%m%dT%H%M%SZ).${actual_revision:0:8}"
  [[ ! -e "$backup" ]] || { echo "Backup path already exists; refusing to overwrite it." >&2; exit 1; }
  mv -- "$target" "$backup"
fi
if ! mv -- "$stage" "$target"; then
  if [[ -n "$backup" && ! -e "$target" ]]; then mv -- "$backup" "$target"; fi
  echo "Promotion failed; the previous installation was restored when available." >&2
  exit 1
fi
stage=""
printf 'Installed revision %s\nApp: %s\nConfig: %s\n' "$actual_revision" "$target" "$config_dir"
if [[ -n "$backup" ]]; then printf 'Previous install backup: %s\n' "$backup"; fi
