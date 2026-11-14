// Import snarkjs FIRST (as in the Worker, import succeeds), THEN ban dynamic WASM compile.
import * as snarkjs from "snarkjs";
WebAssembly.compile = () => { throw new Error("Wasm code generation disallowed by embedder (simulated)"); };
const _inst = WebAssembly.instantiate;
WebAssembly.instantiate = async (...args) => {
  if (args[0] instanceof WebAssembly.Module) return _inst(...args);
  throw new Error("Wasm code generation disallowed by embedder (simulated)");
};
const t0 = Date.now();
try {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { registeredVkHash: "4836144126773920907502496244340012141465762957689769435993496290439317388578",
      proofVkHash: "4836144126773920907502496244340012141465762957689769435993496290439317388578",
      minimum: "1000", publicBalance: "1460", expiryBlock: "19842201", currentBlock: "19832000",
      recipient: BigInt("0xDe42000000000000000000000000000000009f01").toString(),
      conditionRecipient: BigInt("0xDe42000000000000000000000000000000009f01").toString(),
      amount: "500", maxTransfer: "1000", taskId: "1", salt: "12345", decision: "1" },
    "gatekeeper.wasm", "gatekeeper_final.zkey");
  console.log("fullProve WITH WASM BANNED (after import) => OK in", Date.now()-t0, "ms — pure-JS fallback EXISTS");
} catch (e) {
  console.log("fullProve WITH WASM BANNED (after import) => FAILED in", Date.now()-t0, "ms:", String(e.message||e).slice(0,220));
}
process.exit(0);
