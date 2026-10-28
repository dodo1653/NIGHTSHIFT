// Local relay for building the site: node relay/dev.mjs  ->  http://127.0.0.1:8791/v1/board
import http from "node:http"
import { createRelay } from "./server.js"

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com"
const mem = new Map()
const relay = createRelay({
  rpcUrl: RPC,
  publicUrl: "http://127.0.0.1:" + (process.env.PORT || 8792),
  store: { get: async (k) => mem.get(k), put: async (k, v) => { mem.set(k, v) } },
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
}).listen(+(process.env.PORT || 8792), "127.0.0.1", () => console.log("floor dev relay on http://127.0.0.1:" + (process.env.PORT || 8792)))
