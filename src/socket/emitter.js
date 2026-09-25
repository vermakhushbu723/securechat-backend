/**
 * Thin wrapper around the Socket.IO server so services can emit without
 * importing the socket layer. With the Redis adapter, `io.to(room)` reaches
 * sockets on every node of the cluster.
 */
let io = null;

export const setIO = (server) => {
  io = server;
};

export const userRoom = (userId) => `user:${userId}`;
export const presenceRoom = (userId) => `presence:${userId}`;

export function emitToUser(userId, event, payload) {
  io?.to(userRoom(userId)).emit(event, payload);
}

export function emitToUsers(userIds, event, payload) {
  if (!io || !userIds.length) return;
  io.to(userIds.map(userRoom)).emit(event, payload);
}

export function emitToRoom(room, event, payload) {
  io?.to(room).emit(event, payload);
}

export const getIO = () => io;
