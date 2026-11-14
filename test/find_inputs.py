#!/usr/bin/env python3
"""Dictionary-attack the unknown FNV-1a signal hashes from the gatekeeper WASM.

Targets (found by test/parse_wasm.py, 15 Nov 2026):
  0x14418c3ee75f7a4e -> signal index 2
  0x3b2514e2617cb386 -> signal index 3
Result: 0x14418c3ee75f7a4e = "registeredVkHash", 0x3b2514e2617cb386 = "proofVkHash".
"""
import itertools

TARGETS = {0x14418c3ee75f7a4e: "UNKNOWN-idx2", 0x3b2514e2617cb386: "UNKNOWN-idx3"}


def fnv1a(s):
    h = 0xcbf29ce484222325
    for ch in s.encode():
        h ^= ch
        h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return h


words = ["vk", "proof", "tx", "hash", "valid", "verified", "verify", "check", "decision", "task", "recipient",
         "amount", "balance", "minimum", "expiry", "current", "block", "transfer", "salt", "secret", "nonce", "id",
         "ref", "reference", "receipt", "signature", "sig", "chain", "network", "mode", "type", "agent", "round",
         "game", "competition", "event", "issuer", "platform", "verifier", "prover", "result", "outcome", "status",
         "flag", "code", "reason", "trap", "violation", "threshold", "cap", "limit", "max", "min", "public", "private",
         "input", "signal", "witness", "commitment", "nullifier", "root", "leaf", "digest", "key", "keys", "match",
         "matches", "equal", "equals", "is", "ok", "pass", "passed", "approve", "reject", "gatekeeper", "gk",
         "main", "expected", "actual", "registered", "submitted", "onchain", "onChain", "finalized", "final",
         "inclusion", "included", "used", "reuse", "reused", "seen", "fresh", "new", "old", "first", "last", "time",
         "timestamp", "issued", "deadline", "height", "number", "value", "values", "data", "info", "detail",
         "payment", "pay", "transfer", "sender", "receiver", "payer", "payee", "from", "to", "beneficiary",
         "address", "addr", "account", "wallet", "owner", "user", "handle", "name", "title", "version", "protocol",
         "circuit", "groth16", "bn128", "snark", "zk", "zkey", "wasm", "curve", "field", "scalar", "point",
         "proofTx", "proofVk", "registeredVk", "publicBalance", "conditionRecipient", "maxTransfer", "expiryBlock",
         "currentBlock", "taskId", "publicSignals", "publicInputs", "inputsHash", "proofHash", "txHash", "vkHash"]

cands = set()
for w in words:
    cands.add(w)
    cands.add(w.lower())
    cands.add(w[0].upper() + w[1:])
    cands.add(w.upper())

core = ["vk", "proof", "tx", "hash", "valid", "verified", "check", "decision", "task", "recipient", "amount",
        "balance", "minimum", "expiry", "current", "block", "transfer", "salt", "secret", "nonce", "id", "ref",
        "reference", "receipt", "signature", "chain", "mode", "agent", "round", "game", "event", "issuer", "platform",
        "verifier", "prover", "result", "outcome", "status", "flag", "code", "reason", "trap", "threshold", "cap",
        "limit", "max", "min", "public", "private", "key", "match", "equal", "ok", "pass", "approve", "reject",
        "registered", "submitted", "onchain", "finalized", "used", "reused", "seen", "time", "timestamp", "issued",
        "deadline", "height", "value", "data", "payment", "sender", "receiver", "address", "account", "wallet",
        "owner", "user", "version", "protocol", "circuit", "groth16", "snark", "zk", "zkey", "commitment", "nullifier",
        "root", "digest", "expected", "actual", "is", "not", "in", "out", "hi", "lo"]
for a, b in itertools.permutations(core, 2):
    cands.add(a + b[0].upper() + b[1:])
    cands.add(a + "_" + b)
    cands.add(a[0].upper() + a[1:] + b[0].upper() + b[1:])
    cands.add(a + b)

bases = ["vk", "proof", "tx", "hash", "proofTx", "proofVk", "registeredVk", "vkHash", "proofHash", "txHash",
         "hashHi", "hashLo", "vkHashHi", "vkHashLo", "proofTxHash", "registeredVkHash", "proofVkHash", "inputHash",
         "inputsHash", "publicInputHash", "publicInputsHash", "decisionHash", "taskHash", "saltHash", "commitment",
         "nullifier", "root", "digest", "signature", "sig", "key", "receipt", "reference", "proofRef", "proofTxRef"]
