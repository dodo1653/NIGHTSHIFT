// Local relay for building the site: node relay/dev.mjs  ->  http://127.0.0.1:8791/v1/board
import http from "node:http"
import { createRelay } from "./server.js"

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com"
// storage: a JSON file (launches, seats and images survive a restart); images are kept as base64
import fs from "node:fs"
const FILE = process.env.STORE || new URL("./.data/store.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
fs.mkdirSync(FILE.replace(/[\/][^\/]+$/, ""), { recursive: true })
const mem = new Map()
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(FILE, "utf8")))) mem.set(k, v?.$bytes ? { ...v, bytes: Uint8Array.from(Buffer.from(v.$bytes, "base64")), $bytes: undefined } : v) } catch {}
let dirty = false
setInterval(() => {
  if (!dirty) return; dirty = false
  const o = {}; for (const [k, v] of mem) if (!k.startsWith("snap:")) o[k] = v?.bytes ? { type: v.type, $bytes: Buffer.from(v.bytes).toString("base64") } : v
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(o)); fs.renameSync(FILE + ".tmp", FILE)
}, 2000)
const relay = createRelay({
  rpcUrl: RPC,
  publicUrl: process.env.PUBLIC_URL || "http://127.0.0.1:" + (process.env.PORT || 8792),
  store: { get: async (k) => mem.get(k), put: async (k, v) => { mem.set(k, v); dirty = true } },
  openSocket(onOpen, onMsg, onClose) {
    const ws = new WebSocket(RPC.replace(/^http/, "ws"))
    ws.onopen = () => onOpen(ws)
    ws.onmessage = (e) => onMsg(String(e.data))
    ws.onclose = () => { onClose(); setTimeout(() => relay.connect(), 2000) }
  },
})
relay.restore().then(() => relay.connect())
setInterval(() => relay.tick(), 2000)
http.createServer(async (req, res) => {
  const chunks = []; for await (const ch of req) chunks.push(ch)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  const r = await relay.handle(new Request("http://127.0.0.1:8791" + req.url, { method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }))
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()))
}).listen(+(process.env.PORT || 8792), "127.0.0.1", () => console.log("nightshift dev relay on " + (process.env.PORT || 8792)))
