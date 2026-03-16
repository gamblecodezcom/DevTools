#!/usr/bin/env bash
# bootstrap.sh — legacy compatibility wrapper (DevTools)
# Canonical script is: gcz_bootstrap.sh
DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=gcz_bootstrap.sh
source "$DIR/gcz_bootstrap.sh" "${1:-devtools}" "${@:2}"
