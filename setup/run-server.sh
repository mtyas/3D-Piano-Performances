#!/usr/bin/env bash
# Start the stage server with the settings written by setup-server.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -x .venv/bin/python ]] || { echo "Run ./setup/setup-server.sh first." >&2; exit 1; }
if [[ -f server.env ]]; then set -a; . ./server.env; set +a; fi
exec .venv/bin/python server.py
