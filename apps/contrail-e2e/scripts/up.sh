#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "→ First run: copying .env.example to .env"
  cp .env.example .env
fi

DEVNET_COMPOSE="../../../atproto-devnet/docker-compose.yml"
if [ ! -f "$DEVNET_COMPOSE" ]; then
  echo "Error: atproto-devnet not found at $DEVNET_COMPOSE"
  echo ""
  echo "Clone it as a sibling of the contrail repo:"
  echo "  git clone https://github.com/OpenMeet-Team/atproto-devnet.git ../../../../atproto-devnet"
  exit 1
fi

echo "→ Bringing up postgres (PLC depends on it)..."
docker compose up -d --wait postgres maildev

echo "→ Bringing up devnet (PLC, PDS, Jetstream, TAP, init)..."
docker compose up -d --wait

# shellcheck disable=SC1091
source .env

echo ""
echo "Services:"
echo "  PDS:           http://localhost:${DEVNET_PDS_PORT:-4000}"
echo "  PLC:           http://localhost:${DEVNET_PLC_PORT:-2582}"
echo "  Jetstream:     ws://localhost:${DEVNET_JETSTREAM_PORT:-6008}"
echo "  TAP:           http://localhost:${DEVNET_TAP_PORT:-2480}"
echo "  Postgres:      localhost:${PG_PORT:-5433}"
echo "  MailDev UI:    http://localhost:${MAILDEV_WEB_PORT:-1080}"
echo ""
echo "Next:"
echo "  pnpm test         # run the e2e suite (ingester + XRPC handler run in-process)"
