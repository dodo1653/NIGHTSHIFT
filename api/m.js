// Coin metadata and images, on this site's domain for good: /m/<id>.json and /i/<id> (see vercel.json). The bytes
// come from the relay once and are then cached at the CDN for a year (they never change).
import { RELAY_BASE } from './_relay.js'
export const config = { runtime: 'edge' }
export default async function handler(req) {
  const u = new URL(req.url), id = u.searchParams.get('id') || '', k = u.searchParams.get('k')
  if (!/^[a-f0-9]{24}$/.test(id) || !['m', 'i'].includes(k)) return new Response('not found', { status: 404 })
  const r = await fetch(`${RELAY_BASE}/${k}/${id}${k === 'm' ? '.json' : ''}`).catch(() => null)
  if (!r || !r.ok) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } })
  return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' } })
}
