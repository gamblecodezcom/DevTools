#!/usr/bin/env bash
# GCZ Unified Bootstrap — DevTools project
# Delegates to canonical: /var/www/html/gcz/gcz_bootstrap.sh
#
# Usage:
#   source gcz_bootstrap.sh devtools "Claude Code" "optional-label"
#   bash   gcz_bootstrap.sh devtools "Claude Code"

GCZ_CANONICAL="/var/www/html/gcz/gcz_bootstrap.sh"

_PROJ="${1:-devtools}"
_CLIENT="${2:-Claude Code}"
_LABEL="${3:-}"

if [[ -f "$GCZ_CANONICAL" ]]; then
  # shellcheck source=/var/www/html/gcz/gcz_bootstrap.sh
  source "$GCZ_CANONICAL" "$_PROJ" "$_CLIENT" "$_LABEL"
else
  echo "[gcz-bootstrap] ERROR: canonical bootstrap not found at $GCZ_CANONICAL" >&2
  return 1 2>/dev/null || exit 1
fi
