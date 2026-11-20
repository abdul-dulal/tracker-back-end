/**
 * Real-time emit helpers (guide §D.5). The Socket.IO server registers itself via setIo();
 * when no server is attached (tests, worker process) emits are recorded/no-ops.
 */
let io = null;
export const emitted = []; // captured in tests

export function setIo(server) {
  io = server;
}

function emit(room, event, data) {
  if (process.env.NODE_ENV === 'test') emitted.push({ room, event, data });
  io?.to(room).emit(event, data);
}

export const rooms = {
  user: (userId) => `user:${userId}`,
  org: (orgId) => `org:${orgId}`,
  live: (orgId) => `org:${orgId}:live`,
  project: (projectId) => `project:${projectId}`,
};

export const emitToUser = (userId, event, data) => emit(rooms.user(userId), event, data);
export const emitToOrg = (orgId, event, data) => emit(rooms.org(orgId), event, data);
export const emitToLive = (orgId, event, data) => emit(rooms.live(orgId), event, data);
export const emitToProject = (projectId, event, data) => emit(rooms.project(projectId), event, data);
