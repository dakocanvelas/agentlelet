import * as snarkjs from "snarkjs";
const candidates = [
  "pepper","iv","secretHash","secretKey","secretValue","privateKey","password",
  "receiver","requestedAmount","paymentAmount","amountPaid","totalBalance",
  "availableBalance","maxBalance","blockHeight","height","number","chain","network",
  "domain","version","circuit","template","event","type","kind","traps","trapFlags",
  "checkFlags","allPassed","passed","decisionValid","validProof","proofValid",
  "onchain","onChain","verified","confirmed","finalized","included","state",
  "phase","step","stage","level","tier","rank","tx","txid","receipt","reference",
  "ref","proofRef","referenceHash","maximum","cap","limit","ceiling","minTransfer",
  "transferLimit","issueBlock","deadlineBlock","handle","name","publicKey","pubkey",
  "address","wallet","account","user","player","competitor","entrant","participant",
  "e","f","g","h","l","m","o","p","q","u","input0","signal0","publicInput",
];
for (const name of candidates) {
  try {
    await snarkjs.wtns.calculate({ [name]: "0" }, "gatekeeper.wasm", "/tmp/probe4.wtns");
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
