// lucax Gatekeeper prover — Vercel serverless adapter (Node.js).
//
// Same proving flow as ../standalone/server.mjs (the long-running service):
// POST /api/prove with { task_id, input, decision, proof_tx } returns
// { ok, decision, reason_code, flipped, proof, publicSignals, ms }.
// The circuit ONLY proves correct decisions — a wrong decision fails
// witness generation with "Assert Failed", so on assert failure the
// flipped decision is tried and whichever proves wins (the circuit is
// the referee). Salt is fresh random per call; taskId is SHA-256(task_id)
// mod p, both bound into public signal[0], so a proof cannot be replayed
// for a different task. The proof is verified locally against the real
// vkey before it is returned.
//
// Auth: requests must carry x-prover-secret matching PROVER_SHARED_SECRET.
// No HMAC secret, no Kurier key, no wallet, no funds involved here.
//
// Vercel Hobby limit: 10s per invocation. A proof takes 0.5–2.1s, so it
// fits — but a cold start eats into the budget. The Worker treats a slow
// prover as "no proof" and falls back to the +10 no-proof path, so this
// can never eat a task. Artifacts are downloaded at build time
// (fetch-artifacts.sh) and bundled via vercel.json includeFiles.
// NOTE: this file duplicates the proving core of standalone/server.mjs on purpose
// (minimal change, no refactor of the tested long-running server) —
// keep the circuit-input building and the flip logic in sync.

import fs from "node:fs";
import crypto from "node:crypto";
import * as snarkjs from "snarkjs";
import { gatekeeperFieldChecks } from "../checks.mjs";

const SHARED_SECRET = process.env.PROVER_SHARED_SECRET || "";
const P = BigInt("0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47");
const WASM_PATH = process.env.GATEKEEPER_WASM || new URL("../gatekeeper.wasm", import.meta.url);
const ZKEY_PATH = process.env.GATEKEEPER_ZKEY || new URL("../gatekeeper_final.zkey", import.meta.url);

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

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) return JSON.parse(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

// Tiny in-memory rate limit: 60 requests / minute per IP (best-effort on
// serverless — each instance keeps its own counter).
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 60;
}

export default async function handler(req, res) {
  const t0 = Date.now();
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method !== "POST") return send(405, { ok: false, error: "POST only" });

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    if (rateLimited(ip)) return send(429, { ok: false, error: "rate limited" });

    const secret = req.headers["x-prover-secret"] || "";
    if (SHARED_SECRET) {
      if (secret !== SHARED_SECRET) return send(401, { ok: false, error: "bad prover secret" });
    } else {
      return send(503, { ok: false, error: "prover secret not configured" });
    }

    const body = await readJsonBody(req);
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
}
