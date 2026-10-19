#!/usr/bin/env bash
# One-step setup for the 3D Piano Performances stage server (macOS / Linux).
#   ./setup/setup-server.sh                       interactive
#   ./setup/setup-server.sh --origin https://stage.example.com --port 8765 --name "Your Name" [--service]
# Creates .venv, installs dependencies, generates a private performer password and writes server.env.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

ORIGIN="" PORT="" NAME="" SERVICE=0 YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --origin) ORIGIN="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --service) SERVICE=1; shift;;
    -y|--yes) YES=1; shift;;
    -h|--help) sed -n 2,6p "$0"; exit 0;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done
ask() { # ask VAR "Question" default
  local __var="$1" prompt="$2" default="$3" value
  if [[ -n "${!__var}" ]]; then return; fi
  if [[ $YES -eq 1 || ! -t 0 ]]; then printf -v "$__var" '%s' "$default"; return; fi
  read -r -p "$prompt [$default]: " value
  printf -v "$__var" '%s' "${value:-$default}"
}

PYTHON="${PYTHON:-}"
for candidate in python3 python; do
  if [[ -z "$PYTHON" ]] && command -v "$candidate" >/dev/null 2>&1; then PYTHON="$candidate"; fi
done
[[ -n "$PYTHON" ]] || { echo "Python 3.9+ is required. Install it from https://www.python.org/ or your package manager." >&2; exit 1; }
"$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "Python 3.9+ is required (found $("$PYTHON" --version))." >&2; exit 1; }

echo "==> Creating virtual environment in .venv"
"$PYTHON" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r requirements.txt

ask PORT "Port for the stage server" "8765"
ask ORIGIN "Public URL visitors will use (exact origin, no path)" "http://localhost:$PORT"
ask NAME "Performer name shown on archived recordings" "Pianist"
ORIGIN="${ORIGIN%/}"
[[ "$ORIGIN" =~ ^https?://[^/]+$ ]] || { echo "Origin must look like https://stage.example.com (no path)." >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "Port must be a number." >&2; exit 1; }
case "$NAME$ROOT" in *[\'\"\\\`\$]*) echo "The performer name and install folder must not contain quotes, backslashes, \` or \$." >&2; exit 1;; esac

if [[ ! -s .performer-password ]]; then
  echo "==> Generating a private performer password"
  ( umask 077; .venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(24))' > .performer-password )
  NEW_PASSWORD=1
else
  NEW_PASSWORD=0
fi
chmod 600 .performer-password

q() { printf "'%s'" "$1"; } # values are validated to contain no quotes
( umask 077; cat > server.env <<CONF
# Written by setup/setup-server.sh. Private: not committed to Git.
PORT=$(q "$PORT")
HOST=0.0.0.0
PUBLIC_ORIGIN=$(q "$ORIGIN")
PERFORMER_NAME=$(q "$NAME")
PERFORMER_PASSWORD_FILE=$(q "$ROOT/.performer-password")
ARCHIVE_DIR=$(q "$ROOT/archives")
CONF
)
mkdir -p archives
chmod +x setup/run-server.sh

if [[ $SERVICE -eq 1 ]]; then
  if command -v systemctl >/dev/null 2>&1; then
    UNIT=/etc/systemd/system/piano-stage.service
    echo "==> Installing systemd service $UNIT (needs sudo)"
    sudo tee "$UNIT" >/dev/null <<UNIT
[Unit]
Description=3D Piano Performances stage server
After=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$ROOT
ExecStart=$ROOT/setup/run-server.sh
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
    sudo systemctl daemon-reload && sudo systemctl enable --now piano-stage
  else
    echo "--service needs systemd (Linux). On macOS run setup/run-server.sh, or see docs/server-setup.md." >&2
  fi
fi

echo
echo "Setup complete."
if [[ $NEW_PASSWORD -eq 1 ]]; then
  echo "Performer password (save it in your password manager; it is stored in .performer-password):"
  echo "    $(cat .performer-password)"
fi
echo "Start the server:   ./setup/run-server.sh"
echo "Then open:          http://localhost:$PORT   (public URL: $ORIGIN)"
