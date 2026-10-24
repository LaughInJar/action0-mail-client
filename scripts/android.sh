#!/usr/bin/env bash
# Runs `tauri android <command> [arguments]` with the Android build
# environment (scripts/android-env.sh), e.g. `scripts/android.sh dev`.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/android-env.sh
exec npx tauri android "$@"
