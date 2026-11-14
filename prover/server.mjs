// lucax Gatekeeper prover — off-Worker Groth16 proving service (Node.js).
//
// Why this exists: snarkjs CANNOT run in Cloudflare Workers. The Workers
// runtime bans dynamic WebAssembly.compile, and snarkjs/ffjavascript
// compile WASM at first use with no pure-JS fallback (proven live, see
// test/SNARKJS-TEST.md + the /wasmmodule + /snarkjs-precompiled endpoints
// on the test Worker). So proofs are generated HERE, in plain Node, and
// the Worker calls this service over HTTPS inside the 60s task window.
//
// Protocol (POST /prove):
//   request:  { task_id, input: <task envelope input>, decision: "APPROVE"|"REJECT", proof_tx }
//   response: { ok, decision, reason_code, flipped, proof, publicSignals, ms }
//   - The circuit ONLY proves correct decisions (a wrong decision fails
//     witness generation with "Assert Failed", ~100ms). So the prover tries
//     the requested decision first; on assert failure it tries the FLIPPED
//     decision and returns whichever proves. A flipped result means the
//     caller's field checks disagreed with the circuit (the circuit is the
//     referee) — the returned decision + reason_code are authoritative.
//   - If neither decision proves, the inputs are malformed -> ok:false.
//   - Salt is fresh random per call; taskId is SHA-256(task_id) mod p.
//     Both are bound into public signal[0] as a commitment, so a proof
//     cannot be replayed for a different task.
//   - vk hashes are 256-bit; the circuit takes them mod the BN254 prime p.
//
// Auth: requests must carry x-prover-secret matching PROVER_SHARED_SECRET.
// If the env var is unset, only localhost is allowed (local testing).
// No HMAC secret, no Kurier key, no wallet, no funds involved here.
//
// Cost: $0 on Render free tier (512MB, 750h/mo) + a keep-alive ping every
// 10 min (the service sleeps after 15 min idle; cold start ~60s would blow
// the 60s task budget, so the Worker treats a slow prover as "no proof"
// and falls back to the +10 no-proof path). See prover/README.md.

import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import * as snarkjs from "snarkjs";
import { gatekeeperFieldChecks } from "./checks.mjs";

const PORT = Number(process.env.PORT || 3000);
const SHARED_SECRET = process.env.PROVER_SHARED_SECRET || "";
const P = BigInt("0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47");
const WASM_PATH = process.env.GATEKEEPER_WASM || "./gatekeeper.wasm";
const ZKEY_PATH = process.env.GATEKEEPER_ZKEY || "./gatekeeper_final.zkey";

let wasmBuf = null;
let zkeyBuf = null;
let vkey = null;

function loadArtifacts() {
  if (!wasmBuf) wasmBuf = fs.readFileSync(WASM_PATH);
  if (!zkeyBuf) zkeyBuf = fs.readFileSync(ZKEY_PATH);
  return { wasmBuf, zkeyBuf };
}

async function loadVkey() {
  if (!vkey) {
    const { zkeyBuf } = loadArtifacts();
    vkey = await snarkjs.zKey.exportVerificationKey(zkeyBuf);
  }
  return vkey;
}

function modP(hexOrDec) {
  const v = BigInt(hexOrDec);
  return ((v % P) + P) % P;
}

function taskIdToField(taskId) {
  const h = crypto.createHash("sha256").update(String(taskId)).digest();
  return (BigInt("0x" + h.toString("hex")) % P).toString();
}

function randomSalt() {
  return BigInt("0x" + crypto.randomBytes(16).toString("hex")).toString();
}

