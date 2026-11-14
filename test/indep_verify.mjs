import * as snarkjs from "snarkjs";
import fs from "node:fs";
const { proof, publicSignals } = JSON.parse(fs.readFileSync("/tmp/proof_worker.json", "utf8"));
const vkey = JSON.parse(fs.readFileSync("gatekeeper.vkey.json", "utf8"));
console.log("independent groth16.verify of prover-returned proof:", await snarkjs.groth16.verify(vkey, publicSignals, proof));
console.log("publicSignals:", JSON.stringify(publicSignals));
process.exit(0);
