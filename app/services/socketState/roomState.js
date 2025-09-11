// export class RoomStateManager {
//   constructor() {
//     this.rooms = new Map();
//   }

//   getRoom(sessionId) {
//     return this.rooms.get(sessionId);
//   }

//   createRoom(sessionId, data = {}) {
//     const defaultRoom = {
//       whiteboardId: null,
//       createdBy: null,
//       streamerSocketId: null,
//       viewers: new Set(),
//       sockets: new Map(),
//       pendingOps: [],
//       flushTimer: null,
//       router: null,
//       transports: new Map(),
//       producers: new Map(),
//       consumers: new Map(),
//       ...data
//     };
    
//     this.rooms.set(sessionId, defaultRoom);
//     return defaultRoom;
//   }

//   ensureRoom(sessionId, data = {}) {
//     if (!this.rooms.has(sessionId)) {
//       return this.createRoom(sessionId, data);
//     }
//     return this.getRoom(sessionId);
//   }

//   deleteRoom(sessionId) {
//     return this.rooms.delete(sessionId);
//   }

//   hasRoom(sessionId) {
//     return this.rooms.has(sessionId);
//   }
// }

// // Singleton instance
// export const roomState = new RoomStateManager();