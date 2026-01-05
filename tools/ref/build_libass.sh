#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIBASS_DIR="${ROOT}/refs/libass"

if [ ! -d "${LIBASS_DIR}" ]; then
  echo "refs/libass not found. Run: git submodule update --init --recursive"
  exit 1
fi

cd "${LIBASS_DIR}"

if [ ! -f "configure" ]; then
  if [ -x "./autogen.sh" ]; then
    ./autogen.sh
  else
    echo "autogen.sh not found. Ensure libass submodule is initialized."
    exit 1
  fi
fi

./configure --disable-static
make -j"$(sysctl -n hw.ncpu)"

echo "libass built in ${LIBASS_DIR}"
