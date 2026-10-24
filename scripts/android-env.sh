# Environment for Android builds; sourced by the `npm run android:*` scripts
# (and handy in a shell: `. scripts/android-env.sh`). It only changes this
# shell: the system's Rust and Java stay the defaults everywhere else.
# Paths match scripts/android-setup.sh; set the variables to use others.

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export JAVA_HOME="${A0_JAVA_HOME:-$HOME/.local/share/action0/jdk}"
if [ -z "${NDK_HOME:-}" ]; then
  NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -n 1)"
  export NDK_HOME
fi
# rustup's cargo first (it has the Android targets), then Java and the SDK tools.
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
