import { SignJWT, jwtVerify, errors } from 'jose';
import { env } from '../config/env.js';
import { unauthenticated } from './errors.js';

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = 'tracker-api';

/** Sign a short-lived access token. Claims: sub=userId, sid=sessionId, org=active organization id. */
export async function signAccessToken({ userId, sessionId, orgId }) {
  return new SignJWT({ sid: sessionId, org: orgId ?? null })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

/** Generic short-lived signed token (e.g. OAuth state, MFA step). */
export async function signToken(payload, ttlSeconds, audience) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function verifyToken(token, audience) {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience });
    return payload;
  } catch (err) {
    if (err instanceof errors.JWTExpired) throw unauthenticated('Token expired', 'TOKEN_EXPIRED');
    throw unauthenticated('Invalid token', 'INVALID_TOKEN');
  }
}

export async function verifyAccessToken(token) {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (payload.aud) throw new Error('not an access token');
    return payload;
  } catch (err) {
    if (err instanceof errors.JWTExpired) throw unauthenticated('Access token expired', 'TOKEN_EXPIRED');
    throw unauthenticated('Invalid access token', 'INVALID_TOKEN');
  }
}
