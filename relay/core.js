// PUMPMATCH feed core: turns pump.fun's program logs into a live list of launches with what happened since.
// Runs the same in Node (dev-relay.mjs) and in the Cloudflare Worker (worker.js). Needs Buffer (node:buffer).
import { Buffer } from "node:buffer"

export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
const D_TRADE = "bddb7fd34ee661ee", D_CREATE = "1b72a94ddeeb6376", D_DONE = "5f72619cd42e9808"
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
export function b58(buf) { let n = 0n; for (const x of buf) n = n * 256n + BigInt(x); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n } for (const x of buf) { if (x) break; s = "1" + s } return s }
const u64 = (b, o) => Number(b.readBigUInt64LE(o))
function str(b, o) { const n = b.readUInt32LE(o); return [b.subarray(o + 4, o + 4 + n).toString("utf8"), o + 4 + n] }

const KEEP_MS = 65 * 60_000       // launches older than this leave the feed (the anti-vamp window is 60 min)
const MAX = 3000

export class Feed {
  constructor() { this.coins = new Map(); this.seq = 0; this.events = 0; this.pinned = new Set(); this.tape = []; this.imgs = new Map(); this.caught = []; this.news = [] }   // news: graduations and copies, for the floor's bells   // imgs: image sha256 -> first mint; caught: [at, copy mint, original mint, why]   // tape = the latest launches and real trades, for the live bar   // pinned = launched on vetted, kept for good

