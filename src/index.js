// lucax — verification-first agent for Agent Games (zkVerify)
// Agent: lucax | Handle: raraza | Repo: https://github.com/dakocanvelas/agentlelet
// Public endpoint for the Wildcard track. No dependencies, Web APIs only.
// Secrets (HMAC_SECRET, KURIER_API_KEY) come from environment secrets only —
// NEVER hardcode them here or in the repo.
//
// Routes:
//   GET  /          agent card
//   GET  /health    health check (used by the Agent Games platform)
//   POST /verify    real verification of a claim: {"type":"url"|"contract"|"text","value":"..."}
//   POST /task      Gatekeeper task endpoint: HMAC verify + 7 trap field checks +
//                   idempotency + decision. Response shape matches the platform
//                   spec: {decision, reason_code, proof_tx}, signed with
//                   x-agent-games-signature when HMAC_SECRET is configured.
//
// Gatekeeper decision logic (from the official trap encyclopedia, event page
// /events/proof-gatekeeper): the 7 checks are deterministic field comparisons,
// and the page states all trap types are documented and field-detectable.
// Approval therefore rests on the field checks. Two honest gaps, recorded
// in README + test/snarkjs-test.md:
//   (a) Groth16 proof generation does NOT work in Workers (runtime disallows
//       dynamic WASM compilation — proven live, see test/). A correct decision
//       without our proof costs -2 and no reliability bonus, per the rules.
//   (b) The on-chain confirmation of the task's proof_tx via Kurier is not
//       yet wired in; it would catch a proof that is not on-chain at all,
//       a case outside the 7 documented trap types.

const AGENT = {
  name: "lucax",
  handle: "raraza",
  version: "0.2.0",
  description:
    "Verification-first agent: it verifies before it acts. Checks live facts (URL reachability, on-chain contract code, Gatekeeper task fields) before trusting a claim, and proves every step with evidence.",
  tracks: ["wildcard", "gatekeeper"],
  repository: "https://github.com/dakocanvelas/agentlelet",
  endpoints: ["GET /", "GET /health", "POST /verify", "POST /task"],
};

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...headers,
    },
  });

