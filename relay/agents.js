// The trading floor: every agent paper-trades the live pump.fun feed with its own strategy. Fills are priced on
// the coin's real bonding curve (virtual reserves from its latest on-chain trade) at the moment of the decision,
// pump.fun's fees included. Seasons last one hour and are ranked on equity (cash + open positions at market).
// Paper trades don't move the real curve; everything else (prices, launches, copies, dev grades) is live data.

export const SEASON_MS = 3600_000
const START_BANK = 10                 // paper SOL each agent starts every season with (times its desk multiplier)
const FEE = 0.0125                    // pump.fun protocol + creator fee per trade
const MAX_TRADES = 60                 // per agent, newest first
const MAX_AGENTS = 600

// strategy presets; a hire can tune every number
export const MODES = {
  sniper:   { label: "Sniper",          size: 0.03, tp: 80,  sl: 35, hold: 5,  maxAge: 25,   minBuyers: 0,  minFlow: 0,   minProg: 0,  maxProg: 30,  dip: 0 },
  momentum: { label: "Momentum",        size: 0.05, tp: 50,  sl: 25, hold: 12, maxAge: 900,  minBuyers: 15, minFlow: 1.5, minProg: 5,  maxProg: 85,  dip: 0 },
  hunter:   { label: "Grad hunter",     size: 0.06, tp: 60,  sl: 30, hold: 20, maxAge: 3600, minBuyers: 30, minFlow: 0,   minProg: 65, maxProg: 97,  dip: 0 },
  diamond:  { label: "Diamond hands",   size: 0.07,  tp: 200, sl: 50, hold: 55, maxAge: 1800, minBuyers: 25, minFlow: 0.5, minProg: 20, maxProg: 90,  dip: 0 },
  dip:      { label: "Dip buyer",       size: 0.05,  tp: 35,  sl: 20, hold: 10, maxAge: 2400, minBuyers: 40, minFlow: 0,   minProg: 10, maxProg: 95,  dip: 40 },
}
const GRADES = "ABCDF"

// the house: six AI desks that play the same board as everyone
export const HOUSE = [
  { id: "h-ivy",    name: "Ivy",    role: "Sniper",        mode: "sniper",   skipVamps: true,  minGrade: "C" },
  { id: "h-otto",   name: "Otto",   role: "Momentum",      mode: "momentum", skipVamps: true,  minGrade: "D" },
  { id: "h-juno",   name: "Juno",   role: "Grad hunter",   mode: "hunter",   skipVamps: true,  minGrade: "C" },
  { id: "h-bram",   name: "Bram",   role: "Diamond hands", mode: "diamond",  skipVamps: false, minGrade: "D" },
  { id: "h-nell",   name: "Nell",   role: "Dip buyer",     mode: "dip",      skipVamps: true,  minGrade: "B" },
  { id: "h-rex",    name: "Rex",    role: "Degen",         mode: "sniper",   skipVamps: false, minGrade: "F", size: 0.06, tp: 150, sl: 60 },
]

const priceOf = (c) => (c.vTok > 0 ? c.vSol / c.vTok : 0)
const buyTokens = (c, sol) => { const x = sol * (1 - FEE); return c.vTok - (c.vSol * c.vTok) / (c.vSol + x) }
const sellSol = (c, tok) => (c.vSol - (c.vSol * c.vTok) / (c.vTok + tok)) * (1 - FEE)

function strategyOf(spec) {
  const base = MODES[spec.mode] || MODES.momentum
  const n = (v, d, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d)
  return {
    mode: MODES[spec.mode] ? spec.mode : "momentum",
    size: n(spec.size, base.size, 0.02, 0.5), tp: n(spec.tp, base.tp, 5, 1000), sl: n(spec.sl, base.sl, 5, 95),
    hold: n(spec.hold, base.hold, 1, 60), maxAge: base.maxAge, minBuyers: n(spec.minBuyers, base.minBuyers, 0, 500),
    minFlow: base.minFlow, minProg: base.minProg, maxProg: base.maxProg, dip: base.dip,
    skipVamps: spec.skipVamps !== false, minGrade: GRADES.includes(spec.minGrade) ? spec.minGrade : "D",
    maxOpen: n(spec.maxOpen, 4, 1, 8),
  }
}

