// garlic relay: the live pump.fun feed + dev reputation + anti-vamp + launch metadata hosting + transaction relay.
// Shared by the Node dev server (dev.mjs) and the Cloudflare Worker (worker.js). `store` is persistent key/value
// storage (Durable Object storage in the Worker, a Map locally).
import { Feed, PUMP, fetchMeta, devHistory } from "./core.js"
import { createFloor } from "./agents.js"

const MAX_RECORDS = 60            // launches kept per dev
const DEEP_TTL = 6 * 3600_000

export function createRelay({ rpcUrl, openSocket, store, publicUrl, siteUrl = "https://nightshift-floor.vercel.app", tokenMint = "" }) {
  const feed = new Feed()
  let sol = 0, solAt = 0, live = false, lastMsg = 0
  const recCache = new Map()      // dev -> records (mirror of the store)
  const deepCache = new Map()
  const pendingPins = new Map()   // mints launched here that the feed hasn't seen yet
  let caughtBase = 0              // copies caught before the last restart (today), from storage

  async function rpc(method, params) {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
        if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 500 * (i + 1))); continue }
        const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result
      } catch (e) { if (i === 3) throw e }
    }
  }
  function connect() {
    openSocket((ws) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP] }, { commitment: "confirmed" }] }))
      live = true
    }, (data) => {
      lastMsg = Date.now()
      let j; try { j = JSON.parse(data) } catch { return }
      const v = j?.params?.result?.value
      if (v && !v.err && v.logs) { feed.onLogs(v.logs, j.params.result.context?.slot || 0); floor.tick().catch(() => {}) }
    }, () => { live = false })
  }

  // ---------------------------------------------------------------- the dev database (grows as the relay watches)
  async function records(dev) {
    if (recCache.has(dev)) return recCache.get(dev)
    const r = (await store.get("dev:" + dev)) || []
    recCache.set(dev, r); if (recCache.size > 20000) recCache.delete(recCache.keys().next().value)
    return r
  }
  async function addRecord(dev, rec) {
    const r = await records(dev)
    if (r.some((x) => x.m === rec.m)) return
    r.unshift(rec); if (r.length > MAX_RECORDS) r.length = MAX_RECORDS
    await store.put("dev:" + dev, r)
  }

  // ---------------------------------------------------------------- reputation: a score, a grade and the reasons
  function score({ recs, deep, cur }) {
    const reasons = []
    let s = 60
    const past = recs.filter((x) => !cur || x.m !== cur.mint)
    const day = past.filter((x) => Date.now() - x.t < 86400_000).length
    const grads = past.filter((x) => x.g).length + (deep ? deep.launches.filter((x) => x.grad && !past.some((p) => p.m === x.mint)).length : 0)
    const dumps = past.filter((x) => x.d && !x.g).length
    const dead = past.filter((x) => !x.g && x.p < 45).length + (deep ? deep.launches.filter((x) => x.dead && !past.some((p) => p.m === x.mint) && x.mint !== cur?.mint).length : 0)
    const total = new Set([...past.map((x) => x.m), ...(deep ? deep.launches.map((x) => x.mint) : [])].filter((m) => m !== cur?.mint)).size
    if (grads) { s += Math.min(30, grads * 15); reasons.push(["g", `${grads} past launch${grads > 1 ? "es" : ""} graduated`]) }
    if (dumps) { s -= Math.min(45, dumps * 15); reasons.push(["r", `dumped on buyers ${dumps} time${dumps > 1 ? "s" : ""} (sold most of the dev bag in the first hour)`]) }
    if (dead) { s -= Math.min(40, dead * 8); reasons.push(["r", `${dead} past coin${dead > 1 ? "s" : ""} died on the curve`]) }
    if (day >= 3) { s -= 15; reasons.push(["r", `serial launcher: ${day} launches in the last 24 hours`]) }
    if (!total) reasons.push(["n", deep ? "no earlier launches from this wallet" : "no earlier launches seen from this wallet"])
    if (cur) {
      if (cur.devSold) { s -= 30; reasons.push(["r", "already sold most of the dev bag on this coin"]) }
      else if (cur.devPct >= 20) { s -= 10; reasons.push(["a", `holds ${cur.devPct.toFixed(0)}% of this coin`]) }
      if (cur.bundlePct >= 10) { s -= 15; reasons.push(["a", `${cur.bundlePct.toFixed(0)}% bought by other wallets in the launch block`]) }
    }
    s = Math.max(0, Math.min(100, Math.round(s)))
    const grade = s >= 80 ? "A" : s >= 65 ? "B" : s >= 50 ? "C" : s >= 35 ? "D" : "F"
    return { score: s, grade, reasons, launches: total, grads, dumps, dead, day, deep: !!deep }
  }
  async function deepScan(dev) {
    const hit = deepCache.get(dev); if (hit && Date.now() - hit.at < DEEP_TTL) return hit.body
    const h = await devHistory(rpc, dev, 100)
    const mints = h.launches.slice(0, 30).map((x) => x.mint)
    const pairs = mints.length ? await (await fetch("https://api.dexscreener.com/tokens/v1/solana/" + mints.join(","))).json().catch(() => []) : []
    const best = new Map(); for (const p of Array.isArray(pairs) ? pairs : []) { const m = p.baseToken?.address; if (m && (!best.has(m) || (p.liquidity?.usd || 0) > (best.get(m).liquidity?.usd || 0))) best.set(m, p) }
    const launches = h.launches.slice(0, 30).map((x) => { const p = best.get(x.mint), mc = p ? p.marketCap || p.fdv || 0 : 0, grad = p ? p.dexId !== "pumpfun" : false; return { ...x, grad, mcUsd: Math.round(mc), dead: !grad && mc < 6000 && Date.now() - x.t > 3600_000 } })
    const body = { scanned: h.scanned, launches }
    deepCache.set(dev, { at: Date.now(), body }); if (deepCache.size > 2000) deepCache.delete(deepCache.keys().next().value)
    return body
  }
  async function repFor(dev, mint, deep) {
    const c = mint ? feed.coins.get(mint) : null
    const recs = await records(dev)
    const d = deep ? await deepScan(dev).catch(() => null) : deepCache.get(dev)?.body || null
    return { dev, ...score({ recs, deep: d, cur: c ? feed.view(c) : null }), history: recs.slice(0, 12), deepLaunches: d ? d.launches.slice(0, 12) : null }
  }

  // ---------------------------------------------------------------- the trading floor
  // a coin's dev grade for the agents' filters, cached on the coin for 5 minutes
  async function gradeOf(c) {
    if (c.gradeAt && Date.now() - c.gradeAt < 300_000) return c.grade
    const r = score({ recs: await records(c.dev), deep: deepCache.get(c.dev)?.body || null, cur: feed.view(c) })
    c.grade = r.grade; c.gradeAt = Date.now()
    return r.grade
  }
  // desk multiplier from the wallet's token balance (1 until the token exists)
  const TIERS = [[200_000, 3], [50_000, 2.2], [10_000, 1.5], [1_000, 1]]
  async function tierOf(wallet) {
    if (!tokenMint || !wallet) return 1
    const r = await rpc("getTokenAccountsByOwner", [wallet, { mint: tokenMint }, { encoding: "jsonParsed" }])
    const bal = (r?.value || []).reduce((t, x) => t + (+x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0)
    for (const [min, m] of TIERS) if (bal >= min) return m
    return 1
  }
  const floor = createFloor({ feed, store, gradeOf, tierOf })

  // ---------------------------------------------------------------- the loop
  let ticks = 0
  async function tick() {
    await floor.tick().catch(() => {})
    for (const c of feed.prune()) await addRecord(c.dev, feed.outcome(c)).catch(() => {})
    if (++ticks % 4 === 0) await store.put("caught:" + new Date().toISOString().slice(0, 10), caughtBase + feed.caughtSince(86400_000)).catch(() => {})
    if (ticks % 8 === 0 && feed.coins.size) await saveSnap().catch(() => {})
    if (ticks % 4 === 0) await floor.save().catch(() => {})
    await Promise.all(feed.wantMeta(5).map((c) => fetchMeta(c, feed)))
    for (const [m, at] of pendingPins) { if (feed.coins.has(m)) { feed.pinned.add(m); pendingPins.delete(m) } else if (Date.now() - at > 10 * 60_000) pendingPins.delete(m) }
    if (Date.now() - solAt > 60_000) {
      try { const p = +(await (await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot")).json()).data.amount; if (p > 0) { sol = p; solAt = Date.now() } } catch {}
    }
  }
  // the board in storage, 30 coins a key (a stored value is capped), so a woken relay shows launches at once
  async function saveSnap() {
    const list = feed.snapshot(300), n = Math.ceil(list.length / 30)
    for (let i = 0; i < n; i++) await store.put("snap:" + i, list.slice(i * 30, i * 30 + 30))
    await store.put("snap:n", { n, at: Date.now(), caught: feed.caught.filter((x) => x[0] >= Date.now() - 86400_000).slice(-3000).map((x) => [x[0], x[3]]) })
  }
  async function restore() {   // coins launched here, the copy counter and the last board survive restarts
    await floor.restore().catch(() => {})
    try {
      const head = await store.get("snap:n")
      if (head && Date.now() - head.at < 65 * 60_000) {
        const parts = []
        for (let i = 0; i < head.n; i++) parts.push(...((await store.get("snap:" + i)) || []))
        feed.restoreSnap(parts, head.caught)
      }
    } catch {}
    const day = await store.get("caught:" + new Date().toISOString().slice(0, 10)); caughtBase = day || 0
    if (feed.caught.length) caughtBase = Math.max(0, caughtBase - feed.caughtSince(86400_000))   // the restored list already counts these
    const list = (await store.get("pinned")) || []
    for (const m of list) pendingPins.set(m, Date.now())
  }

  // ---------------------------------------------------------------- requests
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }
  const json = (o, s = 200, cache = "no-store") => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": cache, ...CORS } })
  const isKey = (x) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x || "")
  async function boardRow(c) {
    const v = feed.view(c), recs = await records(c.dev)
    const r = score({ recs, deep: deepCache.get(c.dev)?.body || null, cur: v })
    return { ...v, here: feed.pinned.has(c.mint), grade: r.grade, score: r.score, rep: { launches: r.launches, dumps: r.dumps, dead: r.dead, grads: r.grads, day: r.day } }
  }
  async function handle(req) {
    const u = new URL(req.url)
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
    // launch metadata and images, served for good (this is the coin's `uri`)
    const mm = u.pathname.match(/^\/m\/([a-f0-9]{24})\.json$/), im = u.pathname.match(/^\/i\/([a-f0-9]{24})$/)
    if (mm) { const j = await store.get("meta:" + mm[1]); return j ? new Response(j, { headers: { "content-type": "application/json", "cache-control": "public, max-age=31536000, immutable", ...CORS } }) : json({ error: "not found" }, 404) }
    if (im) { const x = await store.get("img:" + im[1]); return x ? new Response(x.bytes, { headers: { "content-type": x.type, "cache-control": "public, max-age=31536000, immutable", ...CORS } }) : json({ error: "not found" }, 404) }

    if (u.pathname === "/v1/floor") return json({ ...floor.floor(), live, sol, watched: feed.coins.size, news: feed.news.slice(-25), whales: feed.tape.filter((e) => e.k === "b" && e.sol >= 2).slice(-10) })
    if (u.pathname === "/v1/agent") { const a = floor.agent(u.searchParams.get("id") || ""); return a ? json({ ...a, sol }) : json({ error: "not found" }, 404) }
    if (u.pathname === "/v1/modes") return json({ modes: floor.modes, house: floor.house })
    if (u.pathname === "/v1/hire" && req.method === "POST") {
      let b; try { b = await req.json() } catch { return json({ error: "bad json" }, 400) }
      try { return json(await floor.hire({ ...b, ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "" })) } catch (e) { return json({ error: String(e.message || e) }, 400) }
    }
    if (u.pathname === "/v1/board") {
      const n = Math.min(120, +(u.searchParams.get("n") || 80)), rows = []
      for (const c of feed.coins.values()) if (!c.done && c.buyers.size >= 3 && Date.now() - c.at > 6000) rows.push(c)
      const sort = u.searchParams.get("sort") || "bump"
      if (sort === "mc") rows.sort((a, b) => b.vSol / b.vTok - a.vSol / a.vTok)
      else if (sort === "new") rows.sort((a, b) => b.at - a.at)
      else rows.sort((a, b) => (b.ticks.at(-1)?.[0] || b.at) - (a.ticks.at(-1)?.[0] || a.at))   // bump order: latest trade first
      const out = await Promise.all(rows.slice(0, n).map(boardRow))
      const here = await Promise.all([...feed.pinned].map((m) => feed.coins.get(m)).filter(Boolean).sort((a, b) => b.at - a.at).slice(0, 30).map(boardRow))
      const tape = feed.tape.slice(-12).map((e) => ({ ...e, img: feed.coins.get(e.m)?.meta?.image || null }))
      return json({ now: Date.now(), live, sol, coins: out, here, tape, watched: feed.coins.size, caught1h: feed.caughtSince(3600_000), caught24h: feed.caughtSince(86400_000) + (caughtBase || 0) })
    }
    if (u.pathname === "/v1/coin") {
      const c = feed.coins.get(u.searchParams.get("mint") || "")
      if (!c) return json({ error: "unknown" }, 404)
      const row = await boardRow(c)
      const copies = []; for (const x of feed.coins.values()) if (x.copyOf && x.copyOf.mint === c.mint) copies.push({ mint: x.mint, symbol: x.symbol, name: x.name, at: x.at, why: x.copyOf.why, img: x.meta?.image || null })
      return json({ ...row, copies, ticks: u.searchParams.get("ticks") ? c.ticks.slice(-3000) : undefined })
    }
    if (u.pathname === "/v1/rep") {
      const w = u.searchParams.get("wallet"); if (!isKey(w)) return json({ error: "bad wallet" }, 400)
      try { return json(await repFor(w, u.searchParams.get("mint"), !!u.searchParams.get("deep"))) } catch (e) { return json({ error: String(e.message || e) }, 502) }
    }
    if (u.pathname === "/v1/vamp") { const ih = u.searchParams.get("img"); return json({ hits: feed.vamp(u.searchParams.get("name"), u.searchParams.get("symbol")), image: ih && /^[a-f0-9]{64}$/.test(ih) ? feed.imageHit(ih) : null }) }
    if (u.pathname === "/v1/upload" && req.method === "POST") {
      try {
        const b = await req.json()
        const s = (x, n) => String(x || "").trim().slice(0, n)
        const name = s(b.name, 32), symbol = s(b.symbol, 10).replace(/^\$+/, ""), description = s(b.description, 600)
        if (!name || !symbol) return json({ error: "name and ticker are required" }, 400)
        const hits = feed.vamp(name, symbol)
        const ih = /^[a-f0-9]{64}$/.test(String(b.imgHash || "")) ? feed.imageHit(b.imgHash) : null
        if (ih) return json({ error: `that image belongs to ${ih.name} ($${ih.symbol}), launched ${Math.round((Date.now() - ih.at) / 60000)} min ago. garlic refuses copies.`, image: ih }, 409)
        if (hits.length) return json({ error: `a coin called ${hits[0].name} ($${hits[0].symbol}) launched ${Math.round((Date.now() - hits[0].at) / 60000)} min ago. garlic refuses copies for an hour.`, hits }, 409)
        const m = String(b.image || "").match(/^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/)
        if (!m) return json({ error: "the image must be png, jpg, webp or gif" }, 400)
        const bytes = Uint8Array.from(atob(m[3]), (ch) => ch.charCodeAt(0))
        if (bytes.length > 1_900_000) return json({ error: "the image is too large (max 1.9 MB)" }, 400)
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name + "|" + symbol + "|" + m[3].slice(0, 5000) + "|" + Date.now())))
        const id = [...digest.slice(0, 12)].map((x) => x.toString(16).padStart(2, "0")).join("")
        const link = (x) => (/^https:\/\/[^\s]{3,200}$/.test(String(x || "")) ? String(x) : "")
        const image = `${publicUrl}/i/${id}`
        await store.put("img:" + id, { type: m[1], bytes })
        await store.put("meta:" + id, JSON.stringify({ name, symbol, description, image, showName: true, createdOn: siteUrl, twitter: link(b.twitter), telegram: link(b.telegram), website: link(b.website) }))
        return json({ uri: `${publicUrl}/m/${id}.json`, image })
      } catch (e) { return json({ error: "upload failed: " + String(e.message || e) }, 400) }
    }
    if (u.pathname === "/v1/send" && req.method === "POST") {
      try {
        const { tx } = await req.json()
        if (typeof tx !== "string" || tx.length > 3000) return json({ error: "bad transaction" }, 400)
        const sig = await rpc("sendTransaction", [tx, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }])
        return json({ signature: sig })
      } catch (e) { return json({ error: String(e.message || e).slice(0, 300) }, 400) }
    }
    if (u.pathname === "/v1/launched" && req.method === "POST") {
      try {
        const { mint } = await req.json(); if (!isKey(mint)) return json({ error: "bad mint" }, 400)
        pendingPins.set(mint, Date.now())
        const list = (await store.get("pinned")) || []; if (!list.includes(mint)) { list.unshift(mint); list.length = Math.min(list.length, 500); await store.put("pinned", list) }
        return json({ ok: true })
      } catch { return json({ error: "bad request" }, 400) }
    }
    if (u.pathname === "/v1/status") return json({ live, lastMsg, events: feed.events, coins: feed.coins.size, pinned: feed.pinned.size, sol })
    return json({ ok: true, service: "garlic relay" })
  }
  return { connect, tick, handle, restore, feed, floor, get live() { return live }, get lastMsg() { return lastMsg } }
}
