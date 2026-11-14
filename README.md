# lucax — verification-first agent

Agent for the [Agent Games](https://agentgames.zkverify.io) (zkVerify), Wildcard + Proof Gatekeeper tracks.

- **Agent:** `lucax` · **Handle:** `raraza`
- **Repo:** https://github.com/dakocanvelas/agentlelet
- **Live endpoint:** https://lucax.quasar-allspice.workers.dev (temporary Cloudflare account — see Deploy below)
- **Entry:** free. No wallet connected, no payment anywhere in this repo.

## What lucax does

lucax verifies before it acts. It checks live facts before trusting a claim, and
proves every step with evidence:

- `POST /verify` — real checks, no fake results:
  - `{"type":"url","value":"https://..."}` — fetches the URL, returns status, final URL, content-type, page title.
  - `{"type":"contract","value":"0x..."}` — BSC `eth_getCode` via public RPC, returns code size + SHA-256 of the bytecode, best-effort ERC20 metadata. An EOA returns `no_code_at_address`.
  - `{"type":"text","value":"..."}` — honest answer: a bare claim is not evidence; it tells you what to check instead.
- `POST /task` — Proof Gatekeeper decision engine. Verifies the HMAC signature
  against the raw body, runs the 7 deterministic trap field checks from the
  official trap encyclopedia (VK_SUBSTITUTION, PROOF_REUSED, THRESHOLD_MISMATCH,
  EXPIRED_CONDITION, RECIPIENT_MISMATCH, AMOUNT_OVERFLOW), treats `task_id` as an
  idempotency key (same ID = same decision, never re-decided), and returns the
  platform response shape `{decision, reason_code, proof_tx}` signed with
  `x-agent-games-signature`. **Fail-closed:** a task whose proof cannot be
  confirmed on-chain is REJECTed with `PROOF_UNVERIFIED` — a wrong reject costs
  −3, a wrong approve costs −6.
- `GET /health` — health check for the platform: status, version, and which
  secrets are configured (booleans only, never values).

## Run locally

```bash
npx wrangler dev --local --port 8787
curl localhost:8787/health
```

Copy `.dev.vars.example` to `.dev.vars` for local secrets (gitignored).

## Deploy

```bash
npx wrangler deploy
```

Requires Cloudflare login (`wrangler login`) or an API token. Secrets:

```bash
wrangler secret put HMAC_SECRET      # issued once at agent registration (user holds it)
wrangler secret put KURIER_API_KEY   # free Kurier key (user holds it)
```

Current live deployment is on a **temporary** Cloudflare account created by
`wrangler deploy --temporary` (account "Quasar Allspice"). It works and responds,
but it is not owned by us — for the real entry, redeploy under the user's own
Cloudflare account and update the endpoint URL in the Agent Games dashboard.

## How it works (build context)

- **Stack:** Cloudflare Workers, zero npm dependencies in the worker itself
  (Web APIs only: `fetch`, WebCrypto). Nothing to install, nothing to sleep.
- **Key decisions:**
  1. Verify first, act second — every verdict carries its evidence.
  2. Fail closed — uncertainty is a REJECT, never an APPROVE.
  3. Deterministic field checks before any proof machinery — the 7 traps are
     field comparisons, not AI guesses.
  4. Idempotency on `task_id` — replays return the stored decision.
  5. Secrets only via environment — the repo contains no secret of any kind.
- **What it cannot do (yet):** generate the Groth16 proof for a decision
  (snarkjs test in `test/`) and confirm a proof on-chain via Kurier (needs the
  user's Kurier key). Both are wired as explicit next steps, not claimed as done.
- **What it will never do:** approve a task it cannot verify; sign or spend
  anything; connect a wallet.

## Status

- [x] Wildcard endpoint live + verified (all routes tested against the deployed URL)
- [x] Gatekeeper field checks implemented + tested (all 7 trap codes + idempotency + HMAC)
- [x] snarkjs Groth16 proof generation inside a Worker — **TESTED, FAILS**
  (see `test/SNARKJS-TEST.md`): the Workers runtime disallows dynamic WASM
  compilation (`WebAssembly.compile(): Wasm code generation disallowed by
  embedder`, proven live with an isolated 8-byte probe). Consequence: a
  correct Gatekeeper decision without our proof scores +10 instead of +12–17
  (missing-proof −2, no reliability bonus). Real proofs need an off-Worker
  prover (Node.js host) + the 2 still-unknown circuit input names.
- [ ] Kurier on-chain proof check (needs `KURIER_API_KEY`)
- [ ] Redeploy under the user's own Cloudflare account + paste URL in dashboard
- [ ] Preflight + practice task from the dashboard (user clicks)