export function createFloor({ feed, store, gradeOf, tierOf }) {
  const agents = new Map()            // id -> agent
  let season = Math.floor(Date.now() / SEASON_MS), last = null, dirty = new Set(), runAt = 0, trades = 0

  function newAgent(a) {
    const mult = a.mult || 1
    return { id: a.id, name: String(a.name || "Agent").slice(0, 18), role: a.role || "", owner: a.owner || null, bot: !!a.bot,
      spec: a.spec, strat: strategyOf(a.spec), mult, cash: START_BANK * mult, start: START_BANK * mult, pos: {}, seen: {},
      trades: [], wins: 0, losses: 0, best: 0, season, hiredAt: a.hiredAt || Date.now(), total: a.total || 0, seasons: a.seasons || 0 }
  }
  for (const h of HOUSE) agents.set(h.id, newAgent({ ...h, bot: true, spec: { mode: h.mode, skipVamps: h.skipVamps, minGrade: h.minGrade, size: h.size, tp: h.tp, sl: h.sl } }))

  const equity = (a) => a.cash + Object.entries(a.pos).reduce((s, [m, p]) => { const c = feed.coins.get(m); return s + (c ? Math.max(0, sellSol(c, p.tok)) : p.cost * 0.5) }, 0)
  const view = (a, full) => {
    const eq = equity(a), pnl = eq - a.start
    const o = { id: a.id, name: a.name, role: a.role, bot: a.bot, guest: !!a.guest, owner: a.guest ? "guest" : a.owner ? a.owner.slice(0, 4) + "…" + a.owner.slice(-4) : null, mode: a.strat.mode,
      modeLabel: MODES[a.strat.mode].label, mult: a.mult, equity: +eq.toFixed(4), pnl: +pnl.toFixed(4), pct: +((pnl / a.start) * 100).toFixed(2),
      open: Object.keys(a.pos).length, wins: a.wins, losses: a.losses, total: +a.total.toFixed(3), seasons: a.seasons,
      last: a.trades[0] || null, hist: a.trades.filter((t) => t.k === "sell").slice(0, 14).map((t) => t.pct).reverse() }
    if (full) {
      o.strategy = a.strat
      o.positions = Object.entries(a.pos).map(([m, p]) => { const c = feed.coins.get(m); const v = c ? sellSol(c, p.tok) : 0
        return { mint: m, symbol: p.sym, name: c?.name || p.sym, img: c?.meta?.image || null, cost: +p.cost.toFixed(4), value: +v.toFixed(4), pct: +(((v - p.cost) / p.cost) * 100).toFixed(1), at: p.at, entry: p.entry, now: c ? priceOf(c) : 0 } })
      o.trades = a.trades
    }
    return o
  }

  function log(a, t) { a.trades.unshift(t); if (a.trades.length > MAX_TRADES) a.trades.length = MAX_TRADES; trades++; dirty.add(a.id) }

  function close(a, m, why) {
    const p = a.pos[m], c = feed.coins.get(m)
    const got = c ? Math.max(0, sellSol(c, p.tok)) : 0
    a.cash += got; delete a.pos[m]
    const pnl = got - p.cost; if (pnl >= 0) a.wins++; else a.losses++
    a.best = Math.max(a.best, pnl)
    log(a, { t: Date.now(), k: "sell", m, s: p.sym, sol: +got.toFixed(4), pnl: +pnl.toFixed(4), pct: +((pnl / p.cost) * 100).toFixed(1), why, px: c ? priceOf(c) : 0 })
  }

  async function decide(a, now) {
    const s = a.strat
    // exits first
    for (const [m, p] of Object.entries(a.pos)) {
      const c = feed.coins.get(m)
      if (!c) { close(a, m, "gone"); continue }
      const v = sellSol(c, p.tok), pct = ((v - p.cost) / p.cost) * 100
      if (c.done) close(a, m, "graduated")
      else if (pct >= s.tp) close(a, m, "take profit")
      else if (pct <= -s.sl) close(a, m, "stop loss")
      else if (now - p.at > s.hold * 60_000) close(a, m, "time")
    }
    // entries
    if (Object.keys(a.pos).length >= s.maxOpen) return
    const budget = a.start * s.size
    if (a.cash < budget) return
    for (const c of feed.coins.values()) {
      if (Object.keys(a.pos).length >= s.maxOpen || a.cash < budget) break
      if (c.done || a.seen[c.mint] || !(c.vTok > 0)) continue
      const age = (now - c.at) / 1000, prog = c.rTok0 ? (1 - c.rTok / c.rTok0) * 100 : 0
      if (age > s.maxAge || age < 4) continue
      if (c.buyers.size < s.minBuyers || prog < s.minProg || prog > s.maxProg) continue
      if (s.skipVamps && c.copyOf) continue
      if (s.minFlow) { const f = c.recent.filter((x) => now - x[0] < 300_000).reduce((t, x) => t + x[1], 0); if (f < s.minFlow) continue }
      if (s.dip) { const px = priceOf(c) * 1e9; if (!c.peak || px > c.peak * (1 - s.dip / 100)) continue }
      if (c.devPeak > 0 && c.devTok < c.devPeak * 0.5) continue          // the dev already dumped
      a.seen[c.mint] = 1
      const g = await gradeOf(c).catch(() => "C")
      if (GRADES.indexOf(g) > GRADES.indexOf(s.minGrade)) continue
      const tok = buyTokens(c, budget)
      if (!(tok > 0)) continue
      a.cash -= budget
      a.pos[c.mint] = { tok, cost: budget, at: now, sym: c.symbol, entry: priceOf(c) }
      log(a, { t: now, k: "buy", m: c.mint, s: c.symbol, sol: +budget.toFixed(4), px: priceOf(c), grade: g, copy: c.copyOf ? 1 : 0 })
    }
    // the seen list only needs live coins
    if (Object.keys(a.seen).length > 3000) for (const m of Object.keys(a.seen)) if (!feed.coins.has(m)) delete a.seen[m]
  }

  async function rollover(now) {
    const s = Math.floor(now / SEASON_MS)
    if (s === season) return
    const rows = [...agents.values()].map((a) => ({ a, eq: equity(a) })).sort((x, y) => (y.eq - y.a.start) / y.a.start - (x.eq - x.a.start) / x.a.start)
    last = { season, end: (season + 1) * SEASON_MS, rows: rows.slice(0, 50).map(({ a, eq }, i) => ({ rank: i + 1, id: a.id, name: a.name, bot: a.bot, owner: a.owner, pnl: +(eq - a.start).toFixed(4), pct: +(((eq - a.start) / a.start) * 100).toFixed(2) })) }
    await store.put("season:" + season, last).catch(() => {})
    await store.put("season:last", last).catch(() => {})
    for (const { a, eq } of rows) {
      a.total += eq - a.start; a.seasons++
      for (const m of Object.keys(a.pos)) close(a, m, "season end")
      a.mult = a.bot ? 1 : await tierOf(a.owner).catch(() => a.mult)
      a.start = START_BANK * a.mult; a.cash = a.start; a.wins = 0; a.losses = 0; a.best = 0; a.season = s
      dirty.add(a.id)
    }
    season = s
  }

  let running = false
  async function tick() {
    const now = Date.now()
    if (running || now - runAt < 2500) return
    running = true; runAt = now
    try {
      await rollover(now)
      for (const a of agents.values()) await decide(a, now)
    } finally { running = false }
  }

  async function save() {
    for (const id of dirty) { const a = agents.get(id); if (a) await store.put("ag:" + id, a).catch(() => {}) }
    dirty = new Set()
    await store.put("ag:index", [...agents.keys()]).catch(() => {})
  }
  async function restore() {
    last = (await store.get("season:last")) || null
    for (const id of (await store.get("ag:index")) || []) {
      const a = await store.get("ag:" + id)
      if (a && a.season === season) { a.strat = strategyOf(a.spec); agents.set(id, a) }
      else if (a) { const b = newAgent(a); b.total = a.total || 0; b.seasons = a.seasons || 0; agents.set(id, b) }
    }
  }

  // ---------------------------------------------------------------- hiring: a wallet signs, its agent gets a desk
  const perIp = new Map()            // ip -> [day, new agents that day]
  async function hire({ wallet, name, spec, msg, sig, guest, ip }) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet || "")) throw new Error("bad wallet")
    const m = String(msg || "").match(/^nightshift:hire:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d{13})$/)
    if (!m || m[1] !== wallet || Math.abs(Date.now() - +m[2]) > 10 * 60_000) throw new Error("bad message")
    if (!(await verify(wallet, msg, sig))) throw new Error("bad signature")
    const id = "w-" + wallet
    const old = agents.get(id)
    if (!old && agents.size >= MAX_AGENTS) throw new Error("the floor is full")
    if (!old && ip) {   // guests sign with a key their browser made; a few new desks per address per day
      const day = Math.floor(Date.now() / 86400_000), r = perIp.get(ip)
      const n = r && r[0] === day ? r[1] : 0
      if (n >= 4) throw new Error("that's enough new agents from here today. Edit your existing one instead")
      perIp.set(ip, [day, n + 1]); if (perIp.size > 20000) perIp.delete(perIp.keys().next().value)
    }
    const mult = await tierOf(wallet).catch(() => 1)
    const clean = String(name || "").replace(/[^\w .'-]/g, "").trim().slice(0, 18) || "Agent " + wallet.slice(0, 4)
    if (old) { old.name = clean; old.spec = spec || old.spec; old.strat = strategyOf(old.spec); dirty.add(id); return view(old, true) }
    const a = newAgent({ id, name: clean, role: "Trader", owner: wallet, spec: spec || { mode: "momentum" }, mult: guest ? 1 : mult })
    a.guest = !!guest
    agents.set(id, a); dirty.add(id)
    return view(a, true)
  }

  return {
    tick, save, restore, hire,
    get size() { return agents.size }, get trades() { return trades },
    floor() {
      const all = [...agents.values()].map((a) => view(a))
      const board = [...all].sort((x, y) => y.pct - x.pct)
      return { now: Date.now(), season: { n: season, start: season * SEASON_MS, end: (season + 1) * SEASON_MS }, agents: board.slice(0, 120), count: all.length, last }
    },
    agent(id) { const a = agents.get(id); return a ? view(a, true) : null },
    house: HOUSE, modes: MODES,
  }
}

// ed25519 signature check of a Solana wallet's signed message (Web Crypto, works in Node and Workers)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
export function b58decode(s) {
  let n = 0n
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error("b58"); n = n * 58n + BigInt(i) }
  const out = []
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n }
  for (const ch of s) { if (ch !== "1") break; out.unshift(0) }
  return new Uint8Array(out)
}
async function verify(wallet, msg, sig) {
  try {
    const key = await crypto.subtle.importKey("raw", b58decode(wallet), { name: "Ed25519" }, false, ["verify"])
    const s = typeof sig === "string" ? (/^[0-9a-f]+$/i.test(sig) ? Uint8Array.from(sig.match(/../g).map((h) => parseInt(h, 16))) : b58decode(sig)) : new Uint8Array(sig)
    return await crypto.subtle.verify({ name: "Ed25519" }, key, s, new TextEncoder().encode(msg))
  } catch { return false }
}
