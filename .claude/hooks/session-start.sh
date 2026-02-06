#!/bin/bash
set -euo pipefail

# Only run in remote (web) environment
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install gh CLI if not already installed
if ! command -v gh &> /dev/null; then
  echo "Installing GitHub CLI..." >&2
  GH_VERSION="2.86.0"
  ARCH=$(dpkg --print-architecture)
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.deb" -o /tmp/gh.deb
  dpkg -i /tmp/gh.deb > /dev/null 2>&1
  rm -f /tmp/gh.deb
  echo "GitHub CLI installed successfully." >&2
else
  echo "GitHub CLI already installed." >&2
fi
