import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import liveSession from "../model/liveSessions/liveeSession.model.js";
import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
import { ROLE_MAP } from "../constant/role.js";

// ======= Global Variables =======
let io;
const roomState = new Map();

// ======= ICE Servers =======
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

// ======= Flush Helpers =======
// Throttled DB flush
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

// ======= Initialize Whiteboard Room =======
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

// ======= Setup Socket.io =======
export default function setupIntegratedSocket(server) {
  io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

  io.on("connection", (socket) => {
    console.log("New client connected:", socket.id);

    const safeEmit = (toSocketId, event, payload) => {
      const s = io.sockets.sockets.get(toSocketId);
      if (s) s.emit(event, payload);
    };

    // =========================
    // ===== JOIN ROOM ========
    // =========================
    socket.on("join_room", async ({ token, sessionId }) => {
      try {
        if (!token || !sessionId) return socket.emit("error_message", "Missing token or sessionId");

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;
        const userRole = decoded.role;

        const session = await liveSession.findById(sessionId);
        if (!session) return socket.emit("error_message", "Session not found");

        // Private session check
        if (session.isPrivate && !session.allowedUsers.includes(userId)) {
          return socket.emit("error_message", "You are not allowed to join this private session");
        }

        // Session status check
        if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
          return socket.emit("error_message", `Session is ${session.status}`);
        }

        // Init roomState
        if (!roomState.has(sessionId)) {
          roomState.set(sessionId, { streamerSocketId: null, viewers: new Set(), sockets: new Map() });
        }
        const state = roomState.get(sessionId);
        state.sockets.set(socket.id, { userId, role: userRole });
        socket.data = { sessionId, userId, role: userRole };
        socket.join(sessionId);

        // ===== Streamer / Viewer Logic =====
        if (userRole === ROLE_MAP.STREAMER) {
          if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
            return socket.emit("error_message", "Streamer already connected");
          }
          state.streamerSocketId = socket.id;
          socket.emit("joined_room", { as: "STREAMER", sessionId });
        } else {
          // Viewer logic
          const participant = await liveSessionParticipant.findOne({ sessionId, userId });
          if (!participant) {
            await liveSessionParticipant.create({ sessionId, userId, socketId: socket.id, joinedAt: new Date() });
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

        // ===== Whiteboard participant add =====
        if (state.whiteboardId) {
          const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
          if (wb) {
            const alreadyJoined = wb.participants.find(p => p.user.toString() === userId);
            if (!alreadyJoined) {
              wb.participants.push({ user: userId, role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer" });
              await wb.save();
            }
          }
        }

        // Peak participants
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

    // =========================
    // ===== CHAT MESSAGE =====
    // =========================
    socket.on("chat_message", ({ sessionId, message }) => {
      const state = roomState.get(sessionId);
      if (!state) return;
      const meta = state.sockets.get(socket.id);
      if (!meta) return;
      io.to(sessionId).emit("chat_message", { userId: meta.userId, message, socketId: socket.id });
    });

    // =========================
    // ===== STREAMER CONTROLS =====
    // =========================
    socket.on("streamer_start", async ({ sessionId }) => {
      const session = await liveSession.findById(sessionId);
      if (!session) return;
      session.status = "ACTIVE";
      session.actualStartTime = new Date();
      await session.save();
      io.to(sessionId).emit("streamer_started", { sessionId });
    });

    socket.on("streamer_pause", async ({ sessionId }) => {
      const session = await liveSession.findById(sessionId);
      if (!session) return;
      session.status = "PAUSED";
      await session.save();
      io.to(sessionId).emit("streamer_paused", { sessionId });
    });

    socket.on("streamer_resume", async ({ sessionId }) => {
      const session = await liveSession.findById(sessionId);
      if (!session) return;
      session.status = "ACTIVE";
      await session.save();
      io.to(sessionId).emit("streamer_resumed", { sessionId });
    });

    // =========================
    // ===== WEBRTC SIGNALING =====
    // =========================
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

    socket.on("get_ice_servers", () => {
      socket.emit("ice_servers", getIceServersFromEnv());
    });

    // =========================
    // ===== WHITEBOARD EVENTS =====
    // =========================
    // ===== WHITEBOARD: DRAW =====
    socket.on("whiteboard_draw", ({ sessionId, drawData, patch }) => {
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) return;
      const meta = state.sockets.get(socket.id);
      if (!meta) return;
      socket.to(sessionId).emit("whiteboard_draw", { userId: meta.userId, drawData });
      scheduleFlush(sessionId, { type: "draw", payload: drawData, patch, at: new Date() });
    });

    // ===== WHITEBOARD: ERASE =====
    socket.on("whiteboard_erase", ({ sessionId, eraseData, patch }) => {
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) return;
      const meta = state.sockets.get(socket.id);
      if (!meta) return;
      socket.to(sessionId).emit("whiteboard_erase", { userId: meta.userId, eraseData });
      scheduleFlush(sessionId, { type: "erase", payload: eraseData, patch, at: new Date() });
    });

    // ===== WHITEBOARD: UNDO =====
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

    // ===== WHITEBOARD: REDO =====
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

    // ===== WHITEBOARD: SAVE CANVAS =====
    socket.on("whiteboard_save_canvas", async ({ sessionId }) => {
      await flushCanvasOps(sessionId).catch(() => {});
      socket.emit("whiteboard_saved");
    });

    socket.on("cursor_update", ({ sessionId, position }) => {
      const state = roomState.get(sessionId);
      if (!state) return;
      socket.to(sessionId).emit("cursor_update", { userId: state.sockets.get(socket.id).userId, position });
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
      const sessionId = socket.data?.sessionId;
      if (!sessionId) return;
      const state = roomState.get(sessionId);
      if (!state) return;

      const meta = state.sockets.get(socket.id);
      if (!meta) return;

      // Whiteboard cleanup
      if (state.whiteboardId) {
        const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
        if (wb) {
          wb.participants = wb.participants.filter(p => p.user.toString() !== meta.userId);
          await wb.save();
        }
      }

      if (meta.role !== ROLE_MAP.STREAMER) {
        try { await liveSessionParticipant.deleteOne({ socketId: socket.id }); } 
        catch (e) { console.error("cleanup deleteOne error:", e.message); }
        state.viewers.delete(socket.id);
        io.to(sessionId).emit("user_left", { userId: meta.userId, socketId: socket.id });
      } else {
        state.streamerSocketId = null;
        const session = await liveSession.findById(sessionId);
        if (session) {
          session.status = "PAUSED";
          await session.save();
        }
        io.to(sessionId).emit("session_paused_or_ended_by_streamer");
      }

      state.sockets.delete(socket.id);
      socket.leave(sessionId);
    };

    socket.on("leave_room", cleanupSocketFromRoom);
    socket.on("disconnect", cleanupSocketFromRoom);

    // =========================
    // ===== RECORDING =====
    // =========================
    socket.on("save_recording", async ({ sessionId, recordingFiles }) => {
      try {
        const session = await liveSession.findById(sessionId);
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
