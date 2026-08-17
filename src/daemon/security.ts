import { timingSafeEqual } from 'node:crypto'
import type { Request, RequestHandler } from 'express'

// The daemon binds 127.0.0.1 only, and that loopback bind has always been called
// "the security predicate for running without auth". But loopback binding alone
// stops nothing a browser can reach: a page you visit can POST cross-origin to
// http://127.0.0.1:4040, and a DNS-rebinding page can make the browser treat the
// daemon as same-origin. This module is the missing enforcement — Host/Origin
// validation to lock out web attackers, and a loopback token to lock out other
// local users/processes on a shared machine (the same threat the 0600 DB perms
// defend against). All functions are pure/injectable so the policy is unit-tested
// without a live server.

// Hostnames that mean "this machine". A request whose Host resolves elsewhere is a
// DNS-rebinding attempt (the browser sends the attacker's hostname as Host) or is
// misrouted — either way, refuse it.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export const TOKEN_COOKIE = 'boardroom_token'

// Extract the hostname from a Host/authority value, dropping the optional :port and
// IPv6 brackets. Handles "127.0.0.1", "127.0.0.1:4040", "localhost:4040",
// "[::1]", and "[::1]:4040".
export function hostnameOf(authority: string | undefined): string | undefined {
  if (!authority) return undefined
  const h = authority.trim().toLowerCase()
  if (!h) return undefined
  if (h[0] === '[') {
    const end = h.indexOf(']')
    return end === -1 ? undefined : h.slice(1, end)
  }
  const colon = h.indexOf(':')
  return colon === -1 ? h : h.slice(0, colon)
}

// The anti-DNS-rebinding gate. A rebound page cannot forge the Host header — the
// browser sets it from the URL bar's hostname — so a non-loopback Host is refused.
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  const name = hostnameOf(hostHeader)
  return name !== undefined && LOOPBACK.has(name)
}

// The anti-cross-origin gate for browser callers. Absent Origin => a non-browser
// client (the MCP CLI, a curl hook, a server-side fetch): allowed. A present Origin
// must be an http(s) loopback origin; "null" (opaque/sandboxed) and any real remote
// origin are rejected.
export function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (originHeader === undefined) return true
  try {
    const u = new URL(originHeader)
    return LOOPBACK.has(u.hostname.replace(/^\[|\]$/g, ''))
  } catch {
    return false // "null", "", or unparseable
  }
}

// Read a single cookie value out of a raw Cookie header without pulling in
// cookie-parser (the daemon needs exactly one cookie).
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim())
      } catch {
        return part.slice(eq + 1).trim()
      }
    }
  }
  return undefined
}

// The token can arrive three ways, in priority order: an Authorization: Bearer
// header (programmatic callers, the menu-bar main process), the same-origin cookie
// the dashboard is served with (the browser SPA + Electron window, transparently),
// or a ?token= query param (EventSource fallbacks / manual testing).
export function extractToken(req: Request): string | undefined {
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const t = auth.slice(7).trim()
    if (t) return t
  }
  const cookie = parseCookie(req.headers.cookie, TOKEN_COOKIE)
  if (cookie) return cookie
  const q = req.query?.token
  if (typeof q === 'string' && q) return q
  return undefined
}

function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  // timingSafeEqual throws on length mismatch; a length difference is already a
  // non-match, so short-circuit rather than leak it as a throw.
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

// Reject any request whose Host is not loopback. Applied to EVERY route — it is the
// primary anti-DNS-rebinding control and costs one header comparison.
export function hostGuard(): RequestHandler {
  return (req, res, next) => {
    if (!isLoopbackHost(req.headers.host)) {
      res.status(403).json({ error: 'forbidden: non-loopback Host' })
      return
    }
    next()
  }
}

// Reject any request carrying a non-loopback Origin. Scoped to routes a browser
// could reach cross-origin without a token (/mcp) plus /api as defense-in-depth.
// Real MCP clients send no Origin, so this is invisible to them.
export function originGuard(): RequestHandler {
  return (req, res, next) => {
    if (!isAllowedOrigin(req.headers.origin)) {
      res.status(403).json({ error: 'forbidden: cross-origin request' })
      return
    }
    next()
  }
}

// Require the loopback token on the guarded surface (/api, /events). This is what
// stops a *different local user* or a rogue local process — which can reach
// loopback regardless of file permissions — from reading cards or forging verdicts.
export function requireToken(token: string): RequestHandler {
  return (req, res, next) => {
    const provided = extractToken(req)
    if (provided !== undefined && tokensMatch(provided, token)) {
      next()
      return
    }
    res.status(401).json({ error: 'unauthorized: missing or invalid boardroom token' })
  }
}

// Serve the dashboard entry with the token as a locked-down cookie, so the browser
// SPA and the Electron window authenticate every same-origin /api and /events
// request with zero client code. HttpOnly keeps page scripts (and any injected
// agent content) from reading it; SameSite=Strict keeps it off cross-site requests
// (so it can never ride a CSRF/rebinding attempt).
export function dashboardCookie(token: string): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
      res.cookie(TOKEN_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/' })
    }
    next()
  }
}
