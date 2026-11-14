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
node server.mjs           # :3000 — GET /health, POST /prove (localhost only without a secret)
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

## Deploy (free alternative) — Vercel Hobby

Same `server.mjs` logic as `api/prove.js` (Node serverless function, 10s
limit — a ~1s proof fits, but with less headroom than Render). Not
built here; Render is the primary recommendation because it is a plain
long-running Node process with no per-request time limit.

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

- `server.mjs` — zero-dependency HTTP server (snarkjs is the only dep).
- `checks.mjs` — the 7 field checks (mirrors the Worker; expiry is STRICT:
  `currentBlock >= expiryBlock` is EXPIRED — proven against the circuit).
- `fetch-artifacts.sh` — downloads + sha256-verifies the real circuit
  artifacts from the official site.
- `Dockerfile`, `render.yaml` — free deployment.
- `gatekeeper.wasm`, `gatekeeper_final.zkey` — downloaded at build time,
  never committed (see `.gitignore`).
