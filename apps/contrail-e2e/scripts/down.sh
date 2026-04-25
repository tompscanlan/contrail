#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ Tearing down (removes volumes — clean slate)..."
docker compose down -v

echo "✓ Down. All state wiped."
