#!/usr/bin/env bash
#
# Publishes the release signing material to GitHub Actions secrets so the
# release workflow can build signed APKs.
#
#   scripts/setup-release-secrets.sh [keystore-path]
#
# The keystore path defaults to android/release.keystore. If it does not
# exist, a new one is generated (keep the printed alias/password: the same key
# must sign every release, otherwise devices refuse to install updates).
set -euo pipefail

cd "$(dirname "$0")/.."

KEYSTORE="${1:-android/release.keystore}"
ALIAS="emaki"

command -v gh >/dev/null || { echo "gh CLI not found" >&2; exit 1; }

if [ ! -f "$KEYSTORE" ]; then
  echo "No keystore at $KEYSTORE - creating one."
  echo "Store the keystore and its password somewhere safe: losing it means"
  echo "no device can ever install an update of this app again."
  read -rsp "Store password (leave empty to generate one): " STORE_PASSWORD
  if [ -z "$STORE_PASSWORD" ]; then
    STORE_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
    echo "Generated store password: $STORE_PASSWORD"
  fi
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -alias "$ALIAS" \
    -keyalg RSA -keysize 4096 -validity 10950 \
    -storepass "$STORE_PASSWORD" \
    -keypass "$STORE_PASSWORD" \
    -dname "CN=Emaki, OU=Emaki, O=Emaki, L=, ST=, C=US"
fi

echo "Reading key details from $KEYSTORE"
read -rsp "Store password: " STORE_PASSWORD
echo
read -rp "Key alias (default: emaki): " KEY_ALIAS
KEY_ALIAS="${KEY_ALIAS:-$ALIAS}"
read -rsp "Key password (press enter if same as store password): " KEY_PASSWORD
echo
KEY_PASSWORD="${KEY_PASSWORD:-$STORE_PASSWORD}"

echo "Setting GitHub secrets on $(gh repo view --json nameWithOwner -q .nameWithOwner)"
gh secret set KEYSTORE_B64 --body "$(base64 -w0 "$KEYSTORE")"
gh secret set KEYSTORE_PASSWORD --body "$STORE_PASSWORD"
gh secret set KEY_ALIAS --body "$KEY_ALIAS"
gh secret set KEY_PASSWORD --body "$KEY_PASSWORD"

echo "Done. Secrets set: KEYSTORE_B64, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD"
