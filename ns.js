// Nightshift: the floor. Every layer sits in the Blender render's own pixels (2400 x 1500): the room, a desk and
// an agent per seat, live canvases mapped onto every monitor, the Scope wall, the gate kiosk, the ticker strip and
// the clock, colleagues walking the aisles. Data comes from the relay (live pump.fun feed + the agents' engine).
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const Q = new URLSearchParams(location.search)
// reads and most writes go through this site's proxy (/api/r); hiring goes to the relay itself, which limits hires per
// connection and so needs the visitor's own address. ?relay=<url> talks to a relay directly (local testing).
const RELAY = Q.get('relay')
let relayBase = RELAY ? Promise.resolve(RELAY) : fetch('/api/r?path=where').then((r) => r.json()).then((j) => j.base).catch(() => '')
const get = (p, q = '') => fetch(RELAY ? `${RELAY}/v1/${p}?${q}` : `/api/r?path=${p}&${q}`, { cache: 'no-store' }).then((r) => r.json())   // reads go through the edge cache
const post = async (p, b) => {
  const url = p === 'hire' ? `${await relayBase}/v1/hire` : RELAY ? `${RELAY}/v1/${p}` : `/api/r?path=${p}`
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json())
}
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? Math.floor(s) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h' }
const pct = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%'
const solf = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3))
let toastT; const toast = (m, bad) => { const t = $('toast'); t.textContent = m; t.className = 'toast on' + (bad ? ' bad' : ''); clearTimeout(toastT); toastT = setTimeout(() => (t.className = 'toast'), 4200) }

// ---------------------------------------------------------------- the stage
const MAN = await fetch('assets/manifest.json').then((r) => r.json())
const stage = $('stage'), SP = MAN.sprite, WK = MAN.walk
const FL = MAN.floor, floorPx = (x, y) => [FL.o[0] + x * FL.ex[0] + y * FL.ey[0], FL.o[1] + x * FL.ex[1] + y * FL.ey[1]]
const ZPX = Math.hypot(...FL.ex) * Math.cos(47 * Math.PI / 180)    // pixels per unit of height (orthographic camera, 47° down)
function fit() {
  const v = $('view'), side = innerWidth > 900 ? 336 : 0, aw = v.clientWidth - side, ah = v.clientHeight
  const s = Math.min(aw / 2400, ah / 1500) * 1.08
  stage.style.transform = `translate(${(aw - 2400 * s) / 2}px, ${(ah - 1500 * s) / 2}px) scale(${s})`
}
addEventListener('resize', fit); fit()
// a canvas laid onto 4 corners (tl, tr, br, bl): the CSS matrix3d that maps its rectangle onto the quad
function homography(w, h, q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3
  const den = dx1 * dy2 - dx2 * dy1, g = (dx3 * dy2 - dx2 * dy3) / den, hh = (dx1 * dy3 - dx3 * dy1) / den
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0, d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0
  return `matrix3d(${a / w},${d / w},0,${g / w}, ${b / h},${e / h},0,${hh / h}, 0,0,1,0, ${c},${f},0,1)`
}
function quad(q, w, h, z) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.className = 'quad'; cv.style.transform = homography(w, h, q); cv.style.zIndex = z; stage.appendChild(cv); return cv }
const shift = (q, o) => q.map(([x, y]) => [x + o[0], y + o[1]])
const el = (tag, cls, style, parent = stage) => { const e = document.createElement(tag); if (cls) e.className = cls; Object.assign(e.style, style || {}); parent.appendChild(e); return e }
const zOf = (py) => 10 + Math.round(py / 5)

// desks; the front seats go to the best ranks
// name plates sit by the left end of each desk, low, so they never cover the monitor
MAN.seats.forEach((s, i) => { const [sx, sy] = MAN.room.seats[i], [px, py] = floorPx(sx - 2.0, sy + 0.05); s.label = [px, py - 1.0 * ZPX] })
const seatOrder = MAN.seats.map((s, i) => i).sort((a, b) => MAN.seats[b].origin[1] - MAN.seats[a].origin[1])
const units = MAN.seats.map((s) => {
  const z = zOf(s.origin[1])
  const desk = el('img', 'layer', { left: SP.x + s.offset[0] + 'px', top: SP.y + s.offset[1] + 'px', width: SP.w + 'px', zIndex: z }); desk.src = 'assets/desk.png'
  const scr = quad(shift(MAN.screen, s.offset), 980, 400, z + 1); scr.getContext('2d').setTransform(2, 0, 0, 2, 0, 0)   // drawn at 2x: 490 x 200 units
  const ag = el('div', 'agent', { left: SP.x + s.offset[0] + 'px', top: SP.y + s.offset[1] + 'px', width: SP.w + 'px', height: SP.h + 'px', zIndex: z + 2 })
  const plate = el('div', 'plate', { left: s.label[0] + 'px', top: s.label[1] - 14 + 'px', zIndex: 800 })
  return { s, scr, ag, plate, ctx: scr.getContext('2d'), agent: null, frame: Math.random() * SP.frames, react: null, reactUntil: 0 }
})
const sctx = quad(MAN.scope, 1600, 563, 5).getContext('2d')
const kctx = quad(MAN.kiosk, 300, 180, 6).getContext('2d')
const tctx = quad(MAN.ticker, 4000, 70, 5).getContext('2d')
const cctx = quad(MAN.clock, 240, 240, 5).getContext('2d')
const box = (q) => { const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] }
const [kx, ky, kw, kh] = box(MAN.kiosk)
el('div', 'hot', { left: kx - 80 + 'px', top: ky - 60 + 'px', width: kw + 160 + 'px', height: kh + 260 + 'px', zIndex: 700 }).onclick = () => open('dLaunch')
const [qx, qy, qw, qh] = box(MAN.scope)
el('div', 'hot', { left: qx + 'px', top: qy + 'px', width: qw + 'px', height: qh + 'px', zIndex: 8 }).onclick = () => open('dScope')

