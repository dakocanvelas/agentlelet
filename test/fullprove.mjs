import * as snarkjs from "snarkjs";

const ADDR = "0xDe42000000000000000000000000000000009f01"; // 160-bit, fits in bn128 field
const ADDR_NUM = BigInt(ADDR).toString();

const base = {
  minimum: "1000",
  publicBalance: "1460",
  expiryBlock: "19842201",
  currentBlock: "19832000",
  recipient: ADDR_NUM,
  conditionRecipient: ADDR_NUM,
  amount: "500",
  maxTransfer: "1000",
  taskId: "1",
};

async function attempt(label, input) {
  const t0 = Date.now();
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, "gatekeeper.wasm", "gatekeeper_final.zkey");
    console.log(label, "=> PROOF OK in", Date.now() - t0, "ms");
    console.log("  publicSignals (" + publicSignals.length + "):", JSON.stringify(publicSignals));
    console.log("  proof.pi_a[0]:", proof.pi_a[0].slice(0, 20) + "...");
    return { proof, publicSignals };
  } catch (e) {
    console.log(label, "=> FAILED in", Date.now() - t0, "ms:", String(e.message || e).slice(0, 300));
    return null;
  }
}

// Case 1: valid condition, decision=1 (approve)
const r1 = await attempt("valid + decision=1", { ...base, decision: "1" });
// Case 2: valid condition, decision=0 (reject) — should fail if circuit enforces the decision
await attempt("valid + decision=0", { ...base, decision: "0" });
// Case 3: trap (VK substitution is not a circuit input; use threshold trap), decision=1 — should fail
await attempt("threshold-trap + decision=1", { ...base, publicBalance: "500", decision: "1" });
// Case 4: threshold trap, decision=0 — should pass
await attempt("threshold-trap + decision=0", { ...base, publicBalance: "500", decision: "0" });

if (r1) {
  // Verify the proof locally against the exported vkey
  const vkey = JSON.parse((await import("node:fs")).readFileSync("gatekeeper.vkey.json", "utf8"));
  const ok = await snarkjs.groth16.verify(vkey, r1.publicSignals, r1.proof);
  console.log("local groth16.verify:", ok);
}
console.log("DONE");
process.exit(0);
