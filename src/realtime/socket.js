import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { setIo, rooms } from '../lib/realtime.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { loadMemberContext, withHelpers } from '../rbac/context.js';
import { accessibleProjectIds } from '../rbac/scope.js';
import { sha256 } from '../lib/crypto.js';

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((p) => p.trim().split('='))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k, decodeURIComponent(v)]),
  );
}

/**
 * Socket.IO server (guide §D.5). Auth: tr_at cookie, `auth.token` (JWT) or `auth.deviceToken`.
 * Rooms: user:{id}, org:{id}, org:{id}:live (requires activity.view team/org), project:{id} (on demand).
 */
export function attachSocket(httpServer) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: env.CORS_ORIGINS.split(','), credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || parseCookies(socket.handshake.headers.cookie).tr_at;
      const deviceToken = socket.handshake.auth?.deviceToken;
      if (deviceToken) {
        const row = await db.one(
          `SELECT dt.user_id, d.organization_id, d.id AS device_id FROM device_tokens dt JOIN devices d ON d.id = dt.device_id
           WHERE dt.token_hash = $1 AND dt.revoked_at IS NULL AND dt.expires_at > now() AND d.status = 'active'`,
          [sha256(deviceToken)],
        );
        if (!row) return next(new Error('unauthorized'));
        socket.data = { userId: row.user_id, orgId: row.organization_id, deviceId: row.device_id };
      } else {
        if (!token) return next(new Error('unauthorized'));
        const p = await verifyAccessToken(token);
        const s = await db.one('SELECT revoked_at FROM sessions WHERE id = $1', [p.sid]);
        if (!s || s.revoked_at) return next(new Error('unauthorized'));
        socket.data = { userId: p.sub, orgId: p.org ?? null };
      }
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const { userId, orgId, deviceId } = socket.data;
    socket.join(rooms.user(userId));
    let ctx = null;
    if (orgId) {
      const m = await loadMemberContext(userId, orgId);
      if (m && m.memberStatus === 'active') {
        ctx = withHelpers({ ...m, userId });
        socket.join(rooms.org(orgId));
        const scope = ctx.can('activity.view');
        if (scope && scope !== 'own') socket.join(rooms.live(orgId));
        if (!deviceId) await db.query('UPDATE organization_members SET last_seen_at = now() WHERE id = $1', [ctx.memberId]);
      }
    }
    socket.on('project:join', async (projectId, ack) => {
      try {
        if (!ctx) throw new Error('no org');
        const ids = await accessibleProjectIds(ctx, 'projects.view');
        if (ids && !ids.includes(projectId)) throw new Error('forbidden');
        socket.join(rooms.project(projectId));
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });
    socket.on('project:leave', (projectId) => socket.leave(rooms.project(projectId)));
  });

  setIo(io);
  logger.info('socket.io attached');
  return io;
}
