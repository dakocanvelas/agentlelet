import * as snarkjs from "snarkjs";
const candidates = [
  "reused","seen","used","isReused","alreadySeen","vkOk","vkEqual","keysMatch","vkMatches",
  "proofOk","proofExists","proofOnchain","onChainProof","balanceOk","thresholdPassed",
  "thresholdMet","meetsMinimum","recipientOk","recipientMatches","notExpired","isExpired",
  "expired","withinCap","underCap","decisionReason","trapCode","trapId","violation",
  "violations","taskType","eventType","competition","track","game","arena","issuer",
  "platform","verifier","prover","time","now","date","fee","cost","price",
  "TaskId","Decision","Salt","Minimum","Amount","Recipient","in_decision","in_taskId",
  "gatekeeper_decision","gk_decision","input_decision","pubBalance","pub_balance","bal",
  "minAmt","maxAmt","expBlock","curBlock","condRecipient","cond_recipient","taskID","TASKID",
];
for (const name of candidates) {
  try {
    await snarkjs.wtns.calculate({ [name]: "0" }, "gatekeeper.wasm", "/tmp/probe7.wtns");
    console.log(name, "=> ACCEPTED?");
  } catch (e) {
    const m = String(e.message || e);
    if (m.includes("Not all inputs")) console.log(name, "=> *** ACCEPTED ***");
    else if (m.includes("Too many")) console.log(name, "=> no");
    else if (m.includes("Not enough")) console.log(name, "=> *** ARRAY-INPUT ***", m.slice(0, 80));
    else console.log(name, "=> other:", m.slice(0, 80));
  }
}
console.log("DONE");
process.exit(0);