for b in bases:
    for suf in ["Hi", "Lo", "hi", "lo", "0", "1", "2", "[0]", "[1]", "[2]", "_hi", "_lo", "_0", "_1", "High", "Low", "HIGH", "LOW"]:
        cands.add(b + suf)
    cands.add(b + "Hash")
    cands.add(b + "hash")

for pre in ["in", "pub", "public", "gk", "gatekeeper", "is", "has", "not", "isNot", "is_", "pub_", "in_"]:
    for w in ["decision", "taskId", "valid", "verified", "proof", "vk", "tx", "hash", "check", "approved", "rejected", "expired", "reused", "seen", "used", "finalized", "correct", "ok", "pass"]:
        cands.add(pre + w[0].upper() + w[1:] if pre not in ("is_", "pub_", "in_") else pre + w)

env = ["registered_vk", "proof_vk", "proof_tx", "public_balance", "expiry_block", "current_block",
       "condition_recipient", "max_transfer", "task_id", "minimum", "recipient", "amount", "decision", "salt",
       "registeredVk", "proofVk", "proofTx", "publicBalance", "expiryBlock", "currentBlock", "conditionRecipient",
       "maxTransfer", "taskId", "RegisteredVk", "ProofVk", "ProofTx", "PublicBalance", "ExpiryBlock", "CurrentBlock",
       "ConditionRecipient", "MaxTransfer", "TaskId", "Minimum", "Recipient", "Amount", "Decision", "Salt"]
for e in env:
    cands.add(e)
    cands.add(e + "Hi")
    cands.add(e + "Lo")
    cands.add(e + "[0]")
    cands.add(e + "[1]")

extra = ["isValidDecision", "validDecision", "correctDecision", "expectedDecision", "decisionValid",
         "proofVerified", "proofIsValid", "vkMatches", "vkMatch", "keysMatch", "vkEqual", "proofOk", "vkOk",
         "proofExists", "proofOnchain", "onChainProof", "balanceOk", "thresholdPassed", "thresholdMet",
         "meetsMinimum", "recipientOk", "recipientMatches", "notExpired", "withinCap", "underCap", "decisionReason",
         "allChecks", "checksPassed", "allPassed", "checks", "checkFlags", "trapFlags", "trapCode", "trapId",
         "violation", "violations", "taskType", "eventType", "competitionId", "roundId", "roundNum", "roundNumber",
         "gameId", "eventId", "matchId", "agentId", "handle", "issuedAt", "issued_at", "deadlineAt", "deadline_at",
         "deadlineBlock", "startBlock", "issueBlock", "blockNumber", "blockHash", "blockHeight", "chainId", "chain_id",
         "networkId", "publicKey", "pubkey", "publicInput", "publicSignals", "inputs", "inputHash", "statementHash",
         "stateHash", "witnessHash", "secretHash", "decisionHash", "taskHash", "taskSalt", "proofSalt", "decisionSalt",
         "conditionSalt", "conditionHash", "recipientHash", "recipientMatch", "amountValue", "balanceValue",
         "thresholdValue", "thresholdMin", "thresholdOk", "minThreshold", "minBalance", "maxBalance", "maxAmount",
         "minTransfer", "maxTransfer", "transferAmount", "transferLimit", "transferMax", "requestedAmount",
         "paymentAmount", "amountPaid", "availableBalance", "totalBalance", "action", "actionCode", "actionValue",
         "approveFlag", "isApprove", "outcome", "verdict", "result", "score", "points", "rank", "phase", "stage", "step",
         "level", "tier", "kind", "element", "word", "limb", "part0", "part1", "input0", "signal0", "aux", "blind", "blinding",
         "random", "randomness", "seed", "pepper", "iv", "mask", "domain", "template", "circuit", "competition", "track",
         "arena", "issuer", "platform", "verifier", "prover", "fee", "cost", "price", "date", "now", "time", "day",
         "a", "b", "c", "x", "y", "z", "n", "m", "i", "j", "k", "p", "q", "r", "s", "t", "u", "v", "w", "e", "f", "g", "h", "l", "o",
         "in0", "in1", "in2", "pub0", "pub1", "input1", "input2", "x0", "x1", "y0", "y1", "s0", "s1", "w0", "w1"]
for e in extra:
    cands.add(e)

print("candidates:", len(cands))
found = {}
for c in cands:
    h = fnv1a(c)
    if h in TARGETS:
        found[c] = (TARGETS[h], hex(h))
        print("*** HIT ***", c, "->", TARGETS[h], hex(h))
print("done. hits:", found)
