import * as snarkjs from "snarkjs";
for (const name of ["registeredVkHash", "proofVkHash"]) {
  try {
    await snarkjs.wtns.calculate({ [name]: "0" }, "gatekeeper.wasm", "/tmp/vn.wtns");
    console.log(name, "=> ACCEPTED (unexpected full witness)");
  } catch (e) {
    const m = String(e.message || e);
    if (m.includes("Not all inputs")) console.log(name, "=> *** ACCEPTED (real input) ***");
    else console.log(name, "=> other:", m.slice(0, 120));
  }
}
process.exit(0);
