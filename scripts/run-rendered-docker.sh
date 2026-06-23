#!/usr/bin/env bash
# Run the rendered-client E2E entirely OFF-SCREEN inside the Dockerfile.rendered image
# (Xvfb + Mesa software GL). Nothing renders on your host desktop — no window, no mouse
# grab, and it can't be accidentally clicked or closed. Ideal on Windows/macOS where a
# native Minecraft window would otherwise grab the foreground.
#
# Safety: the repo is bind-mounted at /work, but every `node_modules` dir is shadowed by an
# anonymous volume, so the container's `npm ci` (which installs LINUX binaries + recreates the
# workspace symlinks) NEVER touches your host node_modules. The host ~/.mc-test cache is reused
# (platform-independent MC client jar/libs/assets are shared; Linux natives land in their own OS
# subdir, so nothing conflicts).
#
# The container runs `npm ci && npm run build` (JS only) — it does NOT build the Java agent/SUT-mod jars.
# Build those on the HOST first (Loom/ForgeGradle/NeoGradle: client-<loader> agents + the mod-<loader> SUTs
# + server-bukkit + the regions plugin); they are bind-mounted in via /work and ~/.mc-test.
#
# Prereqs (one-time):
#   docker build -f Dockerfile.rendered -t mc-test/rendered:21 .
# Run:
#   bash scripts/run-rendered-docker.sh                       # default: Fabric harness, --flake=1
#   bash scripts/run-rendered-docker.sh --flake=3             # pass-through harness args
#   # ALL THREE rendered client loaders (fabric/forge/neoforge) in one report:
#   MC_TEST_RENDERED_HARNESS=tests/e2e/run-rendered-loaders.mjs bash scripts/run-rendered-docker.sh
set -euo pipefail

# Git Bash / MSYS on Windows rewrites POSIX paths (e.g. the container-side `/work`) when passing args
# to the native docker.exe. Disable that so the in-container mount targets are left intact.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${MC_TEST_RENDERED_IMAGE:-mc-test/rendered:21}"
# Which rendered harness to run inside the container (default: the Fabric-only F3 guardrail). The
# multi-loader harness (run-rendered-loaders.mjs) boots fabric + forge + neoforge rendered clients.
HARNESS="${MC_TEST_RENDERED_HARNESS:-tests/e2e/run-rendered-boot.mjs}"
ARGS="${*:---flake=1}"

exec docker run --rm \
  -e "MC_TEST_RENDERED_LOADERS=${MC_TEST_RENDERED_LOADERS:-forge,neoforge}" \
  -v "$REPO":/work \
  -v "$HOME/.mc-test":/root/.mc-test \
  -v /work/node_modules \
  -v /work/packages/protocol/node_modules \
  -v /work/packages/runner/node_modules \
  -v /work/packages/driver-headless/node_modules \
  -v /work/packages/driver-inprocess/node_modules \
  -v /work/packages/driver-pixel/node_modules \
  -w /work \
  "$IMAGE" \
  bash -lc "npm ci --no-audit --no-fund && npm run build && xvfb-run -a node ${HARNESS} ${ARGS}"
