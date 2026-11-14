import * as snarkjs from "snarkjs";
const P = BigInt("0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47");
const VK = (BigInt("0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0") % P).toString();
const ADDR = BigInt("0xDe42000000000000000000000000000000009f01").toString();
const base = { registeredVkHash: VK, proofVkHash: VK, minimum: "1000", publicBalance: "1460",
  expiryBlock: "19842201", currentBlock: "19832000", recipient: ADDR, conditionRecipient: ADDR,
  amount: "500", maxTransfer: "1000", decision: "1" };
async function t(label, extra) {
  const { publicSignals } = await snarkjs.groth16.fullProve({ ...base, ...extra }, "gatekeeper.wasm", "gatekeeper_final.zkey");
  console.log(label, "sig[0] =", publicSignals[0]);
}
await t("taskId=1 salt=12345", { taskId: "1", salt: "12345" });
await t("taskId=2 salt=12345", { taskId: "2", salt: "12345" });
await t("taskId=1 salt=99999", { taskId: "1", salt: "99999" });
await t("taskId=2 salt=99999", { taskId: "2", salt: "99999" });
process.exit(0);
