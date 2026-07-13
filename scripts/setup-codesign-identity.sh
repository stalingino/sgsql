#!/usr/bin/env bash
# Creates a stable, self-signed code-signing certificate for local macOS builds
# and imports it into the login keychain.
#
# Why: ad-hoc signing ("-") hashes the binary itself, so the signature changes
# on every build. macOS Keychain ACLs are bound to that signature, so each
# rebuild looks like a different, untrusted app and re-prompts for every
# stored credential. A self-signed identity stays constant across builds
# (same CN, same key), so the ACL keeps matching and the prompts stop.
#
# This does NOT make Gatekeeper trust the app on other machines — that still
# requires a paid Apple Developer ID certificate + notarization. It only
# fixes local Keychain access-control stability.
#
# Run this yourself in a terminal (not via an automated agent) since `security
# import` may show a GUI keychain prompt.
set -euo pipefail

IDENTITY_NAME="SGSql Developer"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

if security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$IDENTITY_NAME"; then
  echo "Identity '$IDENTITY_NAME' already exists in $KEYCHAIN — nothing to do."
  security find-identity -v -p codesigning "$KEYCHAIN" | grep "$IDENTITY_NAME"
  exit 0
fi

echo "Generating self-signed code-signing certificate: $IDENTITY_NAME"
# keyUsage=digitalSignature is required in addition to extendedKeyUsage=codeSigning —
# without it, codesign rejects the identity with "Invalid Key Usage for policy"
# even though `security import` accepts it fine.
openssl req -x509 -newkey rsa:2048 \
  -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" \
  -days 7300 -nodes -subj "/CN=${IDENTITY_NAME}" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:true"

P12_PASS=$(openssl rand -base64 24)
# -legacy: OpenSSL 3.x defaults to AES/SHA-256 for PKCS#12, which macOS's
# Security framework fails to import ("MAC verification failed"). The legacy
# RC2/3DES+SHA1 encoding is what SecKeychainItemImport expects.
openssl pkcs12 -export -out "$WORKDIR/cert.p12" -legacy \
  -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
  -passout "pass:${P12_PASS}"

echo "Importing into $KEYCHAIN ..."
security import "$WORKDIR/cert.p12" -k "$KEYCHAIN" \
  -P "$P12_PASS" -T /usr/bin/codesign -T /usr/bin/security

# A self-signed cert isn't in Apple's trust chain, so codesign refuses to use
# it ("no identity found") until it's explicitly trusted for code signing.
# User-domain trust (no -d) applies only to this login keychain and doesn't
# require an admin authorization dialog.
echo "Trusting identity for code signing..."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORKDIR/cert.pem"

echo
echo "Done. Verify with:"
echo "  security find-identity -v -p codesigning"
echo
echo "You should see '$IDENTITY_NAME' in the list."
echo
echo "To sign CI builds with this exact same identity later, export it once with:"
echo "  security export -k \"$KEYCHAIN\" -t identities -f pkcs12 -o sgsql-codesign.p12"
echo "then base64 it and store as a GitHub Actions secret (see .github/workflows/release.yml)."
echo "Keep sgsql-codesign.p12 somewhere safe and out of git — it is your signing identity."
