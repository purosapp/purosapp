#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
ROOT_DIR="${SCRIPT_DIR:h}"

export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p)}"
export CC="$(xcrun --find clang)"
export CXX="$(xcrun --find clang++)"
export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"

# Avoid linking the addon against machine-local Homebrew LLVM runtimes.
unset CPPFLAGS
unset CFLAGS
unset CXXFLAGS
unset LDFLAGS
unset LIBRARY_PATH
unset CPATH

# libsoxr (SoX resampler) is linked as a separate LGPL dylib; build/install it first.
node "${ROOT_DIR}/scripts/build-soxr.mjs" --install=build/audio/soxr

NODE_GYP_BIN="${ROOT_DIR}/node_modules/.bin/node-gyp"
if [[ ! -x "${NODE_GYP_BIN}" ]]; then
  NODE_GYP_BIN="node-gyp"
fi

ARCH_ARGS=()
if [[ $# -ge 1 && -n "${1}" ]]; then
  ARCH_ARGS=(--arch "$1")
fi

"${NODE_GYP_BIN}" rebuild --directory "${ROOT_DIR}/native" "${ARCH_ARGS[@]}"
