import * as snarkjs from "snarkjs";
import fs from "node:fs";

const ADDR = BigInt("0xDe42000000000000000000000000000000009f01").toString();
const base = {
  minimum: "1000", publicBalance: "1460", expiryBlock: "19842201", currentBlock: "19832000",
  recipient: ADDR, conditionRecipient: ADDR, amount: "500", maxTransfer: "1000",
  taskId: "1", salt: "12345", secret: "111", password: "222",
};

async function attempt(label, input) {
  const t0 = Date.now();
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, "gatekeeper.wasm", "gatekeeper_final.zkey");
    console.log(label, "=> PROOF OK in", Date.now() - t0, "ms");
    console.log("  publicSignals (" + publicSignals.length + "):", JSON.stringify(publicSignals));
    return { proof, publicSignals };
  } catch (e) {
    console.log(label, "=> FAILED in", Date.now() - t0, "ms:", String(e.message || e).slice(0, 200));
    return null;
  }
}

const r1 = await attempt("valid + decision=1", { ...base, decision: "1" });
await attempt("valid + decision=0", { ...base, decision: "0" });
await attempt("threshold-trap + decision=1", { ...base, publicBalance: "500", decision: "1" });
const r4 = await attempt("threshold-trap + decision=0", { ...base, publicBalance: "500", decision: "0" });
await attempt("recipient-trap + decision=1", { ...base, recipient: BigInt("0x1111111111111111111111111111111111111111").toString(), decision: "1" });
await attempt("expired + decision=1", { ...base, currentBlock: "19850000", decision: "1" });
await attempt("overflow + decision=1", { ...base, amount: "1500", decision: "1" });

const vkey = JSON.parse(fs.readFileSync("gatekeeper.vkey.json", "utf8"));
if (r1) console.log("verify r1:", await snarkjs.groth16.verify(vkey, r1.publicSignals, r1.proof));
if (r4) console.log("verify r4:", await snarkjs.groth16.verify(vkey, r4.publicSignals, r4.proof));
console.log("DONE");
process.exit(0);
