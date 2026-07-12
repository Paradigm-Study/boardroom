import { timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Install-scoped bearer guard for packaged supervisors. Undefined preserves
 * the legacy loopback-only development contract. The secret is never logged or
 * reflected in an error.
 */
export function localBearerAuth(expected: string | undefined): RequestHandler {
  if (!expected) return (_req: Request, _res: Response, next: NextFunction) => next()
  return (req: Request, res: Response, next: NextFunction): void => {
    const match = /^Bearer\s+(.+)$/.exec(req.header('authorization') ?? '')
    if (!match || !equal(expected, match[1])) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    next()
  }
}
