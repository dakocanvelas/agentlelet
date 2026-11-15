// GET /api/health — prover liveness + artifact check (Vercel adapter).
import fs from "node:fs";

export default function handler(req, res) {
  let artifacts = false;
  try {
    artifacts =
      fs.existsSync(new URL("../gatekeeper.wasm", import.meta.url)) &&
      fs.existsSync(new URL("../gatekeeper_final.zkey", import.meta.url));
  } catch {
    artifacts = false;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      service: "lucax-gatekeeper-prover",
      version: "0.1.0",
      runtime: "vercel",
      artifacts,
      time: new Date().toISOString(),
    })
  );
}
