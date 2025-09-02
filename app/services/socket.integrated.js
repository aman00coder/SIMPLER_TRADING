// socket.integrated.js
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import liveSession from "../model/liveSessions/liveeSession.model.js";
import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
import { ROLE_MAP } from "../constant/role.js";
import authenticationModel from "../../app/model/Authentication/authentication.model.js";

// ===== Global Variables =====
let io;
const roomState = new Map(); 
// key: sessionId -> { whiteboardId, createdBy, streamerSocketId, viewers: Set, sockets: Map, pendingOps, flushTimer }

// ===== ICE Servers Helper =====
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

// ===== Throttled Whiteboard DB flush =====
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

// ===== Initialize Whiteboard Room =====
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

// ===== Setup Socket.io =====
export default function setupIntegratedSocket(server) {
  io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

  const safeEmit = (toSocketId, event, payload) => {
    const s = io.sockets.sockets.get(toSocketId);
    if (s) s.emit(event, payload);
  };

  io.on("connection", (socket) => {
    console.log("New client connected:", socket.id);

    // ========= JOIN ROOM =========
    socket.on("join_room", async ({ token, sessionId, roomCode }) => {
      try {
        if (!token || (!sessionId && !roomCode)) return socket.emit("error_message", "Missing token or sessionId/roomCode");

        let decoded;
        try {
          decoded = jwt.verify(token, process.env.SECRET_KEY);
        } catch {
          return socket.emit("error_message", "Invalid token");
        }
        const userId = decoded.userId;
        const userRole = decoded.role;

        let session = sessionId
          ? await liveSession.findOne({ sessionId })
          : await liveSession.findOne({ roomCode });

        if (!session) return socket.emit("error_message", "Session not found");
        if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
          return socket.emit("error_message", `Session is ${session.status}`);
        }

        if (session.isPrivate) {
          const allowed = Array.isArray(session.allowedUsers) && session.allowedUsers.some(u => u.toString() === userId);
          if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
        }

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
        if (participant?.isBanned) return socket.emit("error_message", "You are banned from this session");

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

    // ========= CHAT =========
    socket.on("chat_message", async ({ sessionId, message }) => {
      try {
        const state = roomState.get(sessionId);
        if (!state) return;
        const meta = state.sockets.get(socket.id);
        if (!meta) return;

        const sender = await authenticationModel.findById(meta.userId).select("name");
        io.to(sessionId).emit("chat_message", {
          userId: meta.userId,
          name: sender?.name || "Unknown",
          message,
          socketId: socket.id,
          at: new Date()
        });
      } catch (e) {
        console.error("chat_message error:", e.message);
      }
    });

    // ========= STREAMER CONTROLS =========
    socket.on("streamer_start", async ({ sessionId }) => {
      const session = await liveSession.findOne({ sessionId });
      if (!session) return;
      session.status = "ACTIVE";
      session.actualStartTime = new Date();
      await session.save();
      io.to(sessionId).emit("streamer_started", { sessionId });
    });

    socket.on("streamer_pause", async ({ sessionId }) => {
      const session = await liveSession.findOne({ sessionId });
      if (!session) return;
      session.status = "PAUSED";
      await session.save();
      io.to(sessionId).emit("streamer_paused", { sessionId });
    });

    socket.on("streamer_resume", async ({ sessionId }) => {
      const session = await liveSession.findOne({ sessionId });
      if (!session) return;
      session.status = "ACTIVE";
      await session.save();
      io.to(sessionId).emit("streamer_resumed", { sessionId });
    });

    // ========= WEBRTC SIGNALING =========
    socket.on("offer", ({ sessionId, targetSocketId, sdp }) => {
      const state = roomState.get(sessionId);
      if (!state || state.streamerSocketId !== socket.id) return;
      safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
    });

    socket.on("viewer_offer", ({ sessionId, sdp }) => {
      const state = roomState.get(sessionId);
      if (!state || !state.streamerSocketId) return;
      safeEmit(state.streamerSocketId, "viewer_offer", { from: socket.id, sdp });
    });

    socket.on("viewer_answer", ({ sessionId, targetSocketId, sdp }) => {
      safeEmit(targetSocketId, "viewer_answer", { from: socket.id, sdp });
    });

    socket.on("ice-candidate", ({ sessionId, targetSocketId, candidate }) => {
      safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
    });

    socket.on("get_ice_servers", () => {
      socket.emit("ice_servers", getIceServersFromEnv());
    });

    // ========= WHITEBOARD EVENTS =========
    socket.on("whiteboard_draw", ({ sessionId, drawData, patch }) => {
      const state = roomState.get(sessionId);
      if (!state?.whiteboardId) return;
      const meta = state.sockets.get(socket.id);
      if (!meta) return;
      socket.to(sessionId).emit("whiteboard_draw", { userId: meta.userId, drawData });
      scheduleFlush(sessionId, { type: "draw", payload: drawData, patch, at: new Date() });
    });

    socket.on("whiteboard_erase", ({ sessionId, eraseData, patch }) => {
      const state = roomState.get(sessionId);
      if (!state?.whiteboardId) return;
      const meta = state.sockets.get(socket.id);
      if (!meta) return;
      socket.to(sessionId).emit("whiteboard_erase", { userId: meta.userId, eraseData });
      scheduleFlush(sessionId, { type: "erase", payload: eraseData, patch, at: new Date() });
    });

    socket.on("whiteboard_undo", async ({ sessionId }) => {
      const state = roomState.get(sessionId);
      if (!state?.whiteboardId) return;
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
      if (!state?.whiteboardId) return;
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
      if (!state?.whiteboardId) return;
      const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
      if (!wb) return;
      socket.emit("whiteboard_state_sync", {
        canvasData: wb.canvasData,
        participants: wb.participants,
        versionHistory: wb.versionHistory,
      });
    });

    // ========= LEAVE / DISCONNECT =========
    const cleanupSocketFromRoom = async () => {
      try {
        const sid = socket.data?.sessionId;
        if (!sid) return;
        const state = roomState.get(sid);
        if (!state) return;

        const meta = state.sockets.get(socket.id);
        if (!meta) return;

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

        if (meta.role !== ROLE_MAP.STREAMER) {
          const participant = await liveSessionParticipant.findOne({ sessionId: sid, userId: meta.userId }) 
            || await liveSessionParticipant.findOne({ socketId: socket.id });
          if (participant) {
            participant.status = "LEFT";
            participant.leftAt = new Date();
            participant.isActiveDevice = false;
            await participant.save();
          }
          state.viewers.delete(socket.id);
          io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
        } else {
          state.streamerSocketId = null;
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

    // ========= RECORDING =========
    socket.on("save_recording", async ({ sessionId, recordingFiles }) => {
      try {
        const session = await liveSession.findOne({ sessionId });
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

// ===== Get IO Instance =====
export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized yet");
  return io;
};
