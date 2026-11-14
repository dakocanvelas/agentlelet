import * as snarkjs from "snarkjs";

const candidates = [
  "registered_vk","proof_vk","minimum","public_balance","expiry_block","current_block",
  "recipient","condition_recipient","amount","max_transfer","proof_tx",
  "decision","action","threshold","vk","balance","min","max","expiry","block",
  "vkHash","vk_hash","proofVk","registeredVk","publicBalance","expiryBlock",
  "currentBlock","conditionRecipient","maxTransfer","proofTx","taskId","task_id",
  "approve","valid","outcome","reasonCode","reason_code","isValid","publicSignals",
  "decisionHash","inputHash","stateHash","commitment","nullifier"
];

for (const name of candidates) {
  try {
    await snarkjs.wtns.calculate({ [name]: "0" }, "gatekeeper.wasm", "/tmp/probe.wtns");
    console.log(name, "=> ACCEPTED (unexpected: full witness?)");
  } catch (e) {
    const m = String(e.message || e);
    if (m.includes("not found")) console.log(name, "=> not found");
    else if (m.includes("Not all inputs")) console.log(name, "=> ACCEPTED (name exists, more inputs needed)");
    else console.log(name, "=> other error:", m.slice(0, 120));
  }
}
console.log("DONE");
process.exit(0);
