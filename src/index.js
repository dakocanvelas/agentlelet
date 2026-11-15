// lucax — verification-first agent for Agent Games (zkVerify)
// Agent: lucax | Handle: raraza | Repo: https://github.com/dakocanvelas/agentlelet
// Public endpoint for the Wildcard track. No dependencies, Web APIs only.
// Secrets (HMAC_SECRET, KURIER_API_KEY, PROVER_SHARED_SECRET) come from
// environment secrets only — NEVER hardcode them here or in the repo.
//
// Routes:
//   GET  /          agent card
//   GET  /health    health check (used by the Agent Games platform)
//   POST /verify    real verification of a claim: {"type":"url"|"contract"|"text","value":"..."}
//   POST /task      Gatekeeper task endpoint: HMAC verify + 7 trap field checks +
//                   (POST / is accepted as an alias: the platform's signed
//                   preflight on save posts the envelope to the base URL.)
//                   Groth16 proof via the external Node prover + idempotency +
//                   decision. Response shape matches the platform spec:
//                   {decision, reason_code, proof_tx, proof, public_signals},
//                   signed with x-agent-games-signature when HMAC_SECRET is set.
//
// Gatekeeper decision logic (from the official trap encyclopedia, event page
// /events/proof-gatekeeper): the 7 checks are deterministic field comparisons,
// and the page states all trap types are documented and field-detectable.
// Approval therefore rests on the field checks. Proof generation runs OFF
// Workers (see prover/): snarkjs cannot run in a Worker (runtime bans
// dynamic WASM compilation — proven live, see test/SNARKJS-TEST.md). The
// Worker asks the prover for a proof of its decision; the circuit only
// proves CORRECT decisions, so if the prover flips the decision the flip
// is authoritative (the circuit is the referee). If the prover is slow or
// down (>25s), the Worker returns the decision WITHOUT a proof instead of
// timing out — a correct decision without proof still scores +10.
// One honest gap remains: the on-chain confirmation of the task's proof_tx
// via Kurier is not yet wired in; it would catch a proof that is not
// on-chain at all, a case outside the 7 documented trap types. (Needs the
// user's Kurier key — separate next step.)

