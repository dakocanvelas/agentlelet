import * as snarkjs from "snarkjs";
import fs from "node:fs";

// 1. Export verification key from the real gatekeeper zkey
const vkey = await snarkjs.zKey.exportVerificationKey("gatekeeper_final.zkey");
console.log("VK protocol:", vkey.protocol, "curve:", vkey.curve);
console.log("nPublic:", vkey.nPublic);
console.log("IC length:", vkey.IC.length);
fs.writeFileSync("gatekeeper.vkey.json", JSON.stringify(vkey, null, 2));

// 2. Try witness calculation with an empty input to see the error (reveals expected signals)
try {
  const wtns = await snarkjs.wtns.calculate({}, "gatekeeper.wasm");
  console.log("wtns with {} succeeded, len:", wtns.length);
} catch (e) {
  console.log("wtns {} error:", String(e.message || e).slice(0, 500));
}
