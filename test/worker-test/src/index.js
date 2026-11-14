// snarkjs-in-Worker test for lucax / Agent Games Gatekeeper.
// Purpose: answer ONE question — can snarkjs Groth16 proof generation run
// inside a Cloudflare Worker (workerd)?
//
// Known obstacle, found by this test: ffjavascript's thread manager calls
// URL.createObjectURL() at import time (browser build), which workerd does
// NOT implement. Workaround below: stub it before the dynamic import.
// The stub value is never used, because buildThreadManager forces
// singleThread=true when globalThis.Worker is absent (true in workerd),
// so no sub-worker is ever spawned. If this stub ever stops working,
// that is itself the FAIL result for Gatekeeper-on-Workers.
if (typeof URL.createObjectURL !== "function") {
  try { URL.createObjectURL = () => "data:,"; } catch { /* cannot stub */ }
} else {
  // In workerd, URL.createObjectURL EXISTS but throws "not implemented"
  // when called. Probe it; if it throws, replace it with a stub.
  try {
    URL.createObjectURL(new Blob(["x"]));
  } catch {
    try { URL.createObjectURL = () => "data:,"; } catch { /* cannot stub */ }
  }
}

// Deploy-time WASM module import: compiled by Cloudflare at deploy time,
// NOT at runtime. If this instantiates, the "pre-compiled WASM" mechanism
// works in Workers — and any remaining snarkjs failure is ffjavascript's
// own runtime WASM compile, not the circuit WASM.
import gkWasmModule from "./gatekeeper.wasm";

const WASM_URL = "https://agentgames.zkverify.io/circuits/gatekeeper.wasm";
const ZKEY_URL = "https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey";

