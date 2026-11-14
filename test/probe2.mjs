import * as snarkjs from "snarkjs";

const candidates = [
  // controls — must NOT be inputs
  "zzzzqqq", "foobar123", "notasignal",
  // boolean check flags
  "vkMatch", "thresholdOk", "recipientMatch", "notExpired", "notReused", "amountOk",
  "checksPassed", "allChecks", "isValidDecision", "validDecision",
  // hash limbs
  "vkHi", "vkLo", "proofHi", "proofLo", "txHi", "txLo", "hashHi", "hashLo",
  "registeredVkHi", "registeredVkLo", "proofVkHi", "proofVkLo",
  // time / meta
  "issuedAt", "deadlineAt", "timestamp", "issued_at", "deadline_at", "mode",
  "chainId", "chain_id", "nonce", "salt", "round", "roundId", "agentId",
  // more addresses / parties
  "payer", "payee", "beneficiary", "sender", "owner", "agent", "from", "to",
  // reason / misc
  "reason", "code", "trap", "trapType", "value", "data", "sig", "signature",
  "proof", "inputsHash", "publicInputHash", "commitmentHash", "decisionHash2",
  // alternate spellings of known fields
  "minBalance", "balance", "thresholdMin", "expiry", "deadline", "transferMax",
  "maxAmount", "transferAmount", "payAmount", "recipientAddr", "conditionAddr",
  "task", "id", "index", "roundNumber", "decisionValue", "approveFlag", "isApprove",
  "result", "verdict", "status", "score", "points",
];

for (const name of candidates) {
  try {
    await snarkjs.wtns.calculate({ [name]: "0" }, "gatekeeper.wasm", "/tmp/probe2.wtns");
    console.log(name, "=> ACCEPTED?");
  } catch (e) {
    const m = String(e.message || e);
    if (m.includes("not found")) console.log(name, "=> not found");
    else if (m.includes("Not all inputs")) console.log(name, "=> *** ACCEPTED (real input) ***");
    else if (m.includes("Too many")) console.log(name, "=> not an input");
    else console.log(name, "=> other:", m.slice(0, 100));
  }
}
console.log("DONE");
process.exit(0);
