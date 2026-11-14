import * as snarkjs from "snarkjs";
const candidates = [
  "secret","seed","key","hash","digest","root","leaf","proofHash","conditionHash",
  "statementHash","taskHash","decisionSalt","salt2","randomness","random","blinding",
  "blind","privateInput","witnessHash","vk0","vk1","registeredVk0","registeredVk1",
  "proofVk0","proofVk1","txHash","proofTxHash","blockHash","startBlock","blockNumber",
  "minThreshold","thresholdValue","balanceValue","amountValue","recipientHash",
  "decisionCode","actionCode","actionValue","inputs","signals","values",
  "decisionSalt","taskSalt","proofSalt","conditionSalt","in","out","public",
  "private","aux","extra","field","element","limb","hi","lo","part0","part1",
  "a","b","c","x","y","z","n","i","j","k","t","d","s","r","v","w",
  "roundNum","day","eventId","competitionId","agentGames","gameId","matchId",
  "isPublic","isPrivate","flag","flags","mask","bits","check","checks",
];
for (const name of candidates) {
  try {
    await snarkjs.wtns.calculate({ [name]: "0" }, "gatekeeper.wasm", "/tmp/probe3.wtns");
    console.log(name, "=> ACCEPTED?");
  } catch (e) {
    const m = String(e.message || e);
    if (m.includes("Not all inputs")) console.log(name, "=> *** ACCEPTED (real input) ***");
    else if (m.includes("Too many")) console.log(name, "=> not an input");
    else console.log(name, "=> other:", m.slice(0, 100));
  }
}
console.log("DONE");
process.exit(0);
