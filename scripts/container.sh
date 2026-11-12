#!/usr/bin/env bash
# Builds or checks action0 in a container, so this machine needs only Docker:
#   scripts/container.sh check             everything CI's check job runs
#   scripts/container.sh linux [args]      AppImage, .deb and .rpm into out/linux/
#   scripts/container.sh android [args]    a debug-signed APK into out/android/
# [args] go to `tauri build` / `tauri android build` (android's replace the
# default `--debug --apk --target aarch64`). --refresh (first) rebuilds the
# image from scratch: newest Rust stable, Ubuntu updates, Android packages.
#
# The images hold only toolchains (docker/Dockerfile). The source is copied
# into a volume per image (action0-linux, action0-android), where
# node_modules, Rust and Gradle output stay between runs; only out/ is
# written here. `docker volume rm action0-linux` starts that one over.
set -euo pipefail
cd "$(dirname "$0")/.."

refresh=()
if [ "${1:-}" = "--refresh" ]; then
  refresh=(--pull --no-cache)
  shift
fi
task="${1:?usage: scripts/container.sh [--refresh] check|linux|android [args]}"
case "$task" in
  check | linux) image=linux ;;
  android) image=android ;;
  *)
    echo "unknown task: $task (check, linux or android)" >&2
    exit 2
    ;;
esac

docker build "${refresh[@]}" --target "$image" --tag "action0-build:$image" \
  --build-arg UID="$(id -u)" --build-arg GID="$(id -g)" \
  --build-arg NODE_VERSION="$(cat .nvmrc)" \
  --build-context scripts=scripts \
  --file docker/Dockerfile docker

mkdir -p out
tty=()
[ -t 0 ] && [ -t 1 ] && tty=(--interactive --tty)
exec docker run --rm "${tty[@]}" \
  --mount "type=bind,src=$PWD,dst=/host,readonly" \
  --mount "type=bind,src=$PWD/out,dst=/host/out" \
  --mount "type=volume,src=action0-$image,dst=/work" \
  --mount "type=volume,src=action0-cargo-registry,dst=/home/builder/.cargo/registry" \
  "action0-build:$image" bash /host/docker/build.sh "$@"
