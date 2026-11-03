#!/usr/bin/env bash
set -euo pipefail

# Resolve the checkout without depending on external dirname or the caller's cwd.
case "${BASH_SOURCE[0]}" in
  */*) cd "${BASH_SOURCE[0]%/*}" ;;
esac
source ./scripts/runtime/bootstrap.sh
edge_find_node
exec "$EDGE_NODE_EXECUTABLE" --import tsx scripts/runtime/launcher.ts start "$@"
