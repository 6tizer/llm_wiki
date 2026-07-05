#!/usr/bin/env bash
# Local macOS development signing helper for LLM Wiki.
#
# HANDOFF root cause: macOS keychain ACLs are tied to the code signature.
# Ad-hoc signatures change across rebuilds, so OS-keychain-backed profile
# secrets can trigger repeated per-secret permission prompts after reinstall.
# SPEC-13 K1 moves the default secret store to an app-private file; this
# helper is a separate fallback for developers who still choose keychain mode.
#
# This script does not edit tauri.conf.json or tauri.macos.conf.json. Tauri can
# consume the local identity through APPLE_SIGNING_IDENTITY when desired.

set -euo pipefail

IDENTITY_NAME="LLM Wiki Local Dev"
WORK_DIR="${TMPDIR:-/tmp}/llm-wiki-local-signing"
KEY_PATH="$WORK_DIR/local-dev.key"
CSR_PATH="$WORK_DIR/local-dev.csr"
CERT_PATH="$WORK_DIR/local-dev.crt"
P12_PATH="$WORK_DIR/local-dev.p12"
EXT_PATH="$WORK_DIR/local-dev.ext"

if security find-identity -v -p codesigning | grep -Fq "\"$IDENTITY_NAME\""; then
  cat <<EOF
Found existing code signing identity: $IDENTITY_NAME

Use it for local Tauri builds with:

  export APPLE_SIGNING_IDENTITY="$IDENTITY_NAME"
EOF
  exit 0
fi

mkdir -p "$WORK_DIR"
cat >"$EXT_PATH" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF

openssl genrsa -out "$KEY_PATH" 2048
openssl req -new -key "$KEY_PATH" -out "$CSR_PATH" -subj "/CN=$IDENTITY_NAME"
openssl x509 -req -days 3650 -in "$CSR_PATH" -signkey "$KEY_PATH" -out "$CERT_PATH" -extfile "$EXT_PATH"

cat <<EOF
Created a local code-signing certificate:

  $CERT_PATH

Next steps:

  1. Create a password-protected p12:

       openssl pkcs12 -export -inkey "$KEY_PATH" -in "$CERT_PATH" -name "$IDENTITY_NAME" -out "$P12_PATH"

  2. Import it into your login keychain:

       security import "$P12_PATH" -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign

  3. Confirm the identity exists:

       security find-identity -v -p codesigning | grep "$IDENTITY_NAME"

  4. Use it for local Tauri builds:

       export APPLE_SIGNING_IDENTITY="$IDENTITY_NAME"

The generated files stay in:

  $WORK_DIR
EOF
