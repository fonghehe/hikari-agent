#!/usr/bin/env bash
set -euo pipefail

# Playwright starts the application with --no-sandbox, but the application's
# disposable browser starts Electron normally and needs Chromium's sandbox.
# Allow user namespaces only for the unpacked executable on this CI runner.
if [ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  executable=$(realpath .artifacts/releases/desktop/linux-unpacked/hikari)
  sudo apparmor_parser -r <<EOF
abi <abi/4.0>,
include <tunables/global>

profile hikari-ci-desktop "$executable" flags=(unconfined) {
  userns,
}
EOF
fi