// All 13 circuit inputs — the 2 missing names (registeredVkHash, proofVkHash)
// were recovered 15 Nov 2026 by extracting the FNV-1a signal hashes from the
// WASM data section and dictionary-attacking them (see ../SNARKJS-TEST.md).
// vk hashes are 256-bit; the circuit takes them mod the BN254 field prime.
const VK_HASH_MOD_P = "4836144126773920907502496244340012141465762957689769435993496290439317388578";
const INPUT_13 = {
  registeredVkHash: VK_HASH_MOD_P,
  proofVkHash: VK_HASH_MOD_P,
  minimum: "1000",
  publicBalance: "1460",
  expiryBlock: "19842201",
  currentBlock: "19832000",
  recipient: BigInt("0xDe42000000000000000000000000000000009f01").toString(),
  conditionRecipient: BigInt("0xDe42000000000000000000000000000000009f01").toString(),
  amount: "500",
  maxTransfer: "1000",
  taskId: "1",
  salt: "12345",
  decision: "1",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

let snarkjsPromise = null;
function loadSnarkjs() {
  if (!snarkjsPromise) snarkjsPromise = import("snarkjs");
  return snarkjsPromise;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/wasmcheck") {
      // Minimal isolated probe: can this runtime compile WASM from bytes at all?
      // 00 61 73 6d 01 00 00 00 = empty valid module.
      try {
        const mod = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        return json({ wasm_compile_from_bytes: "ALLOWED", module: String(!!mod) });
      } catch (e) {
        return json({ wasm_compile_from_bytes: "DISALLOWED", error: String(e.message || e).slice(0, 300) });
      }
    }

    if (url.pathname === "/wasmmodule") {
      // Task 3(a): does a deploy-time-compiled WASM module instantiate in a Worker?
      const t0 = Date.now();
      try {
        const memory = new WebAssembly.Memory({ initial: 1024 });
        const instance = await WebAssembly.instantiate(gkWasmModule, {
          env: { memory },
          runtime: {
            exceptionHandler: () => {},
            printErrorMessage: () => {},
            writeBufferMessage: () => {},
            showSharedRWMemory: () => {},
          },
        });
        const inputSize = instance.exports.getInputSize();
        const version = instance.exports.getVersion ? instance.exports.getVersion() : null;
        return json({
          precompiled_wasm_module: "INSTANTIATED",
          getInputSize: inputSize,
          getVersion: version,
          expected_input_size: 13,
          match: inputSize === 13,
          ms: Date.now() - t0,
          conclusion:
            "Deploy-time WASM modules DO work in Workers. The circuit WASM is NOT the blocker.",
        });
      } catch (e) {
        return json(
          {
            precompiled_wasm_module: "FAILED",
            error: String(e.message || e).slice(0, 300),
            ms: Date.now() - t0,
          },
          500,
        );
      }
    }

    if (url.pathname === "/snarkjs-precompiled") {
      // Same question, one level up: with all 13 inputs known AND the circuit
      // WASM proven instantiable as a pre-compiled module, can snarkjs prove?
      // Expected: NO — ffjavascript compiles its OWN curve WASM at first use.
      const t0 = Date.now();
      const steps = {};
      try {
        const snarkjs = await loadSnarkjs();
        steps.import_snarkjs = { ok: true };
        const zkeyRes = await fetch(ZKEY_URL);
        const zkeyBytes = new Uint8Array(await zkeyRes.arrayBuffer());
        steps.fetch_zkey = { ok: zkeyRes.ok, bytes: zkeyBytes.length };
        // NOTE: snarkjs's API takes wasm bytes/path, not a pre-compiled
        // instance — it compiles the circuit WASM itself. That is exactly
        // the point: even the circuit-WASM side goes through runtime compile.
        const t1 = Date.now();
        try {
          const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            INPUT_13,
            new Uint8Array(await (await fetch(WASM_URL)).arrayBuffer()),
            zkeyBytes,
          );
          steps.fullProve = { ok: true, unexpected: "proof generated in Worker", publicSignals, ms: Date.now() - t1 };
          steps.verdict = "UNEXPECTED_SUCCESS";
        } catch (e) {
          const msg = String(e.message || e);
          steps.fullProve = { ok: false, error: msg.slice(0, 300), ms: Date.now() - t1 };
          steps.verdict = msg.includes("disallowed by embedder")
            ? "FFJAVASCRIPT_BLOCKER_CONFIRMED"
            : "FAIL_OTHER";
        }
        steps.total_ms = Date.now() - t0;
        return json(steps);
      } catch (e) {
        steps.fatal = { error: String(e.message || e).slice(0, 300) };
        steps.verdict = "FAIL";
        return json(steps, 500);
      }
    }

    if (url.pathname !== "/test") {
      return json({
        test: "snarkjs-in-worker",
        run: "GET /test",
        also: ["GET /wasmcheck", "GET /wasmmodule", "GET /snarkjs-precompiled"],
        note: "Fetches the real gatekeeper wasm+zkey and runs snarkjs in this Worker.",
      });
    }

    const steps = {};
    const t0 = Date.now();
    try {
      // Step 0: import snarkjs (after the createObjectURL stub above)
      const tImp = Date.now();
      let snarkjs;
      try {
        snarkjs = await loadSnarkjs();
        steps.import_snarkjs = { ok: true, ms: Date.now() - tImp };
      } catch (e) {
        steps.import_snarkjs = { ok: false, error: String(e.message || e).slice(0, 300), ms: Date.now() - tImp };
        steps.verdict = "FAIL";
        steps.total_ms = Date.now() - t0;
        return json(steps, 500);
      }

      // Step 1: fetch artifacts
      const t1 = Date.now();
      const [wasmRes, zkeyRes] = await Promise.all([fetch(WASM_URL), fetch(ZKEY_URL)]);
      const wasmBytes = new Uint8Array(await wasmRes.arrayBuffer());
      const zkeyBytes = new Uint8Array(await zkeyRes.arrayBuffer());
      steps.fetch_artifacts = {
        ok: wasmRes.ok && zkeyRes.ok,
        wasm_bytes: wasmBytes.length,
        zkey_bytes: zkeyBytes.length,
        ms: Date.now() - t1,
      };

      // Step 2: parse the zkey (export verification key)
      const t2 = Date.now();
      try {
        const vkey = await snarkjs.zKey.exportVerificationKey(zkeyBytes);
        steps.zkey_parse = { ok: true, protocol: vkey.protocol, curve: vkey.curve, nPublic: vkey.nPublic, ms: Date.now() - t2 };
      } catch (e) {
        steps.zkey_parse = { ok: false, error: String(e.message || e).slice(0, 300), ms: Date.now() - t2 };
      }

      // Step 3: witness calculation via fullProve with all 13 inputs (now known).
      // Expected: FAIL with "Wasm code generation disallowed by embedder"
      // (ffjavascript's own WASM compile), NOT "Not all inputs".
      const t3 = Date.now();
      try {
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(INPUT_13, wasmBytes, zkeyBytes);
        steps.fullProve = { ok: true, unexpected: "proof generated with 13 inputs", publicSignals, ms: Date.now() - t3 };
      } catch (e) {
        const msg = String(e.message || e);
        steps.fullProve = {
          ok: false,
          error: msg.slice(0, 300),
          means_wasm_ran: msg.includes("Not all inputs"),
          means_ffjavascript_blocked: msg.includes("disallowed by embedder"),
          ms: Date.now() - t3,
        };
      }

      steps.total_ms = Date.now() - t0;
      steps.verdict =
        steps.import_snarkjs.ok && steps.fetch_artifacts.ok && steps.fullProve.means_ffjavascript_blocked
          ? "FAIL_FFJAVASCRIPT_BLOCKER"
          : "FAIL";
      return json(steps);
    } catch (e) {
      steps.fatal = { error: String(e.message || e).slice(0, 500), ms: Date.now() - t0 };
      steps.verdict = "FAIL";
      return json(steps, 500);
    }
  },
};
