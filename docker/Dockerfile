# syntax=docker/dockerfile:1
# Toolchains for building and checking action0 without installing them on
# the host (scripts/container.sh builds and runs these). No source inside.
#   linux:   Node, Rust and the libraries Tauri links against, as in CI
#   android: linux plus JDK 21, the Android SDK and NDK (scripts/android-setup.sh)

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim AS node

# Ubuntu 22.04 like the release workflow, so the AppImage needs the same old
# glibc and runs on older systems too.
FROM ubuntu:22.04 AS linux
ARG UID=1000
ARG GID=1000
# The AppImage tools are AppImages themselves, and containers have no FUSE.
ENV DEBIAN_FRONTEND=noninteractive \
    APPIMAGE_EXTRACT_AND_RUN=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file git pkg-config rsync unzip \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev \
      patchelf xdg-utils \
    && rm -rf /var/lib/apt/lists/*
# Node and npm from the official image (its binaries need glibc 2.28, so they run here).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
# A user with the host's ids, so what lands in out/ belongs to you. The group
# may already exist (GID 100 "users", common on Gentoo).
RUN (getent group "$GID" >/dev/null || groupadd -g "$GID" builder) \
 && useradd -m -u "$UID" -g "$GID" -s /bin/bash builder \
 && mkdir /work && chown "$UID:$GID" /work
USER builder
ENV PATH=/home/builder/.cargo/bin:$PATH
# Rust stable as of this image's build; `scripts/container.sh --refresh` updates it.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable \
          --component clippy,rustfmt \
 && mkdir -p /home/builder/.cargo/registry
WORKDIR /work

FROM linux AS android
# The same script that sets up local Android builds (rustup is already there,
# so it only adds the targets, the JDK and the SDK).
COPY --from=scripts --chown=builder android-setup.sh /tmp/android-setup.sh
RUN bash /tmp/android-setup.sh
