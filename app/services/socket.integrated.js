import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import liveSession from "../model/liveSessions/liveeSession.model.js";
import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
import { ROLE_MAP } from "../constant/role.js";
import crypto from "crypto";
// ======= Global Variables =======
let io;
const roomState = new Map(); // key: sessionId (string) -> { whiteboardId, createdBy, streamerSocketId, viewers: Set, sockets: Map, pendingOps, flushTimer }

// ======= ICE Servers Helper =======
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

// ======= Throttled Whiteboard DB flush =======
async function flushCanvasOps(sessionId) {
  const state = roomState.get(sessionId);
  if (!state || !state.whiteboardId) return;
  const ops = state.pendingOps || [];
  if (!ops.length) return;
  state.pendingOps = [];
  clearTimeout(state.flushTimer);
  state.flushTimer = null;

  const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
  if (!wb) return;
  for (const op of ops) {
    if (op.type === "draw") wb.totalDrawActions = (wb.totalDrawActions || 0) + 1;
    if (op.type === "erase") wb.totalErases = (wb.totalErases || 0) + 1;
    wb.undoStack = [...(wb.undoStack || []), op].slice(-500);
    if (op.type === "draw" || op.type === "erase") wb.redoStack = [];
    if (op.patch) wb.canvasData = { ...(wb.canvasData || {}), ...op.patch };
  }
  wb.lastActivity = new Date();
  await wb.save();
}

function scheduleFlush(sessionId, op) {
  const state = roomState.get(sessionId);
  if (!state) return;
  if (!state.pendingOps) state.pendingOps = [];
  state.pendingOps.push(op);
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => flushCanvasOps(sessionId).catch(() => {}), 2000);
}

// ======= Initialize Whiteboard Room (used by controller when creating session) =======
export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
  if (!roomState.has(sessionId)) {
    roomState.set(sessionId, {
      whiteboardId,
      createdBy,
      streamerSocketId: null,
      viewers: new Set(),
      sockets: new Map(),
      pendingOps: [],
      flushTimer: null,
    });
  } else {
    const s = roomState.get(sessionId);
    s.whiteboardId = s.whiteboardId || whiteboardId;
    s.createdBy = s.createdBy || createdBy;
  }
  return roomState.get(sessionId);
};

