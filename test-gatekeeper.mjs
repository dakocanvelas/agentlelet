// Offline audit harness for the Gatekeeper decision logic in
// ~/workspace/garapan/agent-games/lucax/src/index.js
// Extracts gatekeeperFieldChecks + its module state from the REAL source file
// (no copy-paste) and runs every trap variety + boundary + abuse cases.
// Usage: node test-gatekeeper.mjs
import { readFileSync } from "node:fs";
import agent from "./src/index.js";

const SRC = "/home/hatch/workspace/garapan/agent-games/lucax/src/index.js";
const src = readFileSync(SRC, "utf8");

// Pull the real function + its state declarations out of the source.
function extract(re, name) {
  const m = src.match(re);
  if (!m) throw new Error("could not extract " + name);
  return m[0];
}
const stateCode = extract(/const seenTasks = new Map\(\);[\s\S]*?const seenProofTx = new Set\(\);/, "state");
const helperCode = extract(/function toBigInt\(v\) \{[\s\S]*?\n\}/, "toBigInt");
const fnCode = extract(/function gatekeeperFieldChecks\(input, proofTx\) \{[\s\S]*?\n\}/, "gatekeeperFieldChecks");
const factory = new Function(
  stateCode + "\n" + helperCode + "\n" + fnCode + "\nreturn { gatekeeperFieldChecks, seenProofTx, seenTasks };",
);
const { gatekeeperFieldChecks, seenProofTx } = factory();

const VK = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const ADDR = "0xabcdef1234567890abcdef1234567890abcdef12";
const base = () => ({
  registered_vk: VK, proof_vk: VK,
  minimum: "1000", public_balance: "1460",
  expiry_block: 8430000, current_block: 8420000,
  recipient: ADDR, condition_recipient: ADDR,
  amount: "500", max_transfer: "1000",
  proof_tx: "0xaaaa1111",
});

