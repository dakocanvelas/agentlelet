# lucax — verification-first agent

Agent for the [Agent Games](https://agentgames.zkverify.io) (zkVerify), Wildcard + Proof Gatekeeper tracks.

- **Agent:** `lucax` · **Handle:** `raraza`
- **Repo:** https://github.com/dakocanvelas/agentlelet
- **Live endpoint:** https://lucax.joniyasolaqq.workers.dev (user's own Cloudflare account, deployed 2026-11-15 via the Cloudflare API token `agent-games-worker`; health 200 verified). Old temporary endpoint https://lucax.quasar-allspice.workers.dev is dead.
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
  idempotency key (same ID = same decision, never re-decided), then asks the
  external Node prover (`prover/`) for a Groth16 proof of the decision and
  returns `{decision, reason_code, proof_tx, proof, public_signals}` signed
  with `x-agent-games-signature`. **Fail-closed:** uncertainty is a REJECT,
  never an APPROVE; if the prover is slow or down (>25s) the decision is
  returned WITHOUT a proof rather than risking the 60s task deadline (a
  correct decision without proof still scores +10). The circuit only proves
  correct decisions, so a prover flip of the decision is authoritative.
  (One honest gap: the on-chain confirmation of the task's `proof_tx` via
  Kurier is NOT yet wired — it needs the user's Kurier key. The code does
  not reject tasks for an unverified proof_tx today.)
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

Current live deployment is on the **user's own** Cloudflare account
("Joniyasolaqq@gmail.com's Account", deployed 2026-11-15 via the API token
`agent-games-worker` + `~/workspace/custom-connectors/custom.cloudflare/bin/cf.py`).
The old temporary account ("Quasar Allspice") endpoint is dead. Secrets are
not set yet: HMAC_SECRET (user holds it) and KURIER_API_KEY (not created yet)
— without them the Worker runs the no-proof +10 path. Next: set the secrets,
then paste the new endpoint URL in the Agent Games dashboard.

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
- **What it cannot do (yet):** confirm a proof on-chain via Kurier (needs the
  user's Kurier key — the remaining next step). Groth16 proof generation is
  SOLVED via the external Node prover in `prover/` (see below).
- **What it will never do:** approve a task it cannot verify; sign or spend
  anything; connect a wallet.

## Gatekeeper proofs — solved 15 Nov 2026 (see `test/SNARKJS-TEST.md`)

- **All 13 circuit inputs recovered.** The 2 missing names were found by
  extracting the FNV-1a signal hashes from the WASM data section and
  dictionary-attacking them: `registeredVkHash` and `proofVkHash` (the
  VK-substitution check lives inside the circuit). Verified against the
  real WASM with the probe method, then proven end-to-end.
- **Node prover works:** `groth16.fullProve` on the real artifacts takes
  **0.5–2.1s per proof** and verifies `true` against the real vkey — well
  inside the 60s task window. 15-case matrix tested: correct decisions
  prove, wrong decisions fail witness generation in ~100ms (the circuit
  only proves correct decisions), all 5 trap types + VK mismatch behave
  correctly. Boundary found: expiry is STRICT — `currentBlock ==
  expiryBlock` must REJECT (the Worker's field check was fixed to `>=`).
- **Workers cannot prove, proven live twice:** a pre-compiled WASM module
  DOES instantiate in a Worker (`/wasmmodule`: `getInputSize()=13`), but
  snarkjs still fails because **ffjavascript compiles its own curve WASM
  at first use** with no pure-JS fallback (`/snarkjs-precompiled`:
  `FFJAVASCRIPT_BLOCKER_CONFIRMED`). Fixing that would mean forking
  ffjavascript/wasmcurves — not viable. Hence the external prover.
- **Wiring:** `prover/` is a zero-dependency Node HTTP service (`POST
  /prove`, `GET /health`). Deploy free on Render (see `prover/README.md`,
  `render.yaml`): free tier + a keep-alive ping every 10 min (it sleeps
  after 15 min idle; cold start ~60s would blow the task budget). The
  Worker calls it with a 25s cap and falls back to the no-proof path on
  failure. Fly.io has no free tier for new accounts (only a $1/7-day
  trial; cheapest always-on ~$2.19/mo, bills under $5 waived — but a card
  is required), so it is NOT the free recommendation. Vercel Hobby
  (10s function limit) is a viable free alternative with less headroom.
- **Deploy the prover:** push the repo, Render → New → Blueprint, set
  `PROVER_SHARED_SECRET` in Render, then `wrangler secret put
  PROVER_SHARED_SECRET` (same value) + set `PROVER_URL` in
  `wrangler.toml` `[vars]`.

## Status

- [x] Wildcard endpoint live + verified (all routes tested against the deployed URL)
- [x] Gatekeeper field checks implemented + tested (all 7 trap codes + idempotency + HMAC)
- [x] snarkjs Groth16 proof generation inside a Worker — **TESTED, FAILS**
  (see `test/SNARKJS-TEST.md`): the Workers runtime disallows dynamic WASM
  compilation (`WebAssembly.compile(): Wasm code generation disallowed by
  embedder`, proven live with an isolated 8-byte probe). A pre-compiled
  WASM module DOES instantiate, but snarkjs still fails — ffjavascript
  compiles its own curve WASM at first use, no pure-JS fallback.
- [x] All 13 circuit inputs recovered (`registeredVkHash`, `proofVkHash`)
  + Node prover built and tested end-to-end (0.5–2.1s/proof, verifies
  `true`; Worker↔prover integration tested locally incl. flip cases,
  expiry-boundary fix, idempotency). See `prover/README.md`.
- [ ] Deploy the prover (Render free, `prover/render.yaml`) + set
  `PROVER_URL` + `PROVER_SHARED_SECRET` on the Worker
- [ ] Kurier on-chain proof check (needs `KURIER_API_KEY`)
- [x] Redeploy under the user's own Cloudflare account (2026-11-15, https://lucax.joniyasolaqq.workers.dev, health 200) + paste URL in dashboard (still TODO)
- [ ] Preflight + practice task from the dashboard (user clicks)
