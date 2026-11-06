#!/usr/bin/env bash
set -euo pipefail

case "${BASH_SOURCE[0]}" in
  */*) cd "${BASH_SOURCE[0]%/*}" ;;
esac
source ./scripts/runtime/bootstrap.sh
edge_find_node
# Stop this checkout's services and whatever holds their ports. No .env or GPU is needed to stop.
exec "$EDGE_NODE_EXECUTABLE" --import tsx scripts/runtime/launcher.ts stop "$@"
