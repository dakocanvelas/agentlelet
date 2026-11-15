# snarkjs Groth16 in Cloudflare Workers — TEST RESULT: FAIL

**Date:** 15 Nov 2026 ~00:35 WIB (14 Nov 17:35 UTC)
**Question:** Can snarkjs generate a Groth16 proof inside a Cloudflare Worker?
**Verdict: NO — FAIL.** The Workers runtime disallows dynamic WebAssembly
compilation, and snarkjs compiles WASM at runtime. This is a platform-level
restriction, not a bug in our code and not a tier/quota issue.

## Evidence (live, reproducible)

Test worker: `test/worker-test/` — deployed live at
https://lucax-snarkjs-test.quasar-allspice.workers.dev

- `GET /test` (run twice, same result):
  - `import_snarkjs: ok` — snarkjs loads (after a `URL.createObjectURL` stub;
    see obstacle 1 below).
  - `fetch_artifacts: ok` — gatekeeper.wasm 1,755,820 bytes + gatekeeper_final.zkey
    309,750 bytes fetched from agentgames.zkverify.io in 249 ms.
  - `zkey_parse: FAIL` — `WebAssembly.compile(): Wasm code generation disallowed by embedder`
  - `fullProve: FAIL` — same error.
- `GET /wasmcheck` (isolated minimal probe — compiles an empty 8-byte WASM module):
  - `wasm_compile_from_bytes: DISALLOWED` — same error. This proves the cause
    is the runtime policy, not snarkjs, not the circuit, not the artifacts.

## Why it fails (two independent blockers)

1. **Dynamic WASM compilation is disallowed.** `WebAssembly.compile()` /
   `WebAssembly.instantiate()` from fetched bytes throw
   "Wasm code generation disallowed by embedder". snarkjs needs this in two
   places: ffjavascript's curve arithmetic (its own embedded WASM, compiled at
   `buildThreadManager` time) and the circom witness calculator (the circuit
   WASM). Workers only allow WASM that is bundled at deploy time via
   `import ... from "./x.wasm"`. Even that would not save snarkjs, because
   ffjavascript's WASM is embedded inside the npm package, not importable as
   a Worker module — fixing it would mean forking ffjavascript/snarkjs.
2. **(Worked around) `URL.createObjectURL` is not implemented in workerd.**
   ffjavascript's thread manager calls it at import time (browser build).
   Stubbed with `URL.createObjectURL = () => "data:,"` before the dynamic
   `import("snarkjs")`. The stub value is never used: `buildThreadManager`
   forces `singleThread=true` when `globalThis.Worker` is absent (true in
   workerd), so no sub-worker is ever spawned. Import then succeeds.

## Circuit input discovery (bonus finding, Node-side)

While testing, the real gatekeeper circuit was probed with snarkjs in Node
(`test/probe*.mjs`, `test/fullprove*.mjs`). The circuit has **13 inputs**
(`getInputSize() = 13`, vkey `nPublic = 13`, Groth16/BN128, zkey 309,750 B).
11 input names were found by testing candidate names against the WASM's
hash-based signal lookup (wrong names → "Too many values", right names →
"Not all inputs have been set"):

`decision, taskId, minimum, recipient, amount, publicBalance, expiryBlock,
currentBlock, conditionRecipient, maxTransfer, salt`

**2 input names remain unknown** after ~270 probed candidates. They are
needed by ANY prover (on Workers or elsewhere). Most likely source: the
starter prompt on the build page (`/build`), which scaffolds proof
generation — fetch it via the browser and read the input list from there.

Note: `secret` and `password` looked like inputs in early probes — that was
a redaction artifact in tool output, not a real result. Direct aliased
re-tests confirmed both are NOT inputs.

## What this means for Gatekeeper

- The agent endpoint (`src/index.js`) still answers Gatekeeper tasks with
  the 7 deterministic field checks (correct per the published trap
  encyclopedia) and the platform response shape. A correct decision without
  our Groth16 proof scores +12 − 2 = **+10** (missing-proof penalty) and no
  reliability bonus (up to +5) — still positive per task if decisions are
  right. That is the viable fallback, already implemented.
