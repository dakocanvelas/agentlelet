#!/usr/bin/env bash
# Download the real Gatekeeper circuit artifacts from the official site
# and verify size + sha256. Run: npm run fetch-artifacts (or bash fetch-artifacts.sh)
set -euo pipefail
cd "$(dirname "$0")"

WASM_URL="https://agentgames.zkverify.io/circuits/gatekeeper.wasm"
ZKEY_URL="https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey"
# Pinned 15 Nov 2026 (verified against the live site). If the platform ever
# rotates the circuit, these hashes change — update them from /api/circuit-info.
WASM_SHA="be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f"
ZKEY_SHA="adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d"
WASM_SIZE=1755820
ZKEY_SIZE=309750

curl -fsSL -o gatekeeper.wasm "$WASM_URL"
curl -fsSL -o gatekeeper_final.zkey "$ZKEY_URL"

check() {
  local file="$1" want_sha="$2" want_size="$3"
  local got_size got_sha
  got_size=$(stat -c%s "$file")
  got_sha=$(sha256sum "$file" | cut -d' ' -f1)
  if [ "$got_size" != "$want_size" ]; then echo "SIZE MISMATCH $file: got $got_size want $want_size" >&2; exit 1; fi
  if [ "$got_sha" != "$want_sha" ]; then echo "SHA MISMATCH $file: got $got_sha want $want_sha" >&2; exit 1; fi
  echo "OK $file ($got_size bytes, sha256 $got_sha)"
}
check gatekeeper.wasm "$WASM_SHA" "$WASM_SIZE"
check gatekeeper_final.zkey "$ZKEY_SHA" "$ZKEY_SIZE"
echo "Artifacts verified."
