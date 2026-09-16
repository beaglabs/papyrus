#!/usr/bin/env bash
# Provision the Python environment Papyrus agents use for document work.
#
# The interpreter on the host has no document libraries: no PDF reader, no PDF writer, no image
# decoder. Without them an agent asked to work on a PDF writes its own parser and spends its
# entire step budget debugging that instead of producing the deliverable.
#
# This is a provisioning step, not a runtime dependency. Run it once per appliance; the daemon
# finds the environment automatically at <data-dir>/python and grants the sandbox read-only access
# to it. Nothing here runs with network access at agent time, and the sandbox still blocks
# outbound network for every workspace command.
#
# Usage: scripts/provision-python.sh [data-dir] [wheelhouse]
#        (default data-dir: $PAPYRUS_DATA_DIR)
#
# Pass a wheelhouse directory to install offline from vendored wheels. The image
# build always does: an appliance build must not reach the network, and a
# disconnected deployment has nothing to reach.
set -euo pipefail

data_dir="${1:-${PAPYRUS_DATA_DIR:-}}"
wheelhouse="${2:-}"
if [[ -z "$data_dir" ]]; then
  echo "usage: scripts/provision-python.sh <data-dir> [wheelhouse]   (or set PAPYRUS_DATA_DIR)" >&2
  exit 2
fi

pip_args=(--quiet --disable-pip-version-check)
if [[ -n "$wheelhouse" ]]; then
  if [[ ! -d "$wheelhouse" ]]; then
    echo "wheelhouse not found: $wheelhouse" >&2
    exit 2
  fi
  # --no-index makes the offline intent explicit: a missing wheel fails the build
  # rather than silently reaching out to a package index.
  pip_args+=(--no-index --find-links "$wheelhouse")
  echo "installing from wheelhouse $wheelhouse (no network)"
fi

python="${PAPYRUS_PYTHON_BIN:-python3}"
target="$data_dir/python"

if [[ ! -x "$target/bin/python3" ]]; then
  echo "creating Python environment at $target"
  "$python" -m venv "$target"
fi

echo "installing document libraries"
if [[ -z "$wheelhouse" ]]; then
  "$target/bin/pip" install "${pip_args[@]}" --upgrade pip
fi
"$target/bin/pip" install "${pip_args[@]}" \
  pypdf \
  reportlab \
  pillow

"$target/bin/python3" - <<'PY'
import pypdf, reportlab, PIL
print(f"pypdf {pypdf.__version__} | reportlab {reportlab.Version} | pillow {PIL.__version__}")
PY
echo "done: $target"
