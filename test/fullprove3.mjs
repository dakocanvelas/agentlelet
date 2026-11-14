import * as snarkjs from "snarkjs";
import fs from "node:fs";

// BN254 field modulus
const P = BigInt("0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47");
const VK_HASH = BigInt("0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0");
const VK_MOD_P = (VK_HASH % P).toString();
console.log("vkHash raw > p ?", VK_HASH > P, "| vkHash mod p =", VK_MOD_P);

const ADDR = BigInt("0xDe42000000000000000000000000000000009f01").toString();
const OTHER = BigInt("0x1111111111111111111111111111111111111111").toString();
const base = {
  registeredVkHash: VK_MOD_P, proofVkHash: VK_MOD_P,
  minimum: "1000", publicBalance: "1460", expiryBlock: "19842201", currentBlock: "19832000",
  recipient: ADDR, conditionRecipient: ADDR, amount: "500", maxTransfer: "1000",
  taskId: "1", salt: "12345",
};
const vkey = JSON.parse(fs.readFileSync("gatekeeper.vkey.json", "utf8"));

async function attempt(label, input) {
  const t0 = Date.now();
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, "gatekeeper.wasm", "gatekeeper_final.zkey");
    const dt = Date.now() - t0;
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    console.log(`${label} => PROOF OK in ${dt}ms | verify=${ok} | publicSignals(${publicSignals.length}):`, JSON.stringify(publicSignals));
    return { proof, publicSignals };
  } catch (e) {
    console.log(`${label} => FAILED in ${Date.now() - t0}ms:`, String(e.message || e).slice(0, 160));
    return null;
  }
}

await attempt("1 valid + APPROVE", { ...base, decision: "1" });
await attempt("2 valid + REJECT", { ...base, decision: "0" });
await attempt("3 threshold-trap + APPROVE", { ...base, publicBalance: "500", decision: "1" });
await attempt("4 threshold-trap + REJECT", { ...base, publicBalance: "500", decision: "0" });
await attempt("5 recipient-trap + APPROVE", { ...base, recipient: OTHER, decision: "1" });
await attempt("6 recipient-trap + REJECT", { ...base, recipient: OTHER, decision: "0" });
await attempt("7 expired + APPROVE", { ...base, currentBlock: "19850000", decision: "1" });
await attempt("8 expired + REJECT", { ...base, currentBlock: "19850000", decision: "0" });
await attempt("9 overflow + APPROVE", { ...base, amount: "1500", decision: "1" });
await attempt("10 overflow + REJECT", { ...base, amount: "1500", decision: "0" });
await attempt("11 VK-mismatch + APPROVE", { ...base, proofVkHash: "123", decision: "1" });
await attempt("12 VK-mismatch + REJECT", { ...base, proofVkHash: "123", decision: "0" });
// boundary cases
await attempt("13 balance==minimum + APPROVE", { ...base, publicBalance: "1000", decision: "1" });
await attempt("14 amount==max + APPROVE", { ...base, amount: "1000", decision: "1" });
await attempt("15 current==expiry + APPROVE", { ...base, currentBlock: "19842201", decision: "1" });
console.log("DONE");
process.exit(0);
