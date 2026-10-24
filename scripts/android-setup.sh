#!/usr/bin/env bash
# Installs what Android builds need, into your home folder only:
#   - rustup with the Android targets (~/.rustup, ~/.cargo; PATH untouched)
#   - JDK 21 (Eclipse Temurin) in ~/.local/share/action0/jdk
#   - the Android SDK in ~/Android/Sdk: platform 36, build tools, NDK,
#     and (with --emulator) the emulator and a Google Play system image.
# Running it again installs what's missing. It accepts the Android SDK
# packages' licenses on your behalf.
set -euo pipefail

CMDLINE_TOOLS=16111833
PLATFORM="platforms;android-36"
BUILD_TOOLS="build-tools;36.1.0"
NDK="ndk;29.0.14206865"
IMAGE="system-images;android-36;google_apis_playstore;x86_64"

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
JDK="${A0_JAVA_HOME:-$HOME/.local/share/action0/jdk}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
emulator=false
[ "${1:-}" = "--emulator" ] && emulator=true

step() { printf '\n== %s\n' "$*"; }

step "rustup and the Android targets"
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable
fi
"$CARGO_HOME/bin/rustup" target add \
  aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

step "JDK 21"
if [ ! -x "$JDK/bin/java" ]; then
  mkdir -p "$JDK"
  curl -sSfL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse" |
    tar -xz -C "$JDK" --strip-components=1
fi
"$JDK/bin/java" -version 2>&1 | head -n 1

step "Android SDK"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  mkdir -p "$SDK/cmdline-tools"
  tmp="$(mktemp -d)"
  curl -sSfL -o "$tmp/tools.zip" \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip"
  unzip -q "$tmp/tools.zip" -d "$tmp"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -rf "$tmp"
fi
export JAVA_HOME="$JDK"
# sdkmanager is deprecated in favour of the new `android` CLI, which
# collects usage data by default; sdkmanager still installs the same
# packages. It asks to accept each package's license: `yes` answers.
sdkmanager="$SDK/cmdline-tools/latest/bin/sdkmanager"
packages=("platform-tools" "$PLATFORM" "$BUILD_TOOLS" "$NDK")
$emulator && packages+=("emulator" "$IMAGE")
"$sdkmanager" --sdk_root="$SDK" "${packages[@]}" < <(yes)

if $emulator; then
  step "Emulator \"action0\""
  if ! "$SDK/cmdline-tools/latest/bin/avdmanager" list avd -c | grep -qx action0; then
    echo no | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd \
      --name action0 --package "$IMAGE" --device pixel_7
  fi
fi

step "Done"
echo "Build environment: . scripts/android-env.sh   (npm run android:dev does it for you)"