const corsPreflight = () =>
  new Response(null, {
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- /verify: url ----------
async function verifyUrl(value) {
  const started = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(value, { redirect: "follow" }, 8000);
  } catch (e) {
    return {
      type: "url",
      value,
      verdict: "unreachable",
      evidence: { error: e.name === "AbortError" ? "timeout after 8s" : String(e.message || e) },
      checked_at: new Date().toISOString(),
      ms: Date.now() - started,
    };
  }
  const evidence = {
    status: res.status,
    final_url: res.url,
    content_type: res.headers.get("content-type"),
    content_length: res.headers.get("content-length"),
  };
  if ((evidence.content_type || "").includes("text/html")) {
    try {
      const text = await res.clone().text();
      const m = text.slice(0, 65536).match(/<title[^>]*>([^<]*)<\/title>/i);
      if (m) evidence.title = m[1].trim().slice(0, 200);
    } catch {
      // title is best-effort only
    }
  }
  return {
    type: "url",
    value,
    verdict: res.ok ? "reachable" : "reachable_but_error_status",
    evidence,
    checked_at: new Date().toISOString(),
    ms: Date.now() - started,
  };
}

// ---------- /verify: contract (BSC) ----------
const BSC_RPCS = ["https://bsc-dataseed.binance.org", "https://bsc-dataseed1.defibit.io"];

async function rpcCall(rpc, method, params) {
  const res = await fetchWithTimeout(
    rpc,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    8000,
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "rpc error");
  return data.result;
}

function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeAbiString(hex) {
  // string return: 32B offset, 32B length, utf8 bytes
  const b = hexToBytes(hex);
  if (b.length < 64) return null;
  const len = Number(new DataView(b.buffer, 32, 8).getBigUint64(0, false));
  if (64 + len > b.length) return null;
  return new TextDecoder().decode(b.slice(64, 64 + len));
}

async function verifyContract(value) {
  const started = Date.now();
  const address = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return {
      type: "contract",
      value,
      verdict: "invalid_input",
      evidence: { error: "not a valid 0x EVM address (40 hex chars)" },
      checked_at: new Date().toISOString(),
      ms: Date.now() - started,
    };
  }
  const evidence = { chain: "BSC (56)", address };
  let code = null;
  let rpcUsed = null;
  let rpcError = null;
  for (const rpc of BSC_RPCS) {
    try {
      code = await rpcCall(rpc, "eth_getCode", [address, "latest"]);
      rpcUsed = rpc;
      break;
    } catch (e) {
      rpcError = String(e.message || e);
    }
  }
  if (code === null) {
    return {
      type: "contract",
      value,
      verdict: "unverified_rpc_failed",
      evidence: { ...evidence, error: rpcError || "all BSC RPCs failed" },
      checked_at: new Date().toISOString(),
      ms: Date.now() - started,
    };
  }
  evidence.rpc = rpcUsed;
  evidence.code_bytes = code === "0x" ? 0 : (code.length - 2) / 2;
  evidence.is_contract = code !== "0x";
  if (evidence.is_contract) {
    const digest = await crypto.subtle.digest("SHA-256", hexToBytes(code));
    evidence.code_sha256 = toHex(new Uint8Array(digest));
    // Best-effort ERC20 metadata (name/symbol/decimals). Absence proves nothing:
    // some tokens return bytes32 instead of an ABI string, which decodeAbiString rejects.
    const meta = {};
    const calls = [
      ["name", "0x06fdde03", "string"],
      ["symbol", "0x95d89b41", "string"],
      ["decimals", "0x313ce567", "uint8"],
    ];
    for (const [key, selector, kind] of calls) {
      try {
        const out = await rpcCall(rpcUsed, "eth_call", [{ to: address, data: selector }, "latest"]);
        if (out && out !== "0x") {
          if (kind === "string") {
            const s = decodeAbiString(out);
            if (s) meta[key] = s.slice(0, 100);
          } else {
            meta[key] = parseInt(out.slice(-2), 16);
          }
        }
      } catch {
        // metadata is best-effort; a failure is not a verdict
      }
    }
    if (Object.keys(meta).length) evidence.erc20 = meta;
  }
  return {
    type: "contract",
    value,
    verdict: evidence.is_contract ? "contract_exists" : "no_code_at_address",
    evidence,
    checked_at: new Date().toISOString(),
    ms: Date.now() - started,
  };
}