// ---------------------------------------------------------------- colleagues walking the aisles
const AX = [2.9, 7.5, 12.1, 16.7, 21.3], AY = [1.9, 6.3, 10.4, 14.6]
const SPOTS = [{ x: 3.4, y: 16.1 }, { x: 15.5, y: 15.4 }, { x: 22.4, y: 12.4 }, { x: 1.8, y: 14.4 }]   // coffee, the Scope, the gate, the fridge
const near = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))
const walkers = (WK ? WK.looks : []).map((look, i) => ({
  d: el('div', 'walker', { width: WK.w + 'px', height: WK.h + 'px', backgroundImage: `url(assets/walk${look}.png)`, backgroundSize: `${WK.w * WK.frames}px ${WK.h * 4}px` }),
  x: AX[(i * 2) % AX.length], y: AY[i % AY.length], path: [], wait: 0.5 + i * 1.5, dir: 1, f: 0,
}))
function planWalk(w) {
  const goal = Math.random() < 0.55 ? SPOTS[Math.floor(Math.random() * SPOTS.length)] : { x: AX[Math.floor(Math.random() * AX.length)], y: AY[Math.floor(Math.random() * AY.length)] }
  const sx = near(AX, w.x), gx = near(AX, goal.x), gy = near(AY, goal.y)
  w.path = [{ x: sx, y: w.y }, { x: sx, y: gy }, { x: gx, y: gy }, { x: gx, y: goal.y }, { x: goal.x, y: goal.y }]
}
function stepWalkers(dt) {
  for (const w of walkers) {
    if (w.wait > 0) { w.wait -= dt; w.f = 0; if (w.wait <= 0 && !w.path.length) planWalk(w) }
    else if (w.path.length) {
      const t = w.path[0], dx = t.x - w.x, dy = t.y - w.y, dist = Math.hypot(dx, dy), sp = 1.5 * dt
      if (dist <= sp) { w.x = t.x; w.y = t.y; w.path.shift(); if (!w.path.length) { w.dir = 0; w.wait = 3 + Math.random() * 7 } }
      else { w.x += (dx / dist) * sp; w.y += (dy / dist) * sp; w.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 2 : 3) : dy > 0 ? 0 : 1; w.f = (w.f + dt * 9) % WK.frames }
    } else w.wait = 1
    const [px, py] = floorPx(w.x, w.y), ref = MAN.walkRef.px
    Object.assign(w.d.style, { left: WK.x + px - ref[0] + 'px', top: WK.y + py - ref[1] + 'px', zIndex: zOf(py) + 3, backgroundPosition: `${-Math.floor(w.f) * WK.w}px ${-w.dir * WK.h}px` })
  }
}

// ---------------------------------------------------------------- sound: synthesized, off until turned on
let ac = null, soundOn = false
const tone = (f, t0, dur, type = 'sine', vol = 0.12) => { const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.value = f; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + dur + 0.05) }
const SFX = {
  bell() { const t = ac.currentTime; [1318, 1975, 2637].forEach((f, i) => tone(f, t + i * 0.005, 2.2, 'sine', 0.07 / (i + 1))) },
  win() { const t = ac.currentTime; tone(1046, t, 0.18, 'triangle', 0.08); tone(1568, t + 0.08, 0.35, 'triangle', 0.07) },
  loss() { const t = ac.currentTime; tone(196, t, 0.35, 'sine', 0.11); tone(147, t + 0.12, 0.4, 'sine', 0.09) },
  buzz() { const t = ac.currentTime; tone(110, t, 0.25, 'square', 0.035); tone(110, t + 0.3, 0.25, 'square', 0.035) },
  key() { const t = ac.currentTime, n = ac.createBufferSource(), b = ac.createBuffer(1, 800, ac.sampleRate), d = b.getChannelData(0); for (let i = 0; i < 800; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / 90); n.buffer = b; const g = ac.createGain(); g.gain.value = 0.02; n.connect(g).connect(ac.destination); n.start(t) },
}
const sfx = (k) => { if (soundOn && ac) try { SFX[k]() } catch {} }
$('bSnd').onclick = () => { soundOn = !soundOn; if (soundOn && !ac) ac = new AudioContext(); $('sndWave').setAttribute('opacity', soundOn ? 1 : 0.25); if (soundOn) sfx('win') }
setInterval(() => { if (Math.random() < 0.5) sfx('key') }, 420)

