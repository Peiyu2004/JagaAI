import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { get, put, remove, uid, now, audit } from '../../../packages/shared/store.ts';

export type Role = 'management' | 'guard' | 'maintenance' | 'resident';
export interface User { id: string; townshipId: string; name: string; email: string; role: Role; membershipStatus: string; passwordHash: string; demo?: boolean; }
export const isFieldStaff = (user: Pick<User, 'role'>) => ['guard', 'maintenance'].includes(user.role);
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, hash: string) {
  const [salt, key] = hash.split(':');
  if (!salt || !key || key.length !== 128) return false;
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(key, 'hex'));
}
export const publicUser = (user: User) => ({ id: user.id, townshipId: user.townshipId, name: user.name, email: user.email, role: user.role, membershipStatus: user.membershipStatus, demo: user.demo });
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function sessionToken(req: Request) {
  const match = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('jagaai_session='));
  return match ? match.slice('jagaai_session='.length) : undefined;
}
export function createSession(user: User, res: Response) {
  const token = randomBytes(32).toString('base64url');
  const session = { id: tokenHash(token), townshipId: user.townshipId, userId: user.id, createdAt: now(), expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() };
  put('sessions', session);
  res.cookie('jagaai_session', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 12 * 3600_000 });
  audit(user, 'auth.login', 'users', user.id);
  return session;
}
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = sessionToken(req);
  const session = token && get('sessions', tokenHash(token));
  if (!session || Date.parse(session.expiresAt) <= Date.now()) { res.status(401).json({ error: 'Please sign in.' }); return; }
  const user = get<User>('users', session.userId);
  if (!user || user.membershipStatus !== 'active' || user.townshipId !== session.townshipId) { res.status(403).json({ error: 'Your membership is not active.' }); return; }
  res.locals.user = user;
  res.locals.session = session;
  next();
}
export function logout(req: Request, res: Response) {
  const token = sessionToken(req);
  if (token) remove('sessions', tokenHash(token));
  res.clearCookie('jagaai_session', { path: '/', httpOnly: true, sameSite: 'strict' });
}
export function revokeSessions(userId: string, sessions: any[]) {
  for (const session of sessions) if (session.userId === userId) remove('sessions', session.id);
}
export const opaqueTicket = () => randomBytes(32).toString('base64url');