- To attach real proofs, the prover must run OFF Workers: a Node.js service
  somewhere `WebAssembly.compile` is allowed (any VPS / always-on free host),
  with the endpoint calling it or the prover being the endpoint itself.
  That is a hosting decision, not a code problem — and it needs the 2 missing
  input names first.
- The Kurier on-chain proof check (confirm the task's `proof_tx` is on-chain)
  is a separate, still-open item: it needs the user's Kurier key and does not
  depend on snarkjs.

## Files

- `test/worker-test/` — the live test Worker (deployed, see URL above).
- `test/inspect.mjs`, `test/probe.mjs`, `test/probe2.mjs`, `test/probe3.mjs`,
  `test/probe4.mjs`, `test/probe7.mjs` — input-name discovery probes.
- `test/fullprove.mjs`, `test/fullprove2.mjs` — proof attempts (blocked on the
  2 unknown inputs).
- `test/gatekeeper.wasm`, `test/gatekeeper_final.zkey` — real artifacts
  (downloaded from agentgames.zkverify.io; NOT committed to git — see
  `.gitignore`).
- `test/gatekeeper.vkey.json` — exported verification key (groth16/bn128,
  nPublic 13).

---

# RESOLUTION — 15 Nov 2026 ~01:20 WIB: all 13 inputs found, Node prover works

## How the 2 missing input names were found

The starter prompt on `/build` does NOT list circuit input names, and the
circuit source is not public on GitHub. The names were recovered from the
WASM itself:

1. `test/parse_wasm.py` parses the WASM data section. Segment 18 (memoff
   2032, 4096 bytes) is the signal table: each entry is an FNV-1a 64-bit
   hash of a signal name followed by its signal index. All 11 known names
   matched their hashes there — and exactly **2 hashes had no name**:
   `0x14418c3ee75f7a4e` (signal 2) and `0x3b2514e2617cb386` (signal 3).
2. `test/find_inputs.py` dictionary-attacked those two hashes (38,683
   candidates: domain words, camel/snake/Pascal pairs, Hi/Lo, `[0]`/`[1]`,
   envelope field names). Both hit on the first run:
   - signal 2 = **`registeredVkHash`**
   - signal 3 = **`proofVkHash`**
3. Verified against the real WASM with the probe method
   (`test/verify_names.mjs` — both return "Not all inputs have been set",
   i.e. accepted as real inputs).

So the circuit takes the two verification-key hashes and checks them
equal — the VK_SUBSTITUTION trap lives inside the circuit, not just in
our field checks. vk hashes are 256-bit; the circuit takes them mod the
BN254 field prime p (the raw hash `0x6b79…` exceeds p).

## Node prover — WORKS (`test/fullprove3.mjs`, 15 cases)

All 13 inputs, real artifacts, Node 24:

| case | result |
|---|---|
| valid + APPROVE | PROOF OK, **verify=true** (~2.1s first, then 0.5–0.8s) |
| valid + REJECT | witness assert FAIL (~66ms) — circuit only proves correct decisions |
| threshold / recipient / expired / overflow trap + APPROVE | assert FAIL |
| any trap + REJECT | PROOF OK, verify=true |
| VK mismatch + APPROVE | assert FAIL; + REJECT | PROOF OK |
| balance==minimum + APPROVE | PROOF OK (>=) |
| amount==max + APPROVE | PROOF OK (<=) |
| **current==expiry + APPROVE** | **assert FAIL — expiry is STRICT (`current < expiry`)** |

Public signals (13): `[commitment(taskId,salt), registeredVkHash, proofVkHash,
minimum, publicBalance, expiryBlock, currentBlock, recipient,
conditionRecipient, amount, maxTransfer, decision, taskIdHash]` where
`taskIdHash = SHA-256(taskId) mod p` (verified: signal[12] matches the
computed value) and signal[0] is a commitment binding taskId+salt (changes
when either changes — `test/sig0_test.mjs`). The platform can check
signal[12] directly against the task_id it sent; the salt is our fresh
random per task (anti-replay binding).

**Boundary bug found + fixed:** the Worker's field check used
`current > expiry` for EXPIRED_CONDITION, i.e. it APPROVEd at
current==expiry — the circuit refuses to prove that. Fixed to `>=` in
`src/index.js` and in `prover/checks.mjs`. Without the fix, an
expiry-boundary task would have scored an incorrect APPROVE (−6) instead
of a correct REJECT (+12).

## Task 3(a) — pre-compiled WASM in a Worker: PROVEN LIVE, still dead

Two new endpoints on the test Worker
(https://lucax-snarkjs-test.quasar-allspice.workers.dev):

- `GET /wasmmodule` — the real gatekeeper.wasm imported as a deploy-time
  module, instantiated with the 4 runtime stubs: **INSTANTIATED,
  getInputSize()=13, getVersion()=2.** Deploy-time WASM modules DO work.
- `GET /snarkjs-precompiled` — fullProve with all 13 inputs: still
  **FAIL in 87ms, `WebAssembly.compile(): Wasm code generation disallowed
  by embedder`, verdict `FFJAVASCRIPT_BLOCKER_CONFIRMED`.**

And in Node, with `WebAssembly.compile` banned after import
(`test/no_wasm_test2.mjs`): fullProve FAILS in 67ms — **no pure-JS
fallback exists** in snarkjs/ffjavascript (`ffjavascript/src/threadman.js`,
`wasmcurves/src/f1.js` both call `WebAssembly.compile` at first use).
Conclusion: (a) is dead without forking ffjavascript/wasmcurves. The
circuit WASM was never the blocker; ffjavascript's own curve WASM is.

## Task 3 — the built solution: external Node prover (`prover/`)

- `prover/standalone/server.mjs` — zero-dep Node HTTP service: `POST /prove`,
  `GET /health`. Prove-or-flip: tries the requested decision; on witness
  assert failure tries the flipped decision and returns whichever proves
  (a flip means the caller's field checks disagreed with the circuit).
  Shared-secret auth (`x-prover-secret`), 60 req/min/IP rate limit.
- Tested live: valid APPROVE 1,377ms; 4 flip cases (threshold, expiry
  boundary, VK mismatch, valid+REJECT) all correct in 412–479ms; a
  prover-returned proof independently verified `true` against the real
  vkey. Worker↔prover integration tested locally via `wrangler dev`:
  valid→APPROVE+proof (1,314ms), trap→REJECT+proof, expiry boundary→
  REJECT/EXPIRED_CONDITION+proof, idempotent replay returns the identical
  proof in 32ms.
- **Hosting (free only):** Render free tier is the recommendation
  (512MB, 750h/mo, no card) + a keep-alive ping every 10 min (sleeps
  after 15 min idle; cold start ~60s would blow the 60s task budget —
  the Worker caps the prover call at 25s and falls back to the no-proof
  +10 path). Fly.io has NO free tier for new orgs (only a $1/7-day
  trial; cheapest always-on ~$2.19/mo, bills under $5 waived, but a card
  is required) — not free-forever. Vercel Hobby (10s function limit) is
  a viable free alternative with less headroom. See `prover/README.md`.
- **Not yet deployed.** Deploying needs the user's GitHub push (repo not
  pushed) + a Render account (user registers) + `PROVER_URL` /
  `PROVER_SHARED_SECRET` on the Worker. The live Worker still returns
  decisions WITHOUT proofs until then (the +10 path).
- **Still open (separate step):** submitting the proof to zkVerify via
  Kurier for a `proof_tx` (needs the user's Kurier API key). The Worker
  currently returns the proof + `public_signals` for the platform to
  re-verify, and echoes the task's incoming `proof_tx`.
