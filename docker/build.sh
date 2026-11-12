#!/usr/bin/env bash
# Runs inside the build container (scripts/container.sh starts it): copies
# the working tree from /host (read-only) into /work/src and runs one task.
set -euo pipefail
task="$1"
shift

# Caches and the Android debug key live on the volume, so they survive runs
# (and later debug APKs install over earlier ones).
export npm_config_cache=/work/cache/npm XDG_CACHE_HOME=/work/cache \
  GRADLE_USER_HOME=/work/cache/gradle ANDROID_USER_HOME=/work/cache/android

# The working tree as it is now, minus what git ignores, plus .env.local
# (client IDs). Ignored files already in /work/src (node_modules, target,
# dist, Gradle output) are kept, so builds are incremental. rsync reads
# .gitignore lines as plain excludes: `!` negations wouldn't work.
mkdir -p /work/src
rsync -a --delete \
  --include=/.env.local --exclude=/.git --exclude=/out \
  --filter=':- .gitignore' \
  /host/ /work/src/
cd /work/src

# A fresh `npm ci` only when package-lock.json changed.
if ! sha256sum --status --check /work/npm-ci.sha256 2>/dev/null; then
  npm ci
  sha256sum package-lock.json >/work/npm-ci.sha256
fi

out=/host/out
case "$task" in
  check)
    # Everything CI's check job runs, in the same order (cargo needs dist).
    npm run check
    cd src-tauri
    cargo --version
    cargo fmt --check
    cargo clippy --all-targets --locked -- -D warnings
    cargo test --locked
    ;;
  linux)
    rm -rf src-tauri/target/release/bundle
    npm run app:build -- "$@"
    rm -rf "$out/linux" && mkdir -p "$out/linux"
    cp src-tauri/target/release/bundle/appimage/*.AppImage \
      src-tauri/target/release/bundle/deb/*.deb \
      src-tauri/target/release/bundle/rpm/*.rpm "$out/linux/"
    ls -lh "$out/linux"
    ;;
  android)
    # By default a debug-signed APK for phones (arm64), like CI's android job.
    [ $# -gt 0 ] || set -- --debug --apk --target aarch64
    rm -rf src-tauri/gen/android/app/build/outputs
    npm run android:build -- "$@"
    rm -rf "$out/android" && mkdir -p "$out/android"
    find src-tauri/gen/android/app/build/outputs \( -name '*.apk' -o -name '*.aab' \) \
      -exec cp {} "$out/android/" \;
    ls -lh "$out/android"
    ;;
  *)
    echo "unknown task: $task" >&2
    exit 2
    ;;
esac
