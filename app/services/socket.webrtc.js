import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import LiveSession from "../model/LiveSessions/liveSession.model.js";
import LiveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
import { ROLE_MAP } from "../constant/role.js";

let io; // global reference for Socket.io
const roomState = new Map(); // ephemeral room state

function getIceServersFromEnv() {
  const stun = (process.env.STUN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
  const turn = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
  const servers = [];
  if (stun.length) servers.push({ urls: stun });
  if (turn.length && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
    servers.push({ urls: turn, username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD });
  }
  return servers;
}

export function getIO() {
  if (!io) throw new Error("Socket.io not initialized yet");
  return io;
}

export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
  if (!roomState.has(sessionId)) {
    roomState.set(sessionId, {
      whiteboardId,
      createdBy,
      streamerSocketId: null,
      viewers: new Set(),
      sockets: new Map(),
    });
  }
  return roomState.get(sessionId);
};

export default function setupWebRTC(server) {
  io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

  io.on("connection", (socket) => {
    const safeEmit = (toSocketId, event, payload) => {
      const s = io.sockets.sockets.get(toSocketId);
      if (s) s.emit(event, payload);
    };

    // ======= Join Room =======
    socket.on("join_room", async ({ token, sessionId }) => {
      try {
        if (!token || !sessionId) return socket.emit("error_message", "Missing token or sessionId");

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;
        const userRole = decoded.role;

        const session = await LiveSession.findById(sessionId);
        if (!session) return socket.emit("error_message", "Session not found");

        // Private session validation
        if (session.isPrivate && !session.allowedUsers.includes(userId)) {
          return socket.emit("error_message", "You are not allowed to join this private session");
        }

        if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
          return socket.emit("error_message", `Session is ${session.status}`);
        }

        if (!roomState.has(sessionId)) {
          roomState.set(sessionId, { streamerSocketId: null, viewers: new Set(), sockets: new Map() });
        }

        const state = roomState.get(sessionId);
        state.sockets.set(socket.id, { userId, role: userRole });
        socket.data = { sessionId, userId, role: userRole };
        socket.join(sessionId);

        if (userRole === ROLE_MAP.STREAMER) {
          if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
            return socket.emit("error_message", "Streamer already connected");
          }
          state.streamerSocketId = socket.id;
          socket.emit("joined_room", { as: "STREAMER", sessionId });

        } else {
          const activeCount = state.viewers.size + (state.streamerSocketId ? 1 : 0);
          if (activeCount >= session.maxParticipants) {
            return socket.emit("error_message", "Room is full");
          }

          const participant = await LiveSessionParticipant.findOne({ sessionId, userId });
          if (!participant) {
            await LiveSessionParticipant.create({ sessionId, userId, socketId: socket.id, joinedAt: new Date() });
            session.totalJoins = (session.totalJoins || 0) + 1;
            await session.save();
          } else {
            participant.socketId = socket.id;
            participant.joinedAt = new Date();
            await participant.save();
          }

          state.viewers.add(socket.id);
          socket.emit("joined_room", { as: "VIEWER", sessionId });

          if (state.streamerSocketId) {
            safeEmit(state.streamerSocketId, "viewer_ready", { viewerSocketId: socket.id, viewerUserId: userId });
          }
        }

        // Update peak participants
        const currentParticipants = state.viewers.size + (state.streamerSocketId ? 1 : 0);
        if ((session.peakParticipants || 0) < currentParticipants) {
          session.peakParticipants = currentParticipants;
          await session.save();
        }

      } catch (err) {
        console.error("join_room error:", err.message);
        socket.emit("error_message", "Invalid token/session");
      }
    });

    // ======= Streamer Controls =======
    socket.on("streamer_start", async ({ sessionId }) => {
      const session = await LiveSession.findById(sessionId);
      if (!session) return;
      session.status = "ACTIVE";
      session.actualStartTime = new Date();
      await session.save();
      io.to(sessionId).emit("streamer_started", { sessionId });
    });

    socket.on("streamer_pause", async ({ sessionId }) => {
      const session = await LiveSession.findById(sessionId);
      if (!session) return;
      session.status = "PAUSED";
      await session.save();
      io.to(sessionId).emit("streamer_paused", { sessionId });
    });

    socket.on("streamer_resume", async ({ sessionId }) => {
      const session = await LiveSession.findById(sessionId);
      if (!session) return;
      session.status = "ACTIVE";
      await session.save();
      io.to(sessionId).emit("streamer_resumed", { sessionId });
    });

    // ======= WebRTC Signaling =======
    socket.on("offer", ({ sessionId, targetSocketId, sdp }) => {
      const state = roomState.get(sessionId);
      if (!state || state.streamerSocketId !== socket.id) return;
      safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
    });

    socket.on("answer", ({ sessionId, sdp }) => {
      const state = roomState.get(sessionId);
      if (!state) return;
      const meta = state.sockets.get(socket.id);
      if (!meta || meta.role === ROLE_MAP.STREAMER) return;
      safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
    });

    socket.on("ice-candidate", ({ sessionId, targetSocketId, candidate }) => {
      const state = roomState.get(sessionId);
      if (!state) return;
      safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
    });

    // ======= Leave / Disconnect =======
    socket.on("leave_room", async ({ sessionId }) => {
      await cleanupSocketFromRoom(io, socket, sessionId);
    });

    socket.on("disconnect", async () => {
      const sessionId = socket.data?.sessionId;
      if (sessionId) await cleanupSocketFromRoom(io, socket, sessionId);
    });

    socket.on("get_ice_servers", () => {
      socket.emit("ice_servers", getIceServersFromEnv());
    });

    // ======= Save Recording =======
    socket.on("save_recording", async ({ sessionId, recordingFiles }) => {
      try {
        const session = await LiveSession.findById(sessionId);
        if (!session) return;
        session.recordingUrl = [...(session.recordingUrl || []), ...recordingFiles];
        await session.save();
        socket.emit("recording_saved", { sessionId, recordingFiles });
      } catch (err) {
        console.error("save_recording error:", err.message);
        socket.emit("error_message", "Recording save failed");
      }
    });
  });

  return io;
}

// ======= Cleanup Helper =======
async function cleanupSocketFromRoom(io, socket, sessionId) {
  const state = roomState.get(sessionId);
  if (!state) return;

  const meta = state.sockets.get(socket.id);
  if (!meta) return;

  if (meta.role !== ROLE_MAP.STREAMER) {
    try { await LiveSessionParticipant.deleteOne({ socketId: socket.id }); } 
    catch (e) { console.error("cleanup deleteOne error:", e.message); }
    state.viewers.delete(socket.id);
    io.to(sessionId).emit("user_left", { userId: meta.userId, socketId: socket.id });
  } else {
    state.streamerSocketId = null;
    const session = await LiveSession.findById(sessionId);
    if (session) {
      session.status = "PAUSED";
      await session.save();
    }
    io.to(sessionId).emit("session_paused_or_ended_by_streamer");
  }

  state.sockets.delete(socket.id);
  socket.leave(sessionId);
}