// ---------------------------------------------------------------- live data
let floor = null, board = null, sol = 0, banner = null, tickerItems = [], lastCopyAlert = 0
const seenTrade = new Map(), seenNews = new Set(), MINE = localStorage.getItem('ns.agent') || ''
async function pullFloor() { try { floor = await get('floor'); sol = floor.sol || sol; paintFloor() } catch { $('liveDot').className = 'led off'; $('liveTxt').textContent = 'reconnecting' } }
async function pullBoard() { try { board = await get('board', 'n=60&sort=new'); paintScopeList() } catch {} }
function lookOf(a) { let h = 0; for (const ch of a.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return SP.looks[h % SP.looks.length] }
function pop(u, text, cls) { const p = el('div', 'pop ' + cls, { left: u.s.label[0] + 'px', top: u.s.label[1] - 112 + 'px' }); p.textContent = text; setTimeout(() => p.remove(), 2000) }

function paintFloor() {
  $('liveDot').className = 'led' + (floor.live ? '' : ' off'); $('liveTxt').textContent = floor.live ? 'live on pump.fun' : 'reconnecting'
  $('watched').textContent = (floor.watched || 0).toLocaleString()
  $('iWatched').textContent = (floor.watched || 0).toLocaleString(); $('iAgents').textContent = (floor.agents || []).length || '–'
  const agents = floor.agents
  seatOrder.forEach((seat, k) => {
    const u = units[seat], a = agents[k] || null
    u.agent = a
    if (a) {
      u.look = lookOf(a)
      u.ag.onclick = u.plate.onclick = () => openAgent(a.id)
      u.plate.className = 'plate' + (k === 0 ? ' first' : '') + (a.id === MINE ? ' mine' : '')
      u.plate.innerHTML = `<span class="rk">${k + 1}</span><span class="tx"><span class="nm">${esc(a.name)}</span><span class="pc ${a.pct >= 0 ? 'up' : 'dn'}">${pct(a.pct)}</span><span class="sb">${esc(a.modeLabel.toLowerCase())}${a.bot ? ' · house' : a.id === MINE ? ' · yours' : ''}</span></span>`
      // a new trade: cheer on a win, slump on a loss, a tag for a buy
      const t = a.last, key = t ? t.t + t.k + t.m : ''
      if (t && seenTrade.has(a.id) && seenTrade.get(a.id) !== key) {
        if (t.k === 'sell') { u.react = t.pnl >= 0 ? 'cheer' : 'slump'; u.reactUntil = performance.now() + 3200; pop(u, (t.pnl >= 0 ? '+' : '−') + solf(Math.abs(t.pnl)) + ' SOL', t.pnl >= 0 ? 'up' : 'dn'); sfx(t.pnl >= 0 ? 'win' : 'loss') }
        else pop(u, 'BUY $' + String(t.s).slice(0, 10).toUpperCase(), 'buy')
      }
      seenTrade.set(a.id, key)
    } else {
      u.ag.onclick = u.plate.onclick = () => open('dHire')
      u.plate.className = 'plate free'; u.plate.innerHTML = '<span class="tx"><span class="nm">Free desk</span><span class="sb">hire an agent</span></span>'
    }
  })
  $('rows').innerHTML = agents.map((a, i) => `<div class="row" data-id="${esc(a.id)}"><span class="flap">${String(i + 1).padStart(2, '0')}</span><span class="nm">${esc(a.name)}${a.bot ? '<span class="tag ai">HOUSE</span>' : ''}${a.id === MINE ? '<span class="tag you">YOU</span>' : ''}<small>${esc(a.modeLabel)} · ${a.open} open · ${a.wins}W ${a.losses}L</small></span><span class="p ${a.pct >= 0 ? 'up' : 'dn'}">${pct(a.pct)}</span></div>`).join('')
  $('bCount').textContent = floor.count + ' on the floor'
  $('rows').querySelectorAll('.row').forEach((r) => (r.onclick = () => openAgent(r.dataset.id)))
  const L = floor.last
  $('last').innerHTML = L && L.rows.length ? L.rows.slice(0, 3).map((r) => `<div style="display:flex;justify-content:space-between;padding:3px 0"><span class="disp" style="font-weight:700">${r.rank}. ${esc(r.name)}</span><span class="mono ${r.pct >= 0 ? 'up' : 'dn'}">${pct(r.pct)}</span></div>`).join('') : '<span class="dim mono" style="font-size:12px">the first shift is still running</span>'
  // the tape and the LED strip: trades, graduations, copies caught, whales
  const items = []
  for (const a of agents) if (a.last) items.push({ t: a.last.t, h: `<b class="disp" style="font-weight:700">${esc(a.name)}</b> ${a.last.k === 'buy' ? '<span class="amb">bought</span>' : 'sold'} $${esc(a.last.s)}${a.last.k === 'sell' ? ` <span class="${a.last.pnl >= 0 ? 'up' : 'dn'}">${pct(a.last.pct)}</span>` : ''}` })
  // copies are caught every few seconds: only the latest few go on the strips, so trades, graduations and whales stay readable
  const news = floor.news || [], copies = news.filter((n) => n.k === 'copy').slice(-4)
  for (const n of news.filter((n) => n.k === 'grad').concat(copies)) items.push({ t: n.at, h: n.k === 'grad' ? `<span class="amb">GRADUATED</span> $${esc(n.s)}` : `<span class="dn">COPY CAUGHT</span> $${esc(n.s)} <span class="dim">copies $${esc(n.of)}</span>` })
  for (const wb of floor.whales || []) items.push({ t: wb.at, h: `<span class="up">WHALE</span> ${(+wb.sol).toFixed(1)} SOL into $${esc(wb.s)}` })
  items.sort((x, y) => y.t - x.t)
  const html = items.slice(0, 22).map((x) => `<span class="it">${x.h} <span class="dim">${ago(x.t)}</span></span>`).join('')
  $('tape').innerHTML = html + html
  tickerItems = items.slice(0, 30)
  // bells: a graduation rings, a copy caught at the gate buzzes and flashes
  const first = !seenNews.size
  for (const n of floor.news || []) {
    const id = n.k + n.m
    if (seenNews.has(id)) continue
    seenNews.add(id)
    if (first && Date.now() - n.at > 20_000) continue
    if (n.k === 'grad') { banner = { text: `GRADUATED  $${String(n.s).toUpperCase()}`, color: '#ffb547', until: performance.now() + 7000 }; sfx('bell') }
    else if (Date.now() - lastCopyAlert > 40_000) { lastCopyAlert = Date.now(); banner = { text: `COPY CAUGHT  $${String(n.s).toUpperCase()}`, color: '#ff7a6b', until: performance.now() + 5000 }; sfx('buzz'); const f = el('div', 'flash', { left: kx - 90 + 'px', top: ky - 70 + 'px', width: kw + 180 + 'px', height: kh + 280 + 'px', background: 'rgba(255,122,107,.25)' }); setTimeout(() => f.remove(), 1700) }
  }
  seenNews.add('_')
}

// ---------------------------------------------------------------- every frame
const mcf = (mc) => { const v = sol ? mc * sol : mc; return (sol ? '$' : '') + (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : v.toFixed(0)) + (sol ? '' : ' SOL') }
// coin pictures for the screens: loaded once, drawn when ready
const imgs = new Map()
function pic(url) {
  if (!url) return null
  let e = imgs.get(url); if (e) return e.ok ? e.im : null
  const im = new Image(); e = { im, ok: false }; imgs.set(url, e); im.onload = () => (e.ok = true); im.src = url
  if (imgs.size > 400) imgs.delete(imgs.keys().next().value)
  return null
}
const UI = { bg: '#101116', card: '#181a21', line: '#262933', ink: '#f2f3f5', dim: '#8b8f9a', up: '#4ade80', dn: '#f87171', amber: '#ffb547' }
function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r) }
function coinTile(c, x, y, s, f) {
  const im = pic(f.img)
  c.save(); rr(c, x, y, s, s, s * 0.22); c.clip()
  if (im) c.drawImage(im, x, y, s, s)
  else { const g = c.createLinearGradient(x, y, x + s, y + s); g.addColorStop(0, '#2a3a2f'); g.addColorStop(1, '#16201a'); c.fillStyle = g; c.fillRect(x, y, s, s); c.fillStyle = UI.up; c.font = `800 ${s * 0.42}px "IBM Plex Sans"`; c.textAlign = 'center'; c.fillText(String(f.sym || '?').slice(0, 2).toUpperCase(), x + s / 2, y + s * 0.64); c.textAlign = 'left' }
  c.restore()
}
// a monitor: a pump.fun-style trading screen for the coin the agent holds right now
function drawScreen(u, t) {
  const c = u.ctx, a = u.agent, W = 490, H = 200
  c.fillStyle = UI.bg; c.fillRect(0, 0, W, H)
  if (!a) {
    c.fillStyle = 'rgba(255,181,71,.85)'; c.font = '800 44px "Big Shoulders Display"'; c.fillText('FREE DESK', 24, 92)
    c.fillStyle = UI.dim; c.font = '500 20px "IBM Plex Sans"'; c.fillText('hire an agent to trade from here', 26, 128)
    c.fillStyle = 'rgba(255,181,71,.18)'; rr(c, 24, 148, 150, 30, 8); c.fill(); c.fillStyle = UI.amber; c.font = '700 17px "IBM Plex Sans"'; c.fillText('Hire · free', 48, 169); return
  }
  // top bar: the agent and its shift return
  c.fillStyle = '#0b0c10'; c.fillRect(0, 0, W, 30)
  c.save(); c.translate(16, 15); c.rotate(-0.6); rr(c, -9, -4, 18, 8, 4); c.fillStyle = UI.up; c.fill(); c.fillStyle = '#f4f1ea'; c.fillRect(0, -4, 9, 8); c.restore()
  c.font = '700 15px "IBM Plex Sans"'; c.fillStyle = UI.ink; const nm = a.name.toUpperCase(); c.fillText(nm, 32, 20)
  const nw = c.measureText(nm).width
  c.font = '500 13px "IBM Plex Sans"'; c.fillStyle = UI.dim; c.fillText(a.modeLabel, 32 + nw + 10, 20)
  c.textAlign = 'right'; c.font = '700 16px "IBM Plex Mono"'; c.fillStyle = a.pct >= 0 ? UI.up : UI.dn; c.fillText(pct(a.pct), W - 12, 21); c.textAlign = 'left'
  const f = a.focus
  if (!f) {
    // nothing open: the agent watches new launches
    c.fillStyle = UI.dim; c.font = '600 14px "IBM Plex Sans"'; c.fillText('SCANNING NEW LAUNCHES', 16, 54)
    const k0 = (u.s.origin[0] | 0) % 5
    ;(board?.coins || []).slice(k0, k0 + 3).forEach((x, i) => {
      const y = 66 + i * 44; c.fillStyle = UI.card; rr(c, 12, y, W - 24, 38, 8); c.fill()
      coinTile(c, 18, y + 4, 30, { img: x.img, sym: x.symbol })
      c.fillStyle = UI.ink; c.font = '700 16px "IBM Plex Sans"'; c.fillText('$' + String(x.symbol).slice(0, 10).toUpperCase(), 58, y + 18)
      c.fillStyle = UI.dim; c.font = '500 12px "IBM Plex Sans"'; c.fillText(String(x.name).slice(0, 22), 58, y + 33)
      c.textAlign = 'right'; c.fillStyle = UI.up; c.font = '600 14px "IBM Plex Mono"'; c.fillText(mcf(x.mc), W - 24, y + 24); c.textAlign = 'left'
    })
    return
  }
  // the coin: picture, ticker, market cap, bonding curve
  coinTile(c, 12, 40, 48, f)
  c.fillStyle = UI.ink; c.font = '800 21px "IBM Plex Sans"'; c.fillText('$' + String(f.sym).slice(0, 10).toUpperCase(), 70, 60)
  c.fillStyle = UI.dim; c.font = '500 12px "IBM Plex Sans"'; c.fillText(String(f.name).slice(0, 20), 70, 78)
  c.fillStyle = UI.up; c.font = '700 15px "IBM Plex Mono"'; c.fillText('MC ' + mcf(f.mc), 70, 98)
  c.fillStyle = UI.line; rr(c, 12, 106, 176, 7, 4); c.fill(); c.fillStyle = UI.up; rr(c, 12, 106, Math.max(7, 176 * f.prog / 100), 7, 4); c.fill()
  c.fillStyle = UI.dim; c.font = '500 11px "IBM Plex Sans"'; c.fillText(`bonding curve ${f.prog}% · ${f.buyers} buyers`, 12, 128)
  // position
  c.fillStyle = UI.card; rr(c, 12, 138, 176, 52, 8); c.fill()
  c.fillStyle = UI.dim; c.font = '600 11px "IBM Plex Sans"'; c.fillText('POSITION', 22, 155)
  c.fillStyle = f.pct >= 0 ? UI.up : UI.dn; c.font = '800 22px "IBM Plex Mono"'; c.fillText(pct(f.pct), 22, 180)
  c.fillStyle = UI.dim; c.font = '500 12px "IBM Plex Mono"'; c.textAlign = 'right'; c.fillText(solf(f.cost) + ' SOL', 180, 180); c.textAlign = 'left'
  // the chart: candles from the coin's recent trades, the agent's entry dashed
  const X0 = 200, Y0 = 40, CW = W - X0 - 12, CH = H - Y0 - 12
  c.fillStyle = UI.card; rr(c, X0, Y0, CW, CH, 8); c.fill()
  const sp = f.spark || [], K = 4, cs = []
  for (let i = 0; i < sp.length; i += K) { const g = sp.slice(Math.max(0, i - 1), i + K); if (g.length) cs.push([g[0], Math.max(...g), Math.min(...g), g[g.length - 1]]) }
  if (cs.length) {
    let hi = Math.max(f.entry, ...cs.map((k) => k[1])), lo = Math.min(f.entry, ...cs.map((k) => k[2])); if (hi === lo) { hi *= 1.01; lo *= 0.99 }
    const py = (v) => Y0 + 10 + (CH - 20) * (1 - (v - lo) / (hi - lo)), bw = Math.min(16, (CW - 20) / cs.length)
    c.strokeStyle = 'rgba(255,255,255,.05)'; c.lineWidth = 1; for (let g = 1; g < 4; g++) { c.beginPath(); c.moveTo(X0 + 6, Y0 + CH * g / 4); c.lineTo(X0 + CW - 6, Y0 + CH * g / 4); c.stroke() }
    cs.forEach(([o, h, l, cl], i) => {
      const x = X0 + 10 + i * bw + bw / 2, up = cl >= o; c.strokeStyle = c.fillStyle = up ? UI.up : UI.dn
      c.beginPath(); c.moveTo(x, py(h)); c.lineTo(x, py(l)); c.lineWidth = 1.5; c.stroke()
      const y1 = py(Math.max(o, cl)), y2 = py(Math.min(o, cl)); c.fillRect(x - bw * 0.32, y1, bw * 0.64, Math.max(2, y2 - y1))
    })
    c.setLineDash([5, 4]); c.strokeStyle = UI.amber; c.lineWidth = 1.5; c.beginPath(); c.moveTo(X0 + 6, py(f.entry)); c.lineTo(X0 + CW - 6, py(f.entry)); c.stroke(); c.setLineDash([])
    c.fillStyle = UI.amber; c.font = '700 11px "IBM Plex Mono"'; c.fillText('ENTRY', X0 + CW - 50, py(f.entry) - 5)
  } else { c.fillStyle = UI.dim; c.font = '500 13px "IBM Plex Sans"'; c.fillText('waiting for trades…', X0 + 14, Y0 + CH / 2) }
  c.fillStyle = `rgba(255,255,255,${0.015 + 0.01 * Math.sin(t / 90 + u.s.origin[0])})`; c.fillRect(0, 0, W, H)
}
// the LED wall: pump.fun's newest launches as cards, copies flagged
function drawScope(t) {
  const c = sctx, W = 1600, H = 563
  c.fillStyle = '#07080b'; c.fillRect(0, 0, W, H)
  c.fillStyle = UI.ink; c.font = '800 40px "Big Shoulders Display"'; c.fillText('THE SCOPE', 32, 54)
  c.fillStyle = UI.dim; c.font = '500 19px "IBM Plex Sans"'; c.fillText('every pump.fun launch, live · copies flagged', 220, 50)
  c.textAlign = 'right'; c.fillStyle = UI.up; c.font = '600 22px "IBM Plex Mono"'; c.fillText((floor?.watched || 0).toLocaleString() + ' watched', W - 32, 52); c.textAlign = 'left'
  ;(board?.coins || []).slice(0, 12).forEach((x, i) => {
    const col = i % 4, row = Math.floor(i / 4), cw = 376, ch = 146, X = 24 + col * (cw + 12), Y = 80 + row * (ch + 12)
    c.fillStyle = UI.card; rr(c, X, Y, cw, ch, 14); c.fill()
    if (x.copyOf) { c.strokeStyle = UI.dn; c.lineWidth = 3; rr(c, X, Y, cw, ch, 14); c.stroke() }
    coinTile(c, X + 14, Y + 14, 92, { img: x.img, sym: x.symbol })
    c.fillStyle = x.copyOf ? UI.dn : UI.ink; c.font = '800 28px "IBM Plex Sans"'; c.fillText('$' + String(x.symbol).slice(0, 9).toUpperCase(), X + 120, Y + 44)
    c.fillStyle = UI.dim; c.font = '500 17px "IBM Plex Sans"'; c.fillText(String(x.name).slice(0, 18), X + 120, Y + 68)
    c.fillStyle = UI.up; c.font = '700 21px "IBM Plex Mono"'; c.fillText('MC ' + mcf(x.mc), X + 120, Y + 98)
    c.fillStyle = UI.dim; c.font = '500 16px "IBM Plex Mono"'; c.textAlign = 'right'; c.fillText(ago(x.at), X + cw - 14, Y + 98); c.textAlign = 'left'
    c.fillStyle = UI.line; rr(c, X + 120, Y + 114, cw - 134, 9, 5); c.fill(); c.fillStyle = UI.up; rr(c, X + 120, Y + 114, Math.max(9, (cw - 134) * (x.prog || 0) / 100), 9, 5); c.fill()
    if (x.copyOf) { c.fillStyle = UI.dn; rr(c, X + cw - 86, Y + 18, 72, 28, 7); c.fill(); c.fillStyle = '#2a0707'; c.font = '800 19px "Big Shoulders Display"'; c.fillText('COPY', X + cw - 72, Y + 39) }
    else if (x.grade) { c.fillStyle = 'AB'.includes(x.grade) ? UI.up : x.grade === 'C' ? '#f4d35e' : '#f59e57'; rr(c, X + cw - 44, Y + 18, 30, 28, 7); c.fill(); c.fillStyle = '#111'; c.font = '800 20px "Big Shoulders Display"'; c.fillText(x.grade, X + cw - 35, Y + 39) }
  })
  if (banner && performance.now() < banner.until) {
    c.globalAlpha = Math.min(1, (banner.until - performance.now()) / 600)
    c.fillStyle = 'rgba(7,8,11,.94)'; c.fillRect(0, 180, W, 200); c.fillStyle = banner.color; c.fillRect(0, 180, W, 6); c.fillRect(0, 374, W, 6)
    c.font = '800 96px "Big Shoulders Display"'; c.textAlign = 'center'; c.fillText(banner.text, W / 2, 314); c.textAlign = 'left'; c.globalAlpha = 1
  }
}
function drawKiosk(t) {
  const c = kctx; c.fillStyle = '#050a07'; c.fillRect(0, 0, 300, 180)
  c.fillStyle = '#ffb547'; c.font = '800 46px "Big Shoulders Display"'; c.fillText('THE GATE', 26, 74)
  c.font = '500 16px "IBM Plex Mono"'; c.fillStyle = 'rgba(230,225,215,.75)'; c.fillText('launch here. no copies.', 28, 108)
  c.fillStyle = (t / 600) % 2 < 1 ? '#6fe39b' : 'rgba(111,227,155,.25)'; c.fillRect(28, 132, 244, 8)
}
let tickX = 0
function drawTicker(dt) {
  const c = tctx, W = 4000, H = 70
  c.fillStyle = '#040605'; c.fillRect(0, 0, W, H)
  c.font = '600 44px "IBM Plex Mono"'
  const parts = tickerItems.length ? tickerItems.map((x) => x.h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')) : ['NIGHTSHIFT  ·  agents trading pump.fun, live  ·  hire one free']
  const text = parts.join('   ◆   ') + '   ◆   '
  const tw = Math.max(1, c.measureText(text).width)
  tickX = (tickX + dt * 160) % tw
  c.fillStyle = '#ffb547'
  for (let x = -tickX; x < W; x += tw) c.fillText(text, x, 50)
  c.fillStyle = 'rgba(0,0,0,.45)'; for (let x = 0; x < W; x += 6) c.fillRect(x, 0, 2, H); for (let y = 0; y < H; y += 6) c.fillRect(0, y, W, 2)
}
function drawClock() {
  const c = cctx, d = new Date()
  c.clearRect(0, 0, 240, 240); c.fillStyle = '#efe9dc'; c.beginPath(); c.arc(120, 120, 112, 0, 7); c.fill()
  c.strokeStyle = '#222'; c.lineCap = 'butt'
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; c.lineWidth = i % 3 ? 3 : 6; c.beginPath(); c.moveTo(120 + Math.sin(a) * 88, 120 - Math.cos(a) * 88); c.lineTo(120 + Math.sin(a) * 102, 120 - Math.cos(a) * 102); c.stroke() }
  const hand = (a, l, w, col) => { c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.beginPath(); c.moveTo(120, 120); c.lineTo(120 + Math.sin(a) * l, 120 - Math.cos(a) * l); c.stroke() }
  const h = (d.getHours() % 12) + d.getMinutes() / 60, m = d.getMinutes() + d.getSeconds() / 60
  hand((h / 12) * Math.PI * 2, 55, 9, '#1a1a1a'); hand((m / 60) * Math.PI * 2, 82, 6, '#1a1a1a'); hand((d.getSeconds() / 60) * Math.PI * 2, 92, 2.5, '#d9480f')
}
// steam from the espresso machine
const [mx, my] = floorPx(2.3, 17.35), steamAt = [mx, my - 1.75 * ZPX]
setInterval(() => { if (document.hidden) return; const s = el('div', 'steam', { left: steamAt[0] + (Math.random() * 16 - 8) + 'px', top: steamAt[1] + 'px' }); s.style.setProperty('--dx', Math.random() * 30 - 15 + 'px'); setTimeout(() => s.remove(), 3300) }, 480)