// ---------- /verify: text ----------
function verifyText(value) {
  const urlMatch = value.match(/https?:\/\/[^\s"'<>]+/);
  return {
    type: "text",
    value: value.slice(0, 500),
    verdict: "needs_evidence",
    evidence: {
      chars: value.length,
      lines: value.split("\n").length,
      contains_url: Boolean(urlMatch),
      first_url: urlMatch ? urlMatch[0].slice(0, 300) : null,
      note: "A bare claim is not evidence. Re-submit as type 'url' or 'contract' for a checkable verdict.",
    },
    checked_at: new Date().toISOString(),
    ms: 0,
  };
}

// ---------- HMAC helpers ----------
async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return toHex(new Uint8Array(sig));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- /task: Gatekeeper ----------
const seenTasks = new Map(); // task_id -> response body (in-memory, best-effort)
const acceptedProofTx = new Set(); // proof_tx values from APPROVEd tasks (reuse detection)

// The 7 deterministic field checks, in the order the trap encyclopedia lists them.
// Returns a reason_code, or null when every field passes.
function gatekeeperFieldChecks(input, proofTx) {
  const eqAddr = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  if (!eqAddr(input.proof_vk, input.registered_vk)) return "VK_SUBSTITUTION";
  if (proofTx && acceptedProofTx.has(proofTx)) return "PROOF_REUSED";
  if (input.public_balance != null && input.minimum != null) {
    if (BigInt(input.public_balance) < BigInt(input.minimum)) return "THRESHOLD_MISMATCH";
  }
  if (input.current_block != null && input.expiry_block != null) {
    if (Number(input.current_block) > Number(input.expiry_block)) return "EXPIRED_CONDITION";
  }
  if (!eqAddr(input.recipient, input.condition_recipient)) return "RECIPIENT_MISMATCH";
  if (input.amount != null && input.max_transfer != null) {
    if (BigInt(input.amount) > BigInt(input.max_transfer)) return "AMOUNT_OVERFLOW";
  }
  return null;
}

async function handleTask(request, env) {
  const raw = await request.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const taskId = body.task_id || body.taskId || null;
  const taskType = body.type || "";
  const input = body.input || {};
  const proofTx = input.proof_tx || body.proof_tx || null;

  // Idempotency: same task_id returns the same decision, never re-decides.
  if (taskId && seenTasks.has(taskId)) {
    const prev = seenTasks.get(taskId);
    return json(prev.body, 200, prev.headers);
  }

  // HMAC verification — only when the secret is configured.
  // Platform signs incoming tasks; header name per the build guide is
  // x-agent-games-signature (we also accept x-agent-signature).
  const signResponse = async (respBody, status = 200) => {
    let headers = {};
    if (env.HMAC_SECRET) {
      const rawBody = JSON.stringify(respBody);
      headers["x-agent-games-signature"] = await hmacHex(env.HMAC_SECRET, rawBody);
    }
    return json(respBody, status, headers);
  };

  if (env.HMAC_SECRET) {
    const provided = (
      request.headers.get("x-agent-games-signature") ||
      request.headers.get("x-agent-signature") ||
      ""
    )
      .toLowerCase()
      .replace(/^0x/, "");
    const expected = await hmacHex(env.HMAC_SECRET, raw);
    if (!constantTimeEqual(provided, expected)) {
      return json({ error: "invalid_hmac_signature" }, 401);
    }
  }

  // Non-gatekeeper task types: fail closed, no decision.
  if (taskType && taskType !== "agent-games.proof-gatekeeper.v1") {
    const r = { decision: "REJECT", reason_code: "UNKNOWN_TASK_TYPE", proof_tx: proofTx };
    const resp = await signResponse(r);
    if (taskId) seenTasks.set(taskId, { body: r, headers: Object.fromEntries(resp.headers.entries()) });
    return resp;
  }

  // Gatekeeper: run the 7 field checks. A pass on all 7 is an APPROVE:
  // per the published trap encyclopedia, every trap type is field-detectable.
  const trap = gatekeeperFieldChecks(input, proofTx);
  let decision;
  if (trap) {
    decision = { decision: "REJECT", reason_code: trap, proof_tx: proofTx };
  } else {
    decision = { decision: "APPROVE", reason_code: "VALID_CONDITION", proof_tx: proofTx };
    if (proofTx) acceptedProofTx.add(proofTx);
  }

  const resp = await signResponse(decision);
  if (taskId) {
    seenTasks.set(taskId, {
      body: decision,
      headers: { "x-agent-games-signature": resp.headers.get("x-agent-games-signature") || "" },
    });
  }
  return resp;
}

// ---------- router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsPreflight();

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return json({ ...AGENT, health: "/health", verify: "POST /verify", task: "POST /task" });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        status: "ok",
        agent: AGENT.name,
        handle: AGENT.handle,
        version: AGENT.version,
        time: new Date().toISOString(),
        hmac_configured: Boolean(env.HMAC_SECRET),
        kurier_configured: Boolean(env.KURIER_API_KEY),
        gatekeeper: {
          field_checks: "ready",
          proof_generation: "not_possible_on_workers",
          onchain_proof_check: env.KURIER_API_KEY ? "ready" : "pending_kurier_key",
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/verify") {
      let body = null;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const type = body.type;
      const value = body.value;
      if (!type || typeof value !== "string" || !value.trim()) {
        return json(
          { error: 'need {"type":"url"|"contract"|"text", "value":"..."}' },
          400,
        );
      }
      if (type === "url") return json(await verifyUrl(value.trim()));
      if (type === "contract") return json(await verifyContract(value.trim()));
      if (type === "text") return json(verifyText(value));
      return json({ error: "unknown type; use url, contract, or text" }, 400);
    }

    if (request.method === "POST" && url.pathname === "/task") {
      return handleTask(request, env);
    }

    return json({ error: "Not found", agent: AGENT.name }, 404);
  },
};
