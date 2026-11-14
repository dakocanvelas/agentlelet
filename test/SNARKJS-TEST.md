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
