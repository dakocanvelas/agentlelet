// The 7 deterministic Gatekeeper field checks, in the order the official
// trap encyclopedia lists them. Shared by the prover (prove-or-flip) and
// mirrored in the Worker's src/index.js — keep both in sync.
//
// CORRECTNESS NOTE (15 Nov 2026, proven against the real circuit):
// the expiry check is STRICT — currentBlock must be < expiryBlock.
// currentBlock == expiryBlock is EXPIRED: the circuit refuses to prove
// APPROVE for it (witness assert, GatekeeperEvaluation line 102).
// The Worker's original `current > expiry` check was wrong at this
// boundary and is fixed to `current >= expiry` in both places.

export function gatekeeperFieldChecks(input, proofTx, acceptedProofTx) {
  const eqAddr = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  if (!eqAddr(input.proof_vk, input.registered_vk)) return "VK_SUBSTITUTION";
  if (proofTx && acceptedProofTx && acceptedProofTx.has(proofTx)) return "PROOF_REUSED";
  if (input.public_balance != null && input.minimum != null) {
    if (BigInt(input.public_balance) < BigInt(input.minimum)) return "THRESHOLD_MISMATCH";
  }
  if (input.current_block != null && input.expiry_block != null) {
    if (BigInt(input.current_block) >= BigInt(input.expiry_block)) return "EXPIRED_CONDITION";
  }
  if (!eqAddr(input.recipient, input.condition_recipient)) return "RECIPIENT_MISMATCH";
  if (input.amount != null && input.max_transfer != null) {
    if (BigInt(input.amount) > BigInt(input.max_transfer)) return "AMOUNT_OVERFLOW";
  }
  return null;
}
