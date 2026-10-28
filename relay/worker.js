// Nightshift relay on Cloudflare: one Durable Object keeps the pump.fun log stream open (RPC_URL secret = a Helius or
// other RPC that accepts Workers; Solana's public endpoint refuses them), keeps the dev database in its storage and
// serves the board, reputation, anti-vamp, launch metadata and transaction relay.
import { DurableObject } from "cloudflare:workers"
import { createRelay } from "./server.js"

const IDLE_MS = 20 * 60_000, TICK_MS = 15_000   // the alarm counts against the free plan's 100k Durable Object requests a day (shared by every relay on the account)

export default {
  async fetch(req, env) { return env.RELAY.get(env.RELAY.idFromName("nightshift-1")).fetch(req) },
}

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.lastReq = 0; this.ws = null
    const storage = ctx.storage
    this.relay = createRelay({
      rpcUrl: env.RPC_URL,
      publicUrl: env.PUBLIC_URL || "https://nightshift-relay.vetted-relay.workers.dev",
      siteUrl: env.SITE_URL || undefined,
      store: { get: (k) => storage.get(k), put: (k, v) => storage.put(k, v) },
      openSocket: (onOpen, onMsg, onClose) => {
        if (this.ws) return
        this.ws = "connecting"
        ;(async () => {
          try {
            const resp = await fetch(env.RPC_URL, { headers: { Upgrade: "websocket" } })
            const ws = resp.webSocket; if (!ws) throw new Error("no websocket " + resp.status)
            ws.accept()
            ws.addEventListener("message", (e) => onMsg(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data)))
            const drop = () => { if (this.ws === ws) { this.ws = null; onClose() } }
            ws.addEventListener("close", drop); ws.addEventListener("error", drop)
            this.ws = ws; onOpen(ws)
          } catch (e) { console.log("connect failed", String(e)); this.ws = null }
        })()
      },
    })
    ctx.blockConcurrencyWhile(() => this.relay.restore())
  }
  async alarm() {
    if (Date.now() - this.lastReq > IDLE_MS) { try { if (this.ws && this.ws !== "connecting") this.ws.close() } catch {}; this.ws = null; return }
    if (this.ws && this.ws !== "connecting" && Date.now() - this.relay.lastMsg > 30_000) { try { this.ws.close() } catch {}; this.ws = null }
    if (!this.ws) this.relay.connect()
    await this.relay.tick()
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS)
  }
  async fetch(req) {
    this.lastReq = Date.now()
    if (!this.ws) this.relay.connect()
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 500)
    return this.relay.handle(req)
  }
}