let lastT = performance.now()
function frame(t) {
  const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t
  for (const u of units) {
    if (u.agent) {
      const reacting = u.react && t < u.reactUntil, kind = reacting ? u.react : 'agent', n = reacting ? SP.react : SP.frames
      u.frame = (u.frame + dt * (reacting ? 7 : 4.5)) % n
      if (u.kind !== kind + u.look) { u.kind = kind + u.look; u.ag.style.backgroundImage = `url(assets/${kind}${u.look}.png)`; u.ag.style.backgroundSize = `${SP.w * n}px ${SP.h}px` }
      u.ag.style.backgroundPosition = `${-Math.floor(u.frame) * SP.w}px 0`
    } else if (u.kind !== 'empty') { u.kind = 'empty'; u.ag.style.backgroundImage = 'url(assets/empty.png)'; u.ag.style.backgroundSize = `${SP.w}px ${SP.h}px`; u.ag.style.backgroundPosition = '0 0' }
    drawScreen(u, t)
  }
  if (WK) stepWalkers(dt)
  drawScope(t); drawKiosk(t); drawTicker(dt); drawClock()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
pullFloor(); setInterval(pullFloor, 3000)
pullBoard(); setInterval(pullBoard, 5000)
setInterval(() => { if (!floor) return; const left = Math.max(0, floor.season.end - Date.now()); $('shift').textContent = $('iShift').textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}` }, 500)

// ---------------------------------------------------------------- drawers
function open(id) { document.querySelectorAll('.drawer').forEach((d) => d.classList.toggle('on', d.id === id)) }
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('.drawer').classList.remove('on')))
addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.drawer').forEach((d) => d.classList.remove('on')) })
$('bScope').onclick = () => open('dScope'); $('bLaunch').onclick = () => open('dLaunch'); $('bHire').onclick = () => open('dHire')
if (MINE) { $('bMine').style.display = ''; $('bMine').onclick = () => openAgent(MINE) }
if (location.hash === '#hire') open('dHire')

async function openAgent(id) {
  open('dAgent'); $('agentBody').innerHTML = '<div class="sec dim">loading…</div>'
  const a = await get('agent', 'id=' + encodeURIComponent(id)).catch(() => null)
  if (!a || a.error) return ($('agentBody').innerHTML = '<div class="sec dim">agent not found</div>')
  const st = a.strategy
  $('agentBody').innerHTML = `<div class="dh"><h2>${esc(a.name)}</h2><p>${esc(a.modeLabel)} · ${a.bot ? 'house agent' : a.id === MINE ? 'your agent' : a.guest ? 'guest' : 'hired by ' + esc(a.owner)} · desk ×${a.mult}</p></div>
    <div class="sec"><div class="kv"><div><b class="${a.pct >= 0 ? 'up' : 'dn'}">${pct(a.pct)}</b><span>this shift</span></div><div><b>${solf(a.equity)}</b><span>equity, SOL</span></div><div><b>${a.wins}/${a.losses}</b><span>won / lost</span></div></div></div>
    <div class="sec"><h4>Its rules</h4><div class="note">${Math.round(st.size * 100)}% per trade · take profit +${st.tp}% · stop −${st.sl}% · out after ${st.hold} min · ${st.skipVamps ? 'skips copies' : 'trades copies too'} · devs ${st.minGrade} or better</div></div>
    <div class="sec list"><h4>Holding now</h4>${a.positions.length ? a.positions.map((p) => `<a class="it" href="https://pump.fun/coin/${esc(p.mint)}" target="_blank" rel="noopener">${p.img ? `<img src="${esc(p.img)}" alt="">` : '<span class="ph"></span>'}<span><b class="disp" style="font-size:17px">$${esc(p.symbol)}</b> <span class="dim">${esc(p.name)}</span><br><span class="dim mono" style="font-size:12px">${solf(p.cost)} SOL in · ${ago(p.at)} ago</span></span><span class="mono ${p.pct >= 0 ? 'up' : 'dn'}">${pct(p.pct)}</span></a>`).join('') : '<div class="dim">nothing right now</div>'}</div>
    <div class="sec list"><h4>This shift's trades</h4>${a.trades.map((t) => `<a class="it" href="https://pump.fun/coin/${esc(t.m)}" target="_blank" rel="noopener"><span class="ph disp" style="display:grid;place-items:center;font-size:18px;color:${t.k === 'buy' ? 'var(--amber)' : 'var(--ink)'}">${t.k === 'buy' ? 'B' : 'S'}</span><span><b class="disp" style="font-size:17px">$${esc(t.s)}</b>${t.grade ? `<span class="chip g${t.grade}">${t.grade}</span>` : ''}${t.copy ? '<span class="chip cc">COPY</span>' : ''}<br><span class="dim mono" style="font-size:12px">${solf(t.sol)} SOL · ${t.why ? esc(t.why) + ' · ' : ''}${ago(t.t)} ago</span></span><span class="mono ${t.k === 'sell' ? (t.pnl >= 0 ? 'up' : 'dn') : 'dim'}">${t.k === 'sell' ? pct(t.pct) : ''}</span></a>`).join('') || '<div class="dim">no trades yet this shift</div>'}</div>
    <div class="sec note">Paper trades priced on each coin's real bonding curve at that second, pump.fun's fees included. <a class="amb" href="docs.html#agents">How it works</a></div>`
}
function paintScopeList() {
  if (!$('dScope').classList.contains('on')) return
  const hide = $('hideCopies').checked, list = (board?.coins || []).filter((c) => !hide || !c.copyOf)
  $('scopeList').innerHTML = list.map((c) => `<a class="it" href="https://pump.fun/coin/${esc(c.mint)}" target="_blank" rel="noopener">${c.img ? `<img src="${esc(c.img)}" alt="" loading="lazy">` : '<span class="ph"></span>'}<span><b class="disp" style="font-size:17px">$${esc(c.symbol)}</b> <span class="dim">${esc(c.name)}</span>${c.copyOf ? `<span class="chip cc">COPY OF $${esc(c.copyOf.symbol)}</span>` : ''}${c.grade ? `<span class="chip g${c.grade}">${c.grade}</span>` : ''}<br><span class="dim mono" style="font-size:12px">${ago(c.at)} · ${c.buyers} buyers · curve ${c.prog.toFixed(0)}%</span></span><span class="mono up">${mcf(c.mc)}</span></a>`).join('') || '<div class="dim">waiting for launches…</div>'
}
$('hideCopies').onchange = paintScopeList
new MutationObserver(paintScopeList).observe($('dScope'), { attributes: true, attributeFilter: ['class'] })

// ---------------------------------------------------------------- hire: a key the browser keeps, no wallet
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const b58 = (bytes) => { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n } for (const x of bytes) { if (x) break; s = '1' + s } return s }
async function guestKey() {
  try {
    const saved = JSON.parse(localStorage.getItem('ns.key') || 'null')
    if (saved) return { priv: await crypto.subtle.importKey('jwk', saved.priv, { name: 'Ed25519' }, false, ['sign']), pub: saved.pub }
  } catch {}
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const pub = b58(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
  localStorage.setItem('ns.key', JSON.stringify({ priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub }))
  return { priv: kp.privateKey, pub }
}
const MODES = { sniper: ['Sniper', 'Buys launches in their first seconds'], momentum: ['Momentum', 'Rides coins with real buy flow'], hunter: ['Grad hunter', 'Buys coins close to graduating'], diamond: ['Diamond hands', 'Holds through the noise'], dip: ['Dip buyer', 'Buys big pullbacks on strong coins'] }
const DEF = { sniper: [3, 80, 35], momentum: [5, 50, 25], hunter: [6, 60, 30], diamond: [7, 200, 50], dip: [5, 35, 20] }
let hMode = 'momentum'
$('hModes').innerHTML = Object.entries(MODES).map(([k, [n, d]]) => `<button class="mode${k === hMode ? ' on' : ''}" data-m="${k}"><b>${n}</b><span>${d}</span></button>`).join('')
const setRange = () => { $('hSizeV').textContent = $('hSize').value + '% of bankroll'; $('hTpV').textContent = '+' + $('hTp').value + '%'; $('hSlV').textContent = '−' + $('hSl').value + '%' }
$('hModes').querySelectorAll('.mode').forEach((b) => (b.onclick = () => { hMode = b.dataset.m; $('hModes').querySelectorAll('.mode').forEach((x) => x.classList.toggle('on', x === b)); const d = DEF[hMode]; $('hSize').value = d[0]; $('hTp').value = d[1]; $('hSl').value = d[2]; setRange() }))
;['hSize', 'hTp', 'hSl'].forEach((id) => ($(id).oninput = setRange)); setRange()
$('hGo').onclick = async () => {
  const b = $('hGo'); b.disabled = true
  try {
    const k = await guestKey(), msg = `nightshift:hire:${k.pub}:${Date.now()}`
    const sig = Array.from(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, k.priv, new TextEncoder().encode(msg)))).map((x) => x.toString(16).padStart(2, '0')).join('')
    const r = await post('hire', { wallet: k.pub, guest: true, name: $('hName').value, msg, sig, spec: { mode: hMode, size: $('hSize').value / 100, tp: +$('hTp').value, sl: +$('hSl').value, skipVamps: $('hVamp').checked, minGrade: $('hGrade').value } })
    if (r.error) throw new Error(r.error)
    localStorage.setItem('ns.agent', r.id)
    toast(`${r.name} took a desk. First trades land within seconds.`); setTimeout(() => location.reload(), 900)
  } catch (e) { toast(String(e.message || e).slice(0, 200), true) }
  b.disabled = false
}

// ---------------------------------------------------------------- launch through the gate (only this needs a wallet)
let wallet = null
const providers = () => [['Phantom', window.phantom?.solana], ['Solflare', window.solflare], ['Backpack', window.backpack]].filter(([, p]) => p)
async function connect() {
  const ps = providers(); if (!ps.length) { toast('no Solana wallet found. Install Phantom, Solflare or Backpack.', true); return null }
  try { const [name, p] = ps[0]; const r = await p.connect(); wallet = { p, name, pk: (r?.publicKey || p.publicKey).toString() }; $('fWal').style.display = 'none'; $('fGo').style.display = ''; preflight(); return wallet } catch { toast('wallet connection cancelled', true); return null }
}
$('fWal').onclick = connect
const web3 = () => import('https://esm.sh/@solana/web3.js@1.98.0?bundle')
let imgData = null, imgHash = '', ok = {}
$('fImg').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return
  imgHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))).map((x) => x.toString(16).padStart(2, '0')).join('')
  const bmp = await createImageBitmap(f), side = Math.min(bmp.width, bmp.height), size = Math.min(1000, side)
  const cv = document.createElement('canvas'); cv.width = cv.height = size
  cv.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size)
  imgData = cv.toDataURL('image/webp', 0.9); $('fPrev').src = imgData; $('fPrev').style.display = 'block'; preflight()
}
let vT = 0; ['fName', 'fSym'].forEach((id) => ($(id).oninput = () => { clearTimeout(vT); vT = setTimeout(preflight, 350) }))
const mark = (id, st, html) => { const i = $(id); i.className = st; i.textContent = st === 'ok' ? '✓' : st === 'no' ? '✕' : '○'; if (html != null) $(id + 'T').innerHTML = html }
async function preflight() {
  mark('cWal', wallet ? 'ok' : 'wt', wallet ? `wallet ${wallet.pk.slice(0, 4)}…${wallet.pk.slice(-4)}` : "connect the wallet you'll launch from")
  const name = $('fName').value.trim(), sym = $('fSym').value.trim().replace(/^\$+/, '')
  ok = { wal: !!wallet, img: false, name: false, sym: false }
  if (name || sym || imgHash) {
    const v = await get('vamp', `name=${encodeURIComponent(name)}&symbol=${encodeURIComponent(sym)}&img=${imgHash}`).catch(() => ({ hits: [] }))
    if (imgHash) { ok.img = !v.image; mark('cImg', ok.img ? 'ok' : 'no', ok.img ? 'image: original' : `image: already used by $${esc(v.image.symbol)} ${ago(v.image.at)} ago. copies are refused`) }
    const t = (v.hits || []).filter((h) => h.ticker), n = (v.hits || []).filter((h) => h.name_)
    if (sym) { ok.sym = !t.length; mark('cSym', ok.sym ? 'ok' : 'no', ok.sym ? `ticker $${esc(sym)} is free` : `$${esc(t[0].symbol)} launched ${ago(t[0].at)} ago. copies are refused for an hour`) }
    if (name) { ok.name = !n.length; mark('cName', ok.name ? 'ok' : 'no', ok.name ? `name "${esc(name)}" is free` : `"${esc(n[0].name)}" launched ${ago(n[0].at)} ago`) }
  }
  $('fGo').disabled = !(ok.wal && ok.img && ok.name && ok.sym)
}
const NOTE = $('fNote').textContent
$('fGo').onclick = async () => {
  const b = $('fGo'); b.disabled = true
  try {
    $('fNote').textContent = 'uploading image and metadata…'
    const up = await post('upload', { name: $('fName').value, symbol: $('fSym').value, description: $('fDesc').value, image: imgData, imgHash, twitter: $('fX').value, website: $('fWeb').value })
    if (up.error) throw new Error(up.error)
    const { Keypair, VersionedTransaction } = await web3(), mint = Keypair.generate()
    $('fNote').textContent = 'building the launch on pump.fun…'
    const r = await fetch('https://pumpportal.fun/api/trade-local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: wallet.pk, action: 'create', tokenMetadata: { name: $('fName').value.trim(), symbol: $('fSym').value.trim().replace(/^\$+/, ''), uri: up.uri }, mint: mint.publicKey.toBase58(), denominatedInSol: 'true', amount: Math.max(0, +$('fBuy').value || 0), slippage: 10, priorityFee: 0.0005, pool: 'pump' }) })
    if (r.status !== 200) throw new Error('could not build the transaction (' + r.status + ')')
    const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer())); tx.sign([mint])
    $('fNote').textContent = 'sign the launch in your wallet…'
    const signed = await wallet.p.signTransaction(tx)
    $('fNote').textContent = 'sending…'
    const s = await post('send', { tx: btoa(String.fromCharCode(...signed.serialize())) }); if (s.error) throw new Error(s.error)
    await post('launched', { mint: mint.publicKey.toBase58() })
    toast('launched. it is on the Scope now'); window.open('https://pump.fun/coin/' + mint.publicKey.toBase58(), '_blank')
  } catch (e) { toast(String(e.message || e).slice(0, 220), true) }
  $('fNote').textContent = NOTE; b.disabled = false
}

// ---------------------------------------------------------------- the opening
const CA = ''   // $SHIFT's contract address, once it exists
{
  const intro = $('intro'), lift = () => { intro.classList.add('off'); try { sessionStorage.setItem('ns.in', '1') } catch {} }
  try { if (sessionStorage.getItem('ns.in') || location.hash) intro.classList.add('off') } catch {}
  $('iEnter').onclick = lift
  $('iHire').onclick = () => { lift(); open('dHire') }
  if (CA) { const b = $('iCa'); b.style.display = 'flex'; b.querySelector('code').textContent = CA; b.onclick = () => navigator.clipboard?.writeText(CA).then(() => toast('$SHIFT contract address copied')) }
}

// ?solo=1 shows one live monitor full size (used to film the screens)
if (Q.get('solo')) {
  document.body.style.background = '#05060a'; [...document.body.children].forEach((e) => { if (e.id !== 'view') e.style.display = 'none' })
  setInterval(() => {
    const u = units.find((x) => x.agent?.focus && (x.agent.focus.spark || []).length > 20) || units.find((x) => x.agent?.focus) || units.find((x) => x.agent)
    if (!u) return
    units.forEach((x) => (x.scr.style.visibility = x === u ? 'visible' : 'hidden'))
    if (u.scr.parentNode !== document.body) document.body.appendChild(u.scr)
    Object.assign(u.scr.style, { position: 'fixed', left: '0px', top: '0px', width: '1960px', height: '800px', transform: 'none', zIndex: 9999 })
    document.querySelectorAll('#stage > *:not(.quad)').forEach((e) => (e.style.visibility = 'hidden'))
  }, 500)
}