// ======= Setup Socket.io =======
export default function setupIntegratedSocket(server) {
  io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

  const safeEmit = (toSocketId, event, payload) => {
    const s = io.sockets.sockets.get(toSocketId);
    if (s) s.emit(event, payload);
  };

  io.on("connection", (socket) => {
    console.log("New client connected:", socket.id);

    socket.on("join_room", async ({ token, sessionId, roomCode }) => {
      try {
        if (!token || (!sessionId && !roomCode)) return socket.emit("error_message", "Missing token or sessionId/roomCode");

        let decoded;
        try {
          decoded = jwt.verify(token, process.env.SECRET_KEY);
        } catch (err) {
          return socket.emit("error_message", "Invalid token");
        }
        const userId = decoded.userId;
        const userRole = decoded.role;

        let session;
        if (sessionId) {
          session = await liveSession.findOne({ sessionId });
        } else {
          session = await liveSession.findOne({ roomCode });
        }

        if (!session) return socket.emit("error_message", "Session not found");
        if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
          return socket.emit("error_message", `Session is ${session.status}`);
        }

        if (session.isPrivate) {
          const allowed = Array.isArray(session.allowedUsers) && session.allowedUsers.some(u => u.toString() === userId);
          if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
        }

        // ✅ Use sessionId as key
        const sid = session.sessionId;
        if (!roomState.has(sid)) {
          roomState.set(sid, {
            whiteboardId: session.whiteboardId || null,
            createdBy: session.streamerId ? session.streamerId.toString() : null,
            streamerSocketId: null,
            viewers: new Set(),
            sockets: new Map(),
            pendingOps: [],
            flushTimer: null,
          });
        }
        const state = roomState.get(sid);

        // Max participants
        const activeCount = await liveSessionParticipant.countDocuments({ sessionId: session._id, status: { $ne: "LEFT" } });
        if ((session.maxParticipants || 100) <= activeCount && userRole !== ROLE_MAP.STREAMER) {
          return socket.emit("error_message", "Max participants limit reached");
        }

        // Check if banned
        let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
        if (participant && participant.isBanned) return socket.emit("error_message", "You are banned from this session");

        if (!participant) {
          participant = await liveSessionParticipant.create({
            sessionId: session._id,
            userId,
            socketId: socket.id,
            status: "JOINED",
            isActiveDevice: true,
            joinedAt: new Date()
          });
          session.totalJoins = (session.totalJoins || 0) + 1;
          await session.save();
        } else {
          participant.socketId = socket.id;
          participant.status = "JOINED";
          participant.isActiveDevice = true;
          participant.joinedAt = new Date();
          participant.leftAt = null;
          await participant.save();
        }

        // Join room
        state.sockets.set(socket.id, { userId, role: userRole });
        socket.data = { sessionId: sid, userId, role: userRole };
        socket.join(sid);

        if (userRole === ROLE_MAP.STREAMER) {
          if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
            return socket.emit("error_message", "Streamer already connected");
          }
          state.streamerSocketId = socket.id;
          socket.emit("joined_room", { as: "STREAMER", sessionId: sid, roomCode: session.roomCode });
        } else {
          state.viewers.add(socket.id);
          socket.emit("joined_room", { as: "VIEWER", sessionId: sid, roomCode: session.roomCode, whiteboardId: state.whiteboardId });
          if (state.streamerSocketId) {
            safeEmit(state.streamerSocketId, "viewer_ready", { viewerSocketId: socket.id, viewerUserId: userId });
          }
        }

        if (state.whiteboardId) {
          const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
          if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
            wb.participants.push({ user: userId, role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", joinedAt: new Date() });
            await wb.save();
          }
        }

        const currentParticipants = state.viewers.size + (state.streamerSocketId ? 1 : 0);
        if ((session.peakParticipants || 0) < currentParticipants) {
          session.peakParticipants = currentParticipants;
          await session.save();
        }

      } catch (err) {
        console.error("join_room error:", err);
        socket.emit("error_message", "Invalid token/session");
      }
    });
    // =========================
    
    // ===== CHAT MESSAGE =====
    // =========================
    // Emits to room and (optionally) persist via ChatMessage controller if you have one
    socket.on("chat_message", async ({ sessionId, message }) => {
      try {
        const state = roomState.get(sessionId);
        if (!state) return;
        const meta = state.sockets.get(socket.id);
        if (!meta) return;

        // ✅ Fetch sender name from User model
        const sender = await authenticationModel.findById(meta.userId).select("name");

        // broadcast
        io.to(sessionId).emit("chat_message", { 
          userId: meta.userId, 
          name: sender?.name || "Unknown",   // 👈 name include kiya
          message, 
          socketId: socket.id, 
          at: new Date() 
        });

      } catch (e) {
        console.error("chat_message error:", e.message);
      }
    });



    // =========================
    // ===== STREAMER CONTROLS =====
    // =========================
  socket.on("streamer_start", async ({ sessionId }) => {
    try {
      const session = await liveSession.findOne({ sessionId }); // <- fixed
      if (!session) return;
      session.status = "ACTIVE";
      session.actualStartTime = new Date();
      await session.save();
      io.to(sessionId).emit("streamer_started", { sessionId });
    } catch (e) { console.error(e.message); }
  });


    socket.on("streamer_pause", async ({ sessionId }) => {
      try {
        const session = await liveSession.findOne({ sessionId }); // <- fixed
        if (!session) return;
        session.status = "PAUSED";
        await session.save();
        io.to(sessionId).emit("streamer_paused", { sessionId });
      } catch (e) { console.error(e.message); }
    });


    socket.on("streamer_resume", async ({ sessionId }) => {
      try {
        const session = await liveSession.findOne({ sessionId }); // <- fixed
        if (!session) return;
        session.status = "ACTIVE";
        await session.save();
        io.to(sessionId).emit("streamer_resumed", { sessionId });
      } catch (e) { console.error(e.message); }
    });


    // =========================
    // ===== WEBRTC SIGNALING =====
    // =========================
    // Streamer sends offer to a target viewer socket id
    socket.on("offer", ({ sessionId, targetSocketId, sdp }) => {
      const state = roomState.get(sessionId);
      if (!state || state.streamerSocketId !== socket.id) return;
      safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
    });

    // Viewer sends answer back to streamer
    socket.on("answer", ({ sessionId, sdp }) => {
      const state = roomState.get(sessionId);
      if (!state) return;
      const meta = state.sockets.get(socket.id);
      if (!meta || meta.role === ROLE_MAP.STREAMER) return;
      safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
    });

    // ICE candidate exchange (both directions)
    socket.on("ice-candidate", ({ sessionId, targetSocketId, candidate }) => {
      const state = roomState.get(sessionId);
      if (!state) return;
      safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
    });

    socket.on("get_ice_servers", () => {
      socket.emit("ice_servers", getIceServersFromEnv());
    });

    // =========================
    // ===== WHITEBOARD EVENTS =====
    // =========================
    socket.on("whiteboard_draw", ({ sessionId, drawData, patch }) => {
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) return;
      const meta = state.sockets.get(socket.id);
      if (!meta) return;
      socket.to(sessionId).emit("whiteboard_draw", { userId: meta.userId, drawData });
      scheduleFlush(sessionId, { type: "draw", payload: drawData, patch, at: new Date() });
    });

    socket.on("whiteboard_erase", ({ sessionId, eraseData, patch }) => {
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) return;
      const meta = state.sockets.get(socket.id);
      if (!meta) return;
      socket.to(sessionId).emit("whiteboard_erase", { userId: meta.userId, eraseData });
      scheduleFlush(sessionId, { type: "erase", payload: eraseData, patch, at: new Date() });
    });

    socket.on("whiteboard_undo", async ({ sessionId }) => {
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) return;
      const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
      if (!wb) return;
      const last = (wb.undoStack || []).pop();
      if (!last) return;
      wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
      wb.lastActivity = new Date();
      await wb.save();
      io.to(sessionId).emit("whiteboard_undo_applied", { last });
    });

    socket.on("whiteboard_redo", async ({ sessionId }) => {
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) return;
      const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
      if (!wb) return;
      const last = (wb.redoStack || []).pop();
      if (!last) return;
      wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
      wb.lastActivity = new Date();
      await wb.save();
      io.to(sessionId).emit("whiteboard_redo_applied", { last });
    });

    socket.on("whiteboard_save_canvas", async ({ sessionId }) => {
      await flushCanvasOps(sessionId).catch(() => {});
      socket.emit("whiteboard_saved");
    });

    socket.on("cursor_update", ({ sessionId, position }) => {
      const state = roomState.get(sessionId);
      if (!state) return;
      const meta = state.sockets.get(socket.id);
      if (!meta) return;
      socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
    });

    socket.on("whiteboard_state_request", async ({ sessionId }) => {
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) return;
      const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
      if (!wb) return;
      socket.emit("whiteboard_state_sync", {
        canvasData: wb.canvasData,
        participants: wb.participants,
        versionHistory: wb.versionHistory,
      });
    });

    // =========================
    // ===== LEAVE / DISCONNECT =====
    // =========================
    const cleanupSocketFromRoom = async () => {
      try {
        const sid = socket.data?.sessionId;
        if (!sid) return;
        const state = roomState.get(sid);
        if (!state) return;

        const meta = state.sockets.get(socket.id);
        if (!meta) return;

        // Whiteboard soft leave
        if (state.whiteboardId) {
          const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
          if (wb) {
            const participant = wb.participants.find(p => p.user.toString() === meta.userId);
            if (participant) {
              participant.status = "LEFT";
              participant.leftAt = new Date();
            }
            await wb.save();
          }
        }

        // Update liveSessionParticipant record by userId and sessionId
        if (meta.role !== ROLE_MAP.STREAMER) {
          try {
            // 🔹 Replace ObjectId casting with string sessionId
            const participant = await liveSessionParticipant.findOne({ sessionId: sid, userId: meta.userId });
            // fallback: if above fails, try matching socketId
            const p = participant || await liveSessionParticipant.findOne({ socketId: socket.id });
            if (p) {
              p.status = "LEFT";
              p.leftAt = new Date();
              p.isActiveDevice = false;
              await p.save();
            }
          } catch (e) { console.error("cleanup update error:", e.message); }

          state.viewers.delete(socket.id);
          io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
        } else {
          // streamer left — pause session (or END depending on your business rules)
          state.streamerSocketId = null;

          // 🔹 Fixed: use sessionId field instead of _id
          const session = await liveSession.findOne({ sessionId: sid });
          if (session) {
            session.status = "PAUSED"; // or "ENDED"
            await session.save();
          }

          io.to(sid).emit("session_paused_or_ended_by_streamer");
        }

        state.sockets.delete(socket.id);
        socket.leave(sid);
      } catch (e) {
        console.error("cleanupSocketFromRoom error:", e.message);
      }
    };

    socket.on("leave_room", cleanupSocketFromRoom);
    socket.on("disconnect", cleanupSocketFromRoom);

    // =========================
    // ===== RECORDING =====
    // =========================
    socket.on("save_recording", async ({ sessionId, recordingFiles }) => {
      try {
        const session = await liveSession.findOne({ sessionId }); // <- fixed
        if (!session) return;
        session.recordingUrl = [...(session.recordingUrl || []), ...recordingFiles];
        await session.save();
        socket.emit("recording_saved", { sessionId, recordingFiles });
      } catch (err) {
        console.error("save_recording error:", err.message);
        socket.emit("error_message", "Recording save failed");
      }
    });
  }); // connection

  return io;
}

// ======= Get IO Instance =======
export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized yet");
  return io;
};