  // one websocket message's logs (a single transaction)
  onLogs(logs, slot) {
    this.events++
    for (const l of logs) {
      if (!l.startsWith("Program data: ")) continue
      const b = Buffer.from(l.slice(14), "base64")
      if (b.length < 8) continue
      const d = b.subarray(0, 8).toString("hex")
      try {
        if (d === D_CREATE) this.onCreate(b, slot)
        else if (d === D_TRADE && b.length >= 225) this.onTrade(b, slot)
        else if (d === D_DONE) { const c = this.coins.get(b58(b.subarray(40, 72))); if (c && !c.done) { c.done = true; c.seq = ++this.seq; this.say({ k: "grad", m: c.mint, s: c.symbol, at: Date.now() }) } }
      } catch {}
    }
  }
  onCreate(b, slot) {
    let o = 8, name, symbol, uri
    ;[name, o] = str(b, o); [symbol, o] = str(b, o); [uri, o] = str(b, o)
    const mint = b58(b.subarray(o, o + 32)); o += 32
    o += 32                                             // bonding curve
    const user = b58(b.subarray(o, o + 32)); o += 32
    const creator = b58(b.subarray(o, o + 32)); o += 32
    o += 8                                              // timestamp
    const vTok = u64(b, o) / 1e6, vSol = u64(b, o + 8) / 1e9, rTok = u64(b, o + 16) / 1e6
    this.coins.set(mint, {
      mint, name: name.slice(0, 40), symbol: symbol.slice(0, 16), uri: uri.slice(0, 300), dev: creator || user, at: Date.now(), slot,
      vSol, vTok, rTok0: rTok || 793_100_000, rTok, rSol: 0, done: false,
      buys: 0, sells: 0, buyers: new Set(), vol: 0, recent: [],
      devTok: 0, devPeak: 0, devBuySol: 0, devSellSol: 0, bundle: new Set(), bundleTok: 0,
      meta: null, metaTried: 0, seq: ++this.seq, ticks: [],
    })
    if (this.coins.size > MAX) { for (const k of this.coins.keys()) { if (!this.pinned.has(k)) { this.coins.delete(k); break } } }
    const prev = this.vamp(name, symbol).filter((h) => h.mint !== mint)[0]
    if (prev) this.markCopy(this.coins.get(mint), prev.mint, prev.ticker ? "ticker" : "name")
    this.tape.push({ k: "c", w: (creator || user).slice(0, 6), s: symbol.slice(0, 12), m: mint, img: null, at: Date.now() }); if (this.tape.length > 60) this.tape.shift()
  }
  onTrade(b, slot) {
    const c = this.coins.get(b58(b.subarray(8, 40)))
    if (!c) return
    const sol = u64(b, 40) / 1e9, tok = u64(b, 48) / 1e6, buy = b[56] === 1, user = b58(b.subarray(57, 89))
    if (!(sol > 0)) return                              // routed swaps without an amount
    c.vSol = u64(b, 97) / 1e9; c.vTok = u64(b, 105) / 1e6; c.rSol = u64(b, 113) / 1e9; c.rTok = u64(b, 121) / 1e6
    c.vol += sol
    c.ticks.push([Date.now(), c.vTok > 0 ? c.vSol / c.vTok : 0, +sol.toFixed(4), buy ? 1 : 0]); if (c.ticks.length > 4000) c.ticks.splice(0, 1000)
    c.peak = Math.max(c.peak || 0, c.vTok > 0 ? (c.vSol / c.vTok) * 1e9 : 0)
    if (buy) { c.buys++; c.buyers.add(user) } else c.sells++
    if (sol >= 0.1) { this.tape.push({ k: buy ? "b" : "s", w: user.slice(0, 6), s: c.symbol.slice(0, 12), m: c.mint, sol: +sol.toFixed(3), at: Date.now() }); if (this.tape.length > 60) this.tape.shift() }
    if (user === c.dev) {
      if (buy) { c.devTok += tok; c.devBuySol += sol } else { c.devTok = Math.max(0, c.devTok - tok); c.devSellSol += sol }
      c.devPeak = Math.max(c.devPeak, c.devTok)
    } else {
      if (buy && slot === c.slot) { c.bundle.add(user); c.bundleTok += tok }
      c.recent.push([Date.now(), buy ? sol : -sol])
      if (c.recent.length > 300) c.recent.shift()
    }
    c.seq = ++this.seq
  }
  // drop launches older than the window; returns them so their outcome can go into the dev's record
  prune() { const cut = Date.now() - KEEP_MS, out = []; for (const [k, c] of this.coins) { if (c.at >= cut) break; if (!this.pinned.has(k)) { this.coins.delete(k); out.push(c) } } return out }
  // how a launch turned out after its first hour, for the dev's permanent record
  outcome(c) {
    return { m: c.mint, s: c.symbol, t: c.at, g: c.done ? 1 : 0, d: c.devPeak > 0 && c.devTok < c.devPeak * 0.5 ? 1 : 0, p: +(c.peak || 0).toFixed(1), b: c.buyers.size, bu: +((c.bundleTok / 1e9) * 100).toFixed(1) }
  }
  say(e) { this.news.push(e); if (this.news.length > 80) this.news.shift() }
  markCopy(c, orig, why) {
    if (!c || c.copyOf) return
    const o = this.coins.get(orig)
    c.copyOf = { mint: orig, symbol: o ? o.symbol : "", why }
    this.caught.push([Date.now(), c.mint, orig, why]); if (this.caught.length > 5000) this.caught.splice(0, 1000)
    this.say({ k: "copy", m: c.mint, s: c.symbol, of: c.copyOf.symbol, why, at: Date.now() })
  }
  // an image's content hash: identical re-uploads of another coin's art are copies
  onImage(c, hash) {
    c.imgHash = hash
    const first = this.imgs.get(hash)
    if (first && first !== c.mint && this.coins.has(first) && this.coins.get(first).at < c.at) this.markCopy(c, first, "image")
    else if (!first) this.imgs.set(hash, c.mint)
    if (this.imgs.size > 8000) this.imgs.delete(this.imgs.keys().next().value)
  }
  imageHit(hash) { const m = this.imgs.get(hash), c = m && this.coins.get(m); return c && Date.now() - c.at < 3600_000 ? { mint: c.mint, symbol: c.symbol, name: c.name, at: c.at } : null }
  caughtSince(ms) { const cut = Date.now() - ms; return this.caught.filter((x) => x[0] >= cut).length }
  // anti-vamp: launches in the last hour with the same ticker or name (case, spacing and symbols ignored)
  vamp(name, symbol) {
    const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9À-￿]/g, "")
    const n = norm(name), sy = norm(symbol), cut = Date.now() - 60 * 60_000, hits = []
    for (const c of this.coins.values()) {
      if (c.at < cut) continue
      const t = !!sy && norm(c.symbol) === sy, nm = !!n && norm(c.name) === n
      if (t || nm) hits.push({ mint: c.mint, symbol: c.symbol, name: c.name, at: c.at, ticker: t, name_: nm, why: t ? "ticker" : "name", buyers: c.buyers.size })
    }
    return hits.sort((a, b) => a.at - b.at)
  }

  // the live board survives a restart: board-worthy coins (and every coin launched here), compact
  snapshot(n = 300) {
    const pick = [...this.coins.values()].filter((c) => this.pinned.has(c.mint) || (!c.done && c.buyers.size >= 3))
      .sort((a, b) => (b.ticks.at(-1)?.[0] || b.at) - (a.ticks.at(-1)?.[0] || a.at)).slice(0, n)
    return pick.map((c) => {
      const o = {}
      for (const [k, v] of Object.entries(c)) if (typeof v !== "object" || v === null) o[k] = v
      o.buyersN = c.buyers.size; o.bundleN = c.bundle.size
      o.recent = c.recent.slice(-40); o.ticks = c.ticks.slice(-40); o.meta = c.meta; o.copyOf = c.copyOf || null
      return o
    })
  }
  restoreSnap(list, caught) {
    const cut = Date.now() - KEEP_MS
    for (const o of (list || []).filter((x) => x && x.at >= cut).sort((a, b) => a.at - b.at)) {
      if (this.coins.has(o.mint)) continue
      const { buyersN = 0, bundleN = 0, ...rest } = o
      const c = { ...rest, buyers: new Set(), bundle: new Set(), recent: o.recent || [], ticks: o.ticks || [], meta: o.meta || null, copyOf: o.copyOf || undefined, seq: ++this.seq }
      for (let i = 0; i < buyersN; i++) c.buyers.add("~" + i)      // counts carry over; the wallets themselves aren't kept
      for (let i = 0; i < bundleN; i++) c.bundle.add("~" + i)
      if (!c.copyOf) delete c.copyOf
      this.coins.set(c.mint, c)
      if (c.imgHash && !this.imgs.has(c.imgHash)) this.imgs.set(c.imgHash, c.mint)
    }
    if (Array.isArray(caught)) this.caught = caught.filter((x) => x[0] >= Date.now() - 86400_000).map((x) => [x[0], "", "", x[1]]).concat(this.caught)
    this.restored = this.coins.size
  }

  // what a card needs; price and market cap in SOL (the page multiplies by the SOL price)
  view(c) {
    const now = Date.now(), price = c.vTok > 0 ? c.vSol / c.vTok : 0
    const r5 = c.recent.filter((x) => now - x[0] < 300_000)
    return {
      mint: c.mint, name: c.name, symbol: c.symbol, dev: c.dev, at: c.at,
      mc: +(price * 1e9).toFixed(3), price, vSol: c.vSol, vTok: c.vTok, prog: c.done ? 100 : +Math.max(0, Math.min(100, (1 - c.rTok / c.rTok0) * 100)).toFixed(1), done: c.done,
      buys: c.buys, sells: c.sells, buyers: c.buyers.size, vol: +c.vol.toFixed(3),
      flow5: +r5.reduce((s, x) => s + x[1], 0).toFixed(3),                      // net SOL from wallets other than the dev, last 5 min
      devPct: +((c.devTok / 1e9) * 100).toFixed(2), devSold: c.devPeak > 0 && c.devTok < c.devPeak * 0.5, devBuy: +c.devBuySol.toFixed(3), devSell: +c.devSellSol.toFixed(3),
      bundle: c.bundle.size, bundlePct: +((c.bundleTok / 1e9) * 100).toFixed(2),
      img: c.meta?.image || null, desc: c.meta?.description || "", x: c.meta?.twitter || "", web: c.meta?.website || "", tg: c.meta?.telegram || "",
      seq: c.seq, copyOf: c.copyOf || null,
    }
  }
  // the deck: live coins worth a look (a few real buyers, still on the curve, a sane SOL market cap)
  deck(limit = 60) {
    const out = []
    for (const c of this.coins.values()) {
      const v = this.view(c)
      if (v.done || v.buyers < 3 || v.mc < 15 || v.mc > 800 || Date.now() - c.at < 8000) continue
      out.push(v)
    }
    out.sort((a, b) => b.at - a.at)
    return out.slice(0, limit)
  }
  // coins whose launch metadata (image, description, links) we still need
  wantMeta(n = 6) {
    const out = []
    for (const c of this.coins.values()) if (!c.meta && c.metaTried < 3 && c.buyers.size >= 2 && Date.now() - (c.metaAt || 0) > 15000) out.push(c)
    return out.slice(-n)
  }
}

