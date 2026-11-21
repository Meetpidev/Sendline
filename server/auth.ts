import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getDatabaseStatus, query } from './db.ts';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  sessionTokenHash?: string;
}

const SESSION_COOKIE_NAME = 'sendline_session';
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

function isSecureRequest(req: Request): boolean {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    return forwardedProto.split(',')[0].trim() === 'https';
  }
  return req.secure;
}

export function setSessionCookie(req: Request, res: Response, rawToken: string): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = isSecureRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (secure) {
    parts.push('Secure', 'Partitioned');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const secure = isSecureRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (secure) {
    parts.push('Secure', 'Partitioned');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export async function createSession(userId: string): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [tokenHash, userId, expiresAt]
  );
  return rawToken;
}

export async function revokeSession(tokenHash: string): Promise<void> {
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
}

function extractToken(req: Request): { token: string | null; viaCookie: boolean } {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return { token: bearer, viaCookie: false };
  }
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (cookieToken) return { token: cookieToken, viaCookie: true };
  return { token: null, viaCookie: false };
}

function passesCsrfCheck(req: Request): boolean {
  if (req.headers['x-requested-with'] === 'Sendline') {
    return true;
  }
  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '')
    .toString()
    .split(',')[0]
    .trim();
  if (origin && host) {
    try {
      const parsed = new URL(origin);
      if (parsed.host === host) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function resolveAuthFromRequest(req: Request): Promise<{
  user: AuthUser;
  tokenHash: string;
  viaCookie: boolean;
} | null> {
  const db = getDatabaseStatus();
  if (!db.configured || !db.ready) return null;

  const { token, viaCookie } = extractToken(req);
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const res = await query<{
    id: string;
    email: string;
    name: string;
    created_at: Date | string;
  }>(
    `SELECT u.id, u.email, u.name, u.created_at
     FROM sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash]
  );

  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    },
    tokenHash,
    viaCookie,
  };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const db = getDatabaseStatus();
  if (!db.configured || !db.ready) {
    res.status(503).json({
      error: db.configured
        ? `Database unavailable: ${db.error || 'connection failed'}`
        : 'Database is not configured. Add DATABASE_URL in Settings -> Secrets.',
      databaseConfigured: db.configured,
    });
    return;
  }

  try {
    const resolved = await resolveAuthFromRequest(req);
    if (!resolved) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
    if (resolved.viaCookie && isMutating && !passesCsrfCheck(req)) {
      res.status(403).json({ error: 'Invalid request origin' });
      return;
    }

    req.user = resolved.user;
    req.sessionTokenHash = resolved.tokenHash;
    next();
  } catch (err) {
    console.error('Auth verification error:', err);
    res.status(500).json({ error: 'Authentication verification failed' });
  }
}
