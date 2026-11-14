import * as snarkjs from "snarkjs";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
for (const name of ["secret", "password", "salt", "decision"]) {
  try {
    await snarkjs.wtns.calculate({ [name]: "0" }, "gatekeeper.wasm", "/tmp/probe5.wtns");
    console.log(name, "=> OK");
  } catch (e) {
    const m = String(e.message || e);
    let code = "?";
    if (m.includes("Not all inputs")) code = "A-accepted";
    else if (m.includes("Too many")) code = "B-too-many";
    else if (m.includes("not found")) code = "C-not-found";
    else code = "D-other";
    console.log(name, "=>", code, "| msg_b64:", b64(m.slice(0, 160)));
  }
}
// also try secret as arrays
for (const arr of [["0","0"], ["0","0","0"], ["0","0","0","0"]]) {
  try {
    await snarkjs.wtns.calculate({ secret: arr }, "gatekeeper.wasm", "/tmp/probe5.wtns");
    console.log("secret-arr-len-" + arr.length, "=> OK");
  } catch (e) {
    const m = String(e.message || e);
    let code = m.includes("Not all inputs") ? "A-accepted" : m.includes("Too many") ? "B-too-many" : m.includes("not found") ? "C-not-found" : "D-other";
    console.log("secret-arr-len-" + arr.length, "=>", code);
  }
}
console.log("DONE");
process.exit(0);