const AGENT = {
  name: "lucax",
  handle: "raraza",
  version: "0.3.0",
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

// The platform's save preflight requires the endpoint to return signed
// protocol v1-json: every response must be JSON signed with the HMAC
// secret, including GET / and GET /health and error responses. The
// signature is HMAC-SHA256 hex over the exact response body bytes.
async function signedJson(env, obj, status = 200) {
  const body = JSON.stringify(obj);
  let headers = {};
  if (env.HMAC_SECRET) {
    headers["x-agent-games-signature"] = await hmacHex(env.HMAC_SECRET, body);
  }
  return json(obj, status, headers);
}

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
const seenProofTx = new Set(); // EVERY proof_tx ever decided (any decision), for PROOF_REUSED

// Parse an integer field that may arrive as a decimal string, a hex string,
// or a JSON number. Returns a BigInt, or null when the value is absent or
// not a valid integer. A present-but-unparseable value is a malformed task:
// the caller fails CLOSED on that field instead of throwing (a throw would
// 500 the task = timeout, -2, and no decision at all).
function toBigInt(v) {
  if (v === null || v === undefined || v === "") return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

// The 7 deterministic field checks, in the order the trap encyclopedia lists them.
// Returns a reason_code, or null when every field passes.
// (The "7th variety" is VALID_CONDITION itself — approve when all 6 trap
// checks pass. All 6 trap checks are below; the encyclopedia's 7 varieties
// are 6 traps + the valid case.)
function gatekeeperFieldChecks(input, proofTx) {
  const eqAddr = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  if (!eqAddr(input.proof_vk, input.registered_vk)) return "VK_SUBSTITUTION";
  if (proofTx && seenProofTx.has(proofTx)) return "PROOF_REUSED";
  if (input.public_balance != null && input.minimum != null) {
    const bal = toBigInt(input.public_balance);
    const min = toBigInt(input.minimum);
    if (bal === null || min === null || bal < min) return "THRESHOLD_MISMATCH";
  }
  if (input.current_block != null && input.expiry_block != null) {
    // STRICT: current == expiry is EXPIRED. Proven against the real circuit
    // (15 Nov 2026): APPROVE at current==expiry fails the witness assert,
    // so the circuit requires currentBlock < expiryBlock.
    const cur = toBigInt(input.current_block);
    const exp = toBigInt(input.expiry_block);
    if (cur === null || exp === null || cur >= exp) return "EXPIRED_CONDITION";
  }
  if (!eqAddr(input.recipient, input.condition_recipient)) return "RECIPIENT_MISMATCH";
  if (input.amount != null && input.max_transfer != null) {
    const amt = toBigInt(input.amount);
    const cap = toBigInt(input.max_transfer);
    if (amt === null || cap === null || amt > cap) return "AMOUNT_OVERFLOW";
  }
  return null;
}

// Durable reuse memory: the in-memory set only survives while this isolate
// is warm (minutes); rounds are a day apart, so a proof reused from an
// earlier round would be missed. When a KV binding is configured, the
// seen-set also lives in KV (key = proof_tx, value = "1"), so a reuse is
// caught even after a cold start. All KV access fails OPEN to memory-only.
async function syncProofSeenFromKV(env, proofTx) {
  if (!proofTx || !env.SEEN_PROOFS) return;
  try {
    const v = await env.SEEN_PROOFS.get(proofTx);
    if (v !== null) seenProofTx.add(proofTx);
  } catch {
    // KV down: memory-only this task.
  }
}

function recordProofSeen(env, ctx, proofTx) {
  if (!proofTx) return;
  seenProofTx.add(proofTx);
  if (env.SEEN_PROOFS) {
    try {
      const p = env.SEEN_PROOFS.put(proofTx, "1");
      if (ctx && ctx.waitUntil) ctx.waitUntil(p);
      else p.catch(() => {});
    } catch {
      // KV write failure must never fail the task.
    }
  }
}

// Ask the external Node prover (prover/server.mjs) for a Groth16 proof of
// a Gatekeeper decision. Returns the prover's result object on success, or
// null on any failure (caller falls back to the no-proof path). 25s hard
// cap — the platform's task deadline is 60s, and a correct decision
// without a proof still scores +10, so the prover must never eat the task.
async function requestProof(env, taskId, input, decision, proofTx) {
  const url = String(env.PROVER_URL || "").replace(/\/$/, "") + "/prove";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.PROVER_SHARED_SECRET ? { "x-prover-secret": env.PROVER_SHARED_SECRET } : {}),
      },
      body: JSON.stringify({ task_id: taskId, input, decision, proof_tx: proofTx }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.ok || !data.proof || !data.publicSignals) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function handleTask(request, env, ctx) {
  const raw = await request.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return signedJson(env, { error: "invalid JSON body" }, 400);
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

  // Agent Games protocol-v1 signed preflight. Handled before the task
  // HMAC verification on purpose: the preflight proves the endpoint
  // holds the secret by returning a correctly signed response, and the
  // platform verifies that response signature against its own copy of
  // the secret. A wrong stored secret still fails the save, because the
  // platform rejects the response signature. Real tasks below still go
  // through full HMAC verification.
  if (body.type === "agent-games.preflight.v1") {
    if (!env.HMAC_SECRET) {
      return json({ error: "HMAC_SECRET not configured" }, 500);
    }

    const responseBody = {
      ok: true,
      protocolVersion: "v1",
    };

    const rawResponse = JSON.stringify(responseBody);
    const signature = await hmacHex(env.HMAC_SECRET, rawResponse);

    return new Response(rawResponse, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "x-agent-games-signature": signature,
      },
    });
  }

  if (env.HMAC_SECRET) {
    // Accept the documented header plus common variants, and strip
    // common prefixes (0x, sha256=) before comparing. Both sides are
    // lowercased hex.
    const provided = (
      request.headers.get("x-agent-games-signature") ||
      request.headers.get("x-agent-signature") ||
      request.headers.get("x-signature") ||
      request.headers.get("signature") ||
      ""
    )
      .toLowerCase()
      .replace(/^(0x|sha256=|hmac-sha256=)/, "");
    const expected = (await hmacHex(env.HMAC_SECRET, raw)).toLowerCase();
    if (!constantTimeEqual(provided, expected)) {
      return signedJson(env, { error: "invalid_hmac_signature" }, 401);
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
  // First sync the durable seen-set: a proof reused from an earlier round
  // (cold isolate, empty memory) must still be caught as PROOF_REUSED.
  await syncProofSeenFromKV(env, proofTx);
  const trap = gatekeeperFieldChecks(input, proofTx);
  let decision = trap
    ? { decision: "REJECT", reason_code: trap, proof_tx: proofTx }
    : { decision: "APPROVE", reason_code: "VALID_CONDITION", proof_tx: proofTx };

  // Groth16 proof via the external Node prover (prover/server.mjs). The
  // circuit only proves CORRECT decisions, so a prover flip is
  // authoritative — use the prover's decision + reason_code when present.
  // On prover failure/timeout the decision stands WITHOUT a proof.
  if (env.PROVER_URL && taskId) {
    const proof = await requestProof(env, taskId, input, decision.decision, proofTx);
    if (proof) {
      decision = {
        decision: proof.decision,
        reason_code: proof.reason_code,
        proof_tx: proofTx,
        proof: proof.proof,
        public_signals: proof.publicSignals,
      };
    }
  }

  // Record EVERY decided proof_tx as seen — not only APPROVEd ones. The
  // encyclopedia's "already accepted" covers the common case, but the build
  // checklist demands a seen-set, and a proof reused after a rejection is
  // still a reuse: recording all decisions can only catch more traps, and
  // a genuinely fresh task always carries a fresh proof_tx.
  recordProofSeen(env, ctx, proofTx);

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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsPreflight();

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return signedJson(env, { ...AGENT, health: "/health", verify: "POST /verify", task: "POST /task" });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return signedJson(env, {
        status: "ok",
        agent: AGENT.name,
        handle: AGENT.handle,
        version: AGENT.version,
        time: new Date().toISOString(),
        hmac_configured: Boolean(env.HMAC_SECRET),
        kurier_configured: Boolean(env.KURIER_API_KEY),
        kv_configured: Boolean(env.SEEN_PROOFS),
        gatekeeper: {
          field_checks: "ready",
          proof_generation: env.PROVER_URL ? "external_prover" : "not_configured (no-proof +10 path)",
          prover_configured: Boolean(env.PROVER_URL),
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

    // POST /task is the documented task endpoint. POST / is also accepted:
    // the platform's signed preflight on save posts the task envelope to
    // the base URL as entered, and a 404 there fails the save silently.
    if (request.method === "POST" && (url.pathname === "/task" || url.pathname === "/" || url.pathname === "")) {
      return handleTask(request, env, ctx);
    }

    return json({ error: "Not found", agent: AGENT.name }, 404);
  },
};