function buildCircuitInput(taskId, input) {
  const addr = (a) => BigInt(a).toString();
  return {
    registeredVkHash: input.registered_vk ? modP(input.registered_vk).toString() : "0",
    proofVkHash: input.proof_vk ? modP(input.proof_vk).toString() : "0",
    minimum: String(BigInt(input.minimum)),
    publicBalance: String(BigInt(input.public_balance)),
    expiryBlock: String(BigInt(input.expiry_block)),
    currentBlock: String(BigInt(input.current_block)),
    recipient: addr(input.recipient),
    conditionRecipient: addr(input.condition_recipient),
    amount: String(BigInt(input.amount)),
    maxTransfer: String(BigInt(input.max_transfer)),
    taskId: taskIdToField(taskId),
    salt: randomSalt(),
  };
}

function reasonFor(decision, taskId, input, proofTx) {
  if (decision === "APPROVE") return "VALID_CONDITION";
  return gatekeeperFieldChecks(input, proofTx, new Set()) || "UNKNOWN_TRAP";
}

async function proveOnce(circuitInput, decision) {
  const { wasmBuf, zkeyBuf } = loadArtifacts();
  const input = { ...circuitInput, decision: decision === "APPROVE" ? "1" : "0" };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmBuf, zkeyBuf);
  const vk = await loadVkey();
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) throw new Error("local verification of generated proof failed");
  return { proof, publicSignals };
}

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > maxBytes) return reject(new Error("body too large"));
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Tiny in-memory rate limit: 60 requests / minute per IP.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 60;
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      let artifacts = false;
      try {
        loadArtifacts();
        artifacts = true;
      } catch {
        artifacts = false;
      }
      return send(200, { status: "ok", service: "lucax-gatekeeper-prover", version: "0.1.0", artifacts, time: new Date().toISOString() });
    }
    if (req.method !== "POST" || url.pathname !== "/prove") {
      return send(404, { ok: false, error: "not found (POST /prove, GET /health)" });
    }
    const ip = req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) return send(429, { ok: false, error: "rate limited" });

    // Auth: shared secret, or localhost when no secret is configured.
    const secret = req.headers["x-prover-secret"] || "";
    const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (SHARED_SECRET) {
      if (secret !== SHARED_SECRET) return send(401, { ok: false, error: "bad prover secret" });
    } else if (!isLocal) {
      return send(503, { ok: false, error: "prover secret not configured; localhost only" });
    }

    const body = JSON.parse(await readBody(req));
    const { task_id, input, decision, proof_tx } = body || {};
    if (!task_id || !input || (decision !== "APPROVE" && decision !== "REJECT")) {
      return send(400, { ok: false, error: 'need {task_id, input, decision: "APPROVE"|"REJECT"}' });
    }
    const required = ["registered_vk", "proof_vk", "minimum", "public_balance", "expiry_block", "current_block", "recipient", "condition_recipient", "amount", "max_transfer"];
    for (const k of required) {
      if (input[k] === undefined || input[k] === null || input[k] === "") {
        return send(400, { ok: false, error: `missing input field: ${k}` });
      }
    }

    const circuitInput = buildCircuitInput(task_id, input);
    const other = decision === "APPROVE" ? "REJECT" : "APPROVE";
    let result = null;
    let flipped = false;
    try {
      result = await proveOnce(circuitInput, decision);
    } catch (e) {
      if (!String(e.message || e).includes("Assert Failed")) throw e;
      // The circuit says the requested decision is wrong — try the flip.
      // Exactly one of APPROVE/REJECT is provable for well-formed inputs.
      result = await proveOnce(circuitInput, other);
      flipped = true;
    }
    const finalDecision = flipped ? other : decision;
    return send(200, {
      ok: true,
      decision: finalDecision,
      reason_code: reasonFor(finalDecision, task_id, input, proof_tx),
      flipped,
      proof: result.proof,
      publicSignals: result.publicSignals,
      ms: Date.now() - t0,
    });
  } catch (e) {
    return send(500, { ok: false, error: String(e.message || e).slice(0, 300), ms: Date.now() - t0 });
  }
});

server.timeout = 30000;
server.listen(PORT, () => {
  console.log(`lucax gatekeeper prover listening on :${PORT} (artifacts: ${WASM_PATH}, ${ZKEY_PATH})`);
});