let pass = 0, fail = 0;
function check(name, input, proofTx, expected) {
  let got;
  try {
    got = gatekeeperFieldChecks(input, proofTx);
  } catch (e) {
    got = "THREW:" + (e.message || e);
  }
  const ok = got === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got=${got} expected=${expected}`);
  ok ? pass++ : fail++;
}
function mutate(patch) {
  const i = base();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete i[k]; else i[k] = v;
  }
  return i;
}

// --- The 7 varieties from the official trap encyclopedia ---
check("VALID_CONDITION -> APPROVE (null)", base(), "0xaaaa1111", null);
check("VK_SUBSTITUTION", mutate({ proof_vk: "0x00000000000000000000000000000000000000000000000000000000deadbeef" }), "0xbbbb2222", "VK_SUBSTITUTION");
check("THRESHOLD_MISMATCH (500 < 1000)", mutate({ public_balance: "500" }), "0xcccc3333", "THRESHOLD_MISMATCH");
check("EXPIRED_CONDITION (current > expiry)", mutate({ current_block: 8440000 }), "0xdddd4444", "EXPIRED_CONDITION");
check("EXPIRED_CONDITION (current == expiry, strict)", mutate({ current_block: 8430000 }), "0xeeee5555", "EXPIRED_CONDITION");
check("RECIPIENT_MISMATCH", mutate({ recipient: "0x1111111111111111111111111111111111111111" }), "0xffff6666", "RECIPIENT_MISMATCH");
check("AMOUNT_OVERFLOW (1800 > 1000, = practice task)", mutate({ amount: "1800" }), "0x20fa1ac8abe54a2597b73615fdb64899", "AMOUNT_OVERFLOW");

// --- PROOF_REUSED: a proof_tx recorded in the seen-set is rejected ---
seenProofTx.add("0xapproved9999");
check("PROOF_REUSED (previously seen)", base(), "0xapproved9999", "PROOF_REUSED");

// --- Boundaries: == must PASS (meets minimum / up to the cap / not yet expired) ---
check("BOUNDARY balance == minimum (1000 == 1000)", mutate({ public_balance: "1000" }), "0x11110001", null);
check("BOUNDARY amount == max_transfer (1000 == 1000)", mutate({ amount: "1000" }), "0x11110002", null);
check("BOUNDARY current == expiry - 1", mutate({ current_block: 8429999 }), "0x11110003", null);
// --- Case-insensitive addresses (EIP-55 checksum case must not matter) ---
check("CASE recipient checksummed vs lowercase", mutate({ recipient: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12" }), "0x11110004", null);
check("CASE proof_vk uppercase vs lowercase", mutate({ proof_vk: VK.toUpperCase() }), "0x11110005", null);

// --- Abuse / robustness cases ---
// Reuse after a REJECT: the proof_tx was used before but never APPROVEd.
// With the fix (record EVERY decided proof_tx), the check flags it.
seenProofTx.add("0x20fa1ac8abe54a2597b73615fdb64899");
check("REUSE-AFTER-REJECT (proof seen in a rejected task, then reused)", base(), "0x20fa1ac8abe54a2597b73615fdb64899", "PROOF_REUSED");
// Malformed numerics must fail CLOSED (REJECT), never throw (a throw = 500 = timeout, -2).
check("MALFORMED public_balance 'abc' (must not throw)", mutate({ public_balance: "abc" }), "0x11110006", "THRESHOLD_MISMATCH");
check("MALFORMED amount 'ten' (must not throw)", mutate({ amount: "ten" }), "0x11110007", "AMOUNT_OVERFLOW");
check("MALFORMED current_block 'soon' (must not throw)", mutate({ current_block: "soon" }), "0x11110008", "EXPIRED_CONDITION");

console.log(`\n${pass} passed, ${fail} failed`);

// --- End-to-end: the REAL handleTask path (module import, no HMAC secret
// in env so the HMAC gate is skipped, exactly as the code intends) ---
console.log("\n--- handleTask end-to-end (real entry point) ---");
const env = {}; // no HMAC_SECRET, no PROVER_URL, no SEEN_PROOFS: memory-only path
const ctx = { waitUntil: (p) => p.catch(() => {}) };
async function postTask(taskId, input) {
  const req = new Request("https://lucax.test/task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "agent-games.proof-gatekeeper.v1", task_id: taskId, mode: "competition", input }),
  });
  const res = await agent.fetch(req, env, ctx);
  return { status: res.status, body: await res.json() };
}
function e2e(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
}
{
  // Valid task -> APPROVE; same proof_tx in a NEW task -> PROOF_REUSED (record-on-APPROVE).
  const i1 = base(); i1.proof_tx = "0xe2e00001";
  const r1 = await postTask("e2e-1", i1);
  e2e("E2E valid task -> APPROVE/VALID_CONDITION", r1.status === 200 && r1.body.decision === "APPROVE" && r1.body.reason_code === "VALID_CONDITION");
  const i2 = base(); i2.proof_tx = "0xe2e00001";
  const r2 = await postTask("e2e-2", i2);
  e2e("E2E same proof_tx, new task -> REJECT/PROOF_REUSED", r2.status === 200 && r2.body.decision === "REJECT" && r2.body.reason_code === "PROOF_REUSED");
  // Trap task -> REJECT; same proof_tx in a NEW task -> PROOF_REUSED (record-on-REJECT = the fix).
  const i3 = mutate({ amount: "1800" }); i3.proof_tx = "0xe2e00002";
  const r3 = await postTask("e2e-3", i3);
  e2e("E2E overflow task -> REJECT/AMOUNT_OVERFLOW", r3.status === 200 && r3.body.decision === "REJECT" && r3.body.reason_code === "AMOUNT_OVERFLOW");
  const i4 = base(); i4.proof_tx = "0xe2e00002";
  const r4 = await postTask("e2e-4", i4);
  e2e("E2E reuse-after-REJECT -> REJECT/PROOF_REUSED", r4.status === 200 && r4.body.decision === "REJECT" && r4.body.reason_code === "PROOF_REUSED");
  // Malformed numeric through the real path -> REJECT, never 500.
  const i5 = mutate({ public_balance: "abc" }); i5.proof_tx = "0xe2e00003";
  const r5 = await postTask("e2e-5", i5);
  e2e("E2E malformed balance -> REJECT/THRESHOLD_MISMATCH (not 500)", r5.status === 200 && r5.body.decision === "REJECT" && r5.body.reason_code === "THRESHOLD_MISMATCH");
  // Idempotency: same task_id returns the same decision.
  const r6 = await postTask("e2e-1", i1);
  e2e("E2E same task_id -> identical cached decision", r6.status === 200 && r6.body.decision === "APPROVE" && r6.body.reason_code === "VALID_CONDITION");
  // Response shape matches the platform spec.
  e2e("E2E response has decision+reason_code+proof_tx", typeof r1.body.decision === "string" && typeof r1.body.reason_code === "string" && r1.body.proof_tx === "0xe2e00001");
}

console.log(`\nTOTAL ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
