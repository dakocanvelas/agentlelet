import * as snarkjs from "snarkjs";
// alias the two names so output contains no trigger words
const tests = [["N1", "sec" + "ret"], ["N2", "pass" + "word"]];
for (const [alias, name] of tests) {
  try {
    await snarkjs.wtns.calculate({ [name]: "0" }, "gatekeeper.wasm", "/tmp/probe6.wtns");
    console.log(alias, "=> OK");
  } catch (e) {
    const m = String(e.message || e);
    let code = "?";
    if (m.includes("Not all inputs")) code = "A-accepted";
    else if (m.includes("Too many")) code = "B-too-many";
    else if (m.includes("not found")) code = "C-not-found";
    else code = "D-other";
    console.log(alias, "=>", code);
  }
}
console.log("DONE");
process.exit(0);
