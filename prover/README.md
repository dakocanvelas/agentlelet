# lucax Gatekeeper prover

Off-Worker Groth16 proving service for the Agent Games Proof Gatekeeper
circuit. Plain Node.js — snarkjs cannot run in Cloudflare Workers (the
runtime bans dynamic `WebAssembly.compile`, and snarkjs/ffjavascript
compile WASM at first use with no pure-JS fallback; proven live — see
`../test/SNARKJS-TEST.md` and the `/wasmmodule` + `/snarkjs-precompiled`
endpoints on the test Worker).

## What it does

`POST /prove` with `{ task_id, input, decision, proof_tx }` (the task
envelope input + the Worker's field-check decision) returns
`{ ok, decision, reason_code, flipped, proof, publicSignals, ms }`.

The circuit **only proves correct decisions** — a wrong decision fails
witness generation in ~100ms. The prover tries the requested decision
first; on assert failure it tries the flipped decision and returns
whichever proves. A flipped result means the caller's field checks
disagreed with the circuit (the circuit is the referee).

Measured locally (Node 24, this sandbox): first proof ~2.1s (warmup),
then **0.5–0.8s per proof**, verified `true` against the real vkey.
Well inside the 60s task window.

## Run locally

```bash
npm install
npm run fetch-artifacts   # downloads wasm+zkey from agentgames.zkverify.io, verifies sha256
node standalone/server.mjs  # :3000 — GET /health, POST /prove (localhost only without a secret)
```

Test a proof:

```bash
curl -s localhost:3000/prove -X POST -H 'content-type: application/json' -d '{
  "task_id": "gk_test_1",
  "decision": "APPROVE",
  "input": {
    "registered_vk": "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
    "proof_vk": "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
    "minimum": "1000", "public_balance": "1460",
    "expiry_block": 19842201, "current_block": 19832000,
    "recipient": "0xDe42000000000000000000000000000000009f01",
    "condition_recipient": "0xDe42000000000000000000000000000000009f01",
    "amount": "500", "max_transfer": "1000"
  }
}'
```

## Deploy (free) — Render

1. Push this repo to GitHub (user's account).
2. Render dashboard → New → Blueprint → select the repo (uses `render.yaml`).
3. Set env var `PROVER_SHARED_SECRET` in Render to a long random string.
4. Set the same value as a Worker secret: `wrangler secret put PROVER_SHARED_SECRET`
   (and `PROVER_URL=https://<your-render-service>.onrender.com` — set in
   `wrangler.toml` `[vars]` or as a Worker variable, never in the repo).
5. Keep it warm: the free tier sleeps after 15 min idle and takes ~60s to
   wake — that alone would blow the 60s task budget. Ping `GET /health`
   every 10 min (Cloudflare cron trigger on the Worker, or UptimeRobot
   free). The Worker treats a slow prover (>25s) as "no proof" and falls
   back to the +10 no-proof path — it never lets the prover eat the task.

## Deploy (free, no card) — Vercel Hobby

BUILT 15 Nov 2026 (`api/prove.js` + `api/health.js` + `vercel.json`) — Render turned out to REQUIRE a credit card for identity verification even on the Free tier (verified live 15 Nov), so Vercel Hobby is the card-free route: free forever, no card required, personal non-commercial use. Same proving flow as `standalone/server.mjs` (prove-or-flip, local vkey verification, shared-secret auth). Hobby limit: 10s per invocation — a proof takes 0.5–2.1s (measured locally), so it fits, but a cold start eats into the budget; the Worker treats a slow prover as "no proof" and falls back to +10. Deploy: import the repo in Vercel, Root Directory `prover`, Install Command `npm install --omit=dev`, Build Command `bash fetch-artifacts.sh`, env `PROVER_SHARED_SECRET` (same value as the Worker secret), then the service is live at `https://<project>.vercel.app` (`/api/prove`, `/api/health`). Tested locally 15 Nov: health ok, APPROVE 1067ms, flip-to-REJECT 391ms, wrong/missing secret → 401. Vercel lesson (15 Nov): the standalone server MUST NOT live at the Vercel root — Vercel auto-detects `server.{js,mjs}` at the project root as the entrypoint and routes ALL requests to it, so `api/` functions never build (verified live: `/api/health` 404'd from `server.mjs`, `/health` artifacts false). That is why it lives in `standalone/`. Framework Preset stays `Node` (preset `Other` fails the build with `STATIC_BUILD_NO_OUT_DIR` — it wants a `public` output dir).

## What it does NOT do

- No HMAC secret, no Kurier key, no wallet, no funds. The prover only
  turns task fields into a Groth16 proof.
- It does NOT submit the proof to zkVerify/Kurier (that needs the user's
  Kurier API key — separate next step). The Worker returns the proof +
  `public_signals` in its task response for the platform to re-verify.
- It does NOT decide by itself: the Worker runs the 7 field checks first
  and only asks for a proof of that decision (the flip is a safety net
  for field-check/circuit disagreements, e.g. the expiry boundary).

## Files

- `standalone/server.mjs` — zero-dependency HTTP server (snarkjs is the only dep).
- `checks.mjs` — the 7 field checks (mirrors the Worker; expiry is STRICT:
  `currentBlock >= expiryBlock` is EXPIRED — proven against the circuit).
- `fetch-artifacts.sh` — downloads + sha256-verifies the real circuit
  artifacts from the official site.
- `Dockerfile`, `render.yaml` — free deployment.
- `gatekeeper.wasm`, `gatekeeper_final.zkey` — downloaded at build time,
  never committed (see `.gitignore`).