// a coin's launch JSON (image, description, socials) from IPFS; pump.fun's own gateway first
const GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://dweb.link/ipfs/", "https://ipfs.io/ipfs/"]
export const cidOf = (u) => (typeof u === "string" ? u.match(/\/ipfs\/([A-Za-z0-9]{40,80})/)?.[1] || u.match(/^ipfs:\/\/([A-Za-z0-9]{40,80})/)?.[1] || null : null)
export async function fetchMeta(c, feed) {
  c.metaTried++; c.metaAt = Date.now()
  const cid = cidOf(c.uri)
  const urls = cid ? GATEWAYS.map((g) => g + cid) : c.uri.startsWith("http") ? [c.uri] : []
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } })
      if (!r.ok) continue
      const j = await r.json()
      const imgCid = cidOf(j.image)
      c.meta = { image: imgCid ? "https://pump.mypinata.cloud/ipfs/" + imgCid : typeof j.image === "string" && j.image.startsWith("https://") ? j.image : null,
        description: String(j.description || "").slice(0, 280), twitter: String(j.twitter || "").slice(0, 200), website: String(j.website || "").slice(0, 200), telegram: String(j.telegram || "").slice(0, 200) }
      c.seq = Date.now()
      if (c.meta.image && feed) {
        // pump.fun's gateway refuses files pinned elsewhere; Pinata's public one serves them
        const ic = cidOf(c.meta.image), tries = ic ? [c.meta.image, "https://gateway.pinata.cloud/ipfs/" + ic] : [c.meta.image]
        for (const u of tries) {
          try {
            const ir = await fetch(u, { signal: AbortSignal.timeout(6000) })
            if (!ir.ok || !/^image\//.test(ir.headers.get("content-type") || "")) continue
            const buf = new Uint8Array(await ir.arrayBuffer())
            c.meta.image = u
            if (buf.length < 4_000_000) feed.onImage(c, Buffer.from(await crypto.subtle.digest("SHA-256", buf)).toString("hex"))
            break
          } catch {}
        }
      }
      return
    } catch {}
  }
}

// a dev's recent launches and how they ended (newest first), from the dev wallet's own transactions
export async function devHistory(rpc, wallet, scan = 120) {
  const sigs = await rpc("getSignaturesForAddress", [wallet, { limit: scan }])
  const ok = (sigs || []).filter((s) => !s.err)
  const created = []
  let i = 0
  const work = async () => {
    while (i < ok.length) {
      const s = ok[i++]
      try {
        const t = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1 }])
        for (const l of t?.meta?.logMessages || []) {
          if (!l.startsWith("Program data: ")) continue
          const b = Buffer.from(l.slice(14), "base64")
          if (b.subarray(0, 8).toString("hex") !== D_CREATE) continue
          let o = 8, name, symbol; [name, o] = str(b, o); [symbol, o] = str(b, o); [, o] = str(b, o)
          created.push({ mint: b58(b.subarray(o, o + 32)), symbol: symbol.slice(0, 16), t: (s.blockTime || 0) * 1000 })
        }
      } catch {}
    }
  }
  await Promise.all([work(), work(), work(), work()])
  return { scanned: ok.length, launches: created.sort((a, b) => b.t - a.t) }
}
