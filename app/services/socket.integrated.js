import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import mediasoup from "mediasoup";
import liveSession from "../model/liveSessions/liveeSession.model.js";
import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
import { ROLE_MAP } from "../constant/role.js";
import authenticationModel from "../../app/model/Authentication/authentication.model.js";
import crypto from "crypto";

// ======= Global Variables =======
let io;
let mediasoupWorker;
const roomState = new Map();

// ======= Export getIO function =======
export const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
  }
  return io;
};

// ======= Mediasoup Worker Initialization =======
const createMediasoupWorker = async () => {
  try {
    const minPort = parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000;
    const maxPort = parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999;
    const logLevel = process.env.MEDIASOUP_LOG_LEVEL || "warn";

    mediasoupWorker = await mediasoup.createWorker({
      logLevel,
      rtcMinPort: minPort,
      rtcMaxPort: maxPort,
    });

    console.log(`Mediasoup Worker Created (Ports: ${minPort}-${maxPort}) for ${process.env.NODE_ENV} environment`);

    mediasoupWorker.on("died", () => {
      console.error("Mediasoup worker died, restarting in 2 seconds...");
      setTimeout(() => {
        createMediasoupWorker().catch(console.error);
      }, 2000);
    });

    return mediasoupWorker;
  } catch (error) {
    console.error("Failed to create Mediasoup worker:", error);
    throw error;
  }
};

// ======= ICE Servers Helper (Both Environments) =======
function getIceServersFromEnv() {
  const isProduction = process.env.NODE_ENV === "production";
  console.log(`Getting ICE servers for ${isProduction ? "production" : "development"} environment`);

  const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const servers = [];

  stunUrls.forEach((url) => {
    if (url) servers.push({ urls: url });
  });

  // Uncomment and configure TURN for production if needed
  // if (isProduction) { ... }

  if (servers.length === 0) {
    servers.push({ urls: "stun:stun.l.google.com:19302" });
    servers.push({ urls: "stun:global.stun.twilio.com:3478" });
  }

  console.log(`Found ${servers.length} ICE servers`);
  return servers;
}

// ======= Throttled Whiteboard DB flush =======
async function flushCanvasOps(sessionId) {
  console.log(`Flushing canvas operations for session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || !state.whiteboardId) {
    console.log(`No state or whiteboardId found for session: ${sessionId}`);
    return;
  }
  const ops = state.pendingOps || [];
  if (!ops.length) {
    console.log(`No pending operations for session: ${sessionId}`);
    return;
  }
  console.log(`Flushing ${ops.length} operations for session: ${sessionId}`);
  // clear pending ops + timer
  state.pendingOps = [];
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }

  const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
  if (!wb) {
    console.log(`Whiteboard not found with ID: ${state.whiteboardId}`);
    return;
  }

  for (const op of ops) {
    if (op.type === "draw") wb.totalDrawActions = (wb.totalDrawActions || 0) + 1;
    if (op.type === "erase") wb.totalErases = (wb.totalErases || 0) + 1;

    wb.undoStack = [...(wb.undoStack || []), op].slice(-500);

    // when a new draw/erase happens, clear redo stack
    if (op.type === "draw" || op.type === "erase") wb.redoStack = [];

    if (op.patch) {
      wb.canvasData = { ...(wb.canvasData || {}), ...op.patch };
    }
  }

  wb.lastActivity = new Date();
  await wb.save();
  console.log(`Canvas operations flushed for session: ${sessionId}`);
}

function scheduleFlush(sessionId, op) {
  console.log(`Scheduling flush for session: ${sessionId}, operation type: ${op?.type}`);
  const state = roomState.get(sessionId);
  if (!state) {
    console.log(`No state found for session: ${sessionId}`);
    return;
  }
  if (!state.pendingOps) state.pendingOps = [];
  state.pendingOps.push(op);
  if (state.flushTimer) {
    console.log(`Flush already scheduled for session: ${sessionId}`);
    return;
  }
  state.flushTimer = setTimeout(() => {
    flushCanvasOps(sessionId).catch((err) => {
      console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
    });
  }, 2000);
  console.log(`Flush scheduled for session: ${sessionId}`);
}

// ======= Initialize Whiteboard Room =======
export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
  console.log(`Initializing whiteboard RTC for session: ${sessionId}, whiteboard: ${whiteboardId}, createdBy: ${createdBy}`);
  if (!roomState.has(sessionId)) {
    roomState.set(sessionId, {
      whiteboardId,
      createdBy,
      streamerSocketId: null,
      viewers: new Set(),
      sockets: new Map(),
      pendingOps: [],
      flushTimer: null,
      router: null,
      transports: new Map(),
      producers: new Map(),
    });
    console.log(`New room state created for session: ${sessionId}`);
  } else {
    const s = roomState.get(sessionId);
    s.whiteboardId = s.whiteboardId || whiteboardId;
    s.createdBy = s.createdBy || createdBy;
    console.log(`Existing room state updated for session: ${sessionId}`);
  }
  return roomState.get(sessionId);
};

// ======= Setup Socket.io =======
export default async function setupIntegratedSocket(server) {
  console.log("Setting up integrated socket");

  // Create Mediasoup Worker
  try {
    await createMediasoupWorker();
  } catch (error) {
    console.error("Failed to initialize Mediasoup:", error);
    throw error;
  }

  // CORS Configuration for both environments
  const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5174";

  io = new Server(server, {
    cors: {
      origin: corsOrigin,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  console.log(`Socket.io configured with CORS origin: ${corsOrigin} for ${process.env.NODE_ENV} environment`);

  const safeEmit = (toSocketId, event, payload) => {
    try {
      const s = io.sockets.sockets.get(toSocketId);
      if (s) {
        s.emit(event, payload);
        console.log(`Emitted ${event} to socket: ${toSocketId}`);
      } else {
        console.log(`Socket not found: ${toSocketId}`);
      }
    } catch (err) {
      console.error("safeEmit error:", err);
    }
  };

  io.on("connection", (socket) => {
    console.log("New client connected:", socket.id);

    // Send environment info to client
    socket.emit("environment_info", {
      environment: process.env.NODE_ENV,
      hasMediasoup: true,
      hasTURN: false, // Currently no TURN in development
    });

    socket.on("join_room", async ({ token, sessionId, roomCode }) => {
      console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);
      try {
        if (!token || (!sessionId && !roomCode)) {
          console.log("Missing token or sessionId/roomCode");
          return socket.emit("error_message", "Missing token or sessionId/roomCode");
        }

        let decoded;
        try {
          decoded = jwt.verify(token, process.env.SECRET_KEY);
          console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
        } catch (err) {
          console.log("Invalid token:", err.message);
          return socket.emit("error_message", "Invalid token");
        }
        const userId = decoded.userId;
        const userRole = decoded.role;

        let session;
        if (sessionId) {
          console.log(`Looking for session by sessionId: ${sessionId}`);
          session = await liveSession.findOne({ sessionId });
        } else {
          console.log(`Looking for session by roomCode: ${roomCode}`);
          session = await liveSession.findOne({ roomCode });
        }

        if (!session) {
          console.log("Session not found");
          return socket.emit("error_message", "Session not found");
        }

        console.log(`Session found: ${session.sessionId}, status: ${session.status}`);
        if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
          console.log(`Session is ${session.status}, cannot join`);
          return socket.emit("error_message", `Session is ${session.status}`);
        }

        if (session.isPrivate) {
          console.log("Checking private session permissions");
          const allowed = Array.isArray(session.allowedUsers) && session.allowedUsers.some((u) => u.toString() === userId);
          if (!allowed) {
            console.log("User not allowed to join private session");
            return socket.emit("error_message", "You are not allowed to join this private session");
          }
        }

        // Use sessionId as key
        const sid = session.sessionId;
        console.log(`Using session ID as key: ${sid}`);
        if (!roomState.has(sid)) {
          roomState.set(sid, {
            whiteboardId: session.whiteboardId || null,
            createdBy: session.streamerId ? session.streamerId.toString() : null,
            streamerSocketId: null,
            viewers: new Set(),
            sockets: new Map(),
            pendingOps: [],
            flushTimer: null,
            router: null,
            transports: new Map(),
            producers: new Map(),
          });
          console.log(`New room state created for session: ${sid}`);
        }
        const state = roomState.get(sid);

        // Max participants - environment specific limits
        const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
        const activeCount = await liveSessionParticipant.countDocuments({ sessionId: session._id, status: { $ne: "LEFT" } });
        console.log(`Active participants: ${activeCount}, max allowed: ${maxParticipants}`);
        if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
          console.log("Max participants limit reached");
          return socket.emit("error_message", "Max participants limit reached");
        }

        // Check if banned
        let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
        if (participant && participant.isBanned) {
          console.log("User is banned from this session");
          return socket.emit("error_message", "You are banned from this session");
        }

        if (!participant) {
          console.log("Creating new participant record");
          participant = await liveSessionParticipant.create({
            sessionId: session._id,
            userId,
            socketId: socket.id,
            status: "JOINED",
            isActiveDevice: true,
            joinedAt: new Date(),
          });
          session.totalJoins = (session.totalJoins || 0) + 1;
          await session.save();
          console.log(`New participant created, total joins: ${session.totalJoins}`);
        } else {
          console.log("Updating existing participant record");
          participant.socketId = socket.id;
          participant.status = "JOINED";
          participant.isActiveDevice = true;
          participant.joinedAt = new Date();
          participant.leftAt = null;
          await participant.save();
        }

        // Create Mediasoup Router if streamer and not exists
        if (userRole === ROLE_MAP.STREAMER && !state.router) {
          console.log("Creating Mediasoup router for session:", sid);
          const mediaCodecs = [
            {
              kind: "audio",
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
            },
            {
              kind: "video",
              mimeType: "video/VP8",
              clockRate: 90000,
              parameters: {
                "x-google-start-bitrate": process.env.NODE_ENV === "production" ? 500000 : 1000000,
              },
            },
          ];

          state.router = await mediasoupWorker.createRouter({ mediaCodecs });
          console.log("Mediasoup router created for session:", sid);
        }

        // Join room
        state.sockets.set(socket.id, { userId, role: userRole });
        socket.data = { sessionId: sid, userId, role: userRole };
        socket.join(sid);
        console.log(`Socket ${socket.id} joined room ${sid}`);

        if (userRole === ROLE_MAP.STREAMER) {
          console.log("User is a streamer");
          if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
            console.log("Streamer already connected");
            return socket.emit("error_message", "Streamer already connected");
          }
          state.streamerSocketId = socket.id;
          socket.emit("joined_room", {
            as: "STREAMER",
            sessionId: sid,
            roomCode: session.roomCode,
            hasMediasoup: !!state.router,
            environment: process.env.NODE_ENV,
          });
          console.log(`Streamer ${socket.id} joined room ${sid}`);
        } else {
          state.viewers.add(socket.id);
          socket.emit("joined_room", {
            as: "VIEWER",
            sessionId: sid,
            roomCode: session.roomCode,
            whiteboardId: state.whiteboardId,
            hasMediasoup: !!state.router,
            environment: process.env.NODE_ENV,
          });
          console.log(`Viewer ${socket.id} joined room ${sid}`);
          if (state.streamerSocketId) {
            safeEmit(state.streamerSocketId, "viewer_ready", { viewerSocketId: socket.id, viewerUserId: userId });
          }
        }

        if (state.whiteboardId) {
          console.log(`Adding user to whiteboard: ${state.whiteboardId}`);
          const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
          if (wb && !wb.participants.find((p) => p.user.toString() === userId)) {
            wb.participants.push({ user: userId, role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", joinedAt: new Date() });
            await wb.save();
            console.log(`User added to whiteboard: ${state.whiteboardId}`);
          }
        }

        const currentParticipants = state.viewers.size + (state.streamerSocketId ? 1 : 0);
        console.log(`Current participants: ${currentParticipants}, peak: ${session.peakParticipants || 0}`);
        if ((session.peakParticipants || 0) < currentParticipants) {
          session.peakParticipants = currentParticipants;
          await session.save();
          console.log(`New peak participants: ${currentParticipants}`);
        }
      } catch (err) {
        console.error("join_room error:", err);
        socket.emit("error_message", "Invalid token/session");
      }
    });

    // =========================
    // ===== MEDIASOUP EVENTS =====
    // =========================

    // Get Router RTP Capabilities
    socket.on("getRouterRtpCapabilities", async ({ sessionId }, callback) => {
      try {
        console.log("getRouterRtpCapabilities for session:", sessionId);
        const state = roomState.get(sessionId);
        if (!state || !state.router) {
          return callback({ error: "Router not found" });
        }
        callback({ rtpCapabilities: state.router.rtpCapabilities });
      } catch (error) {
        console.error("getRouterRtpCapabilities error:", error);
        callback({ error: error.message });
      }
    });

    // Create WebRTC Transport
    socket.on("createWebRtcTransport", async ({ sessionId }, callback) => {
      try {
        console.log("createWebRtcTransport for session:", sessionId);
        const state = roomState.get(sessionId);
        if (!state || !state.router) {
          return callback({ error: "Router not found" });
        }

        const transport = await state.router.createWebRtcTransport({
          listenIps: [
            {
              ip: "0.0.0.0",
              announcedIp: process.env.SERVER_IP || "127.0.0.1",
            },
          ],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: process.env.NODE_ENV === "production" ? 500000 : 1000000,
        });

        transport.on("dtlsstatechange", (dtlsState) => {
          if (dtlsState === "closed") {
            transport.close();
          }
        });

        // Store socket ID with transport for cleanup
        transport.appData = { socketId: socket.id };
        state.transports.set(transport.id, transport);

        callback({
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          },
        });
      } catch (error) {
        console.error("createWebRtcTransport error:", error);
        callback({ error: error.message });
      }
    });

    // Connect Transport
    socket.on("transport-connect", async ({ sessionId, transportId, dtlsParameters }, callback) => {
      try {
        console.log("transport-connect for transport:", transportId);
        const state = roomState.get(sessionId);
        if (!state) {
          return callback({ error: "Session not found" });
        }

        const transport = state.transports.get(transportId);
        if (!transport) {
          return callback({ error: "Transport not found" });
        }

        await transport.connect({ dtlsParameters });
        callback({ success: true });
      } catch (error) {
        console.error("transport-connect error:", error);
        callback({ error: error.message });
      }
    });

    // Produce Media
    socket.on("produce", async ({ sessionId, transportId, kind, rtpParameters }, callback) => {
      try {
        console.log("produce for transport:", transportId, "kind:", kind);
        const state = roomState.get(sessionId);
        if (!state) {
          return callback({ error: "Session not found" });
        }

        const transport = state.transports.get(transportId);
        if (!transport) {
          return callback({ error: "Transport not found" });
        }

        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData: {
            socketId: socket.id,
            environment: process.env.NODE_ENV,
          },
        });

        state.producers.set(producer.id, producer);

        producer.on("transportclose", () => {
          console.log("Producer transport closed:", producer.id);
          try {
            producer.close();
          } catch (e) {
            // ignore
          }
          state.producers.delete(producer.id);
        });

        callback({ id: producer.id });

        // Broadcast new producer to other participants
        socket.to(sessionId).emit("new-producer", {
          producerId: producer.id,
          kind: producer.kind,
          userId: socket.data.userId,
        });
      } catch (error) {
        console.error("produce error:", error);
        callback({ error: error.message });
      }
    });

    // Consume Media
    socket.on("consume", async ({ sessionId, transportId, producerId, rtpCapabilities }, callback) => {
      try {
        console.log("consume for producer:", producerId);
        const state = roomState.get(sessionId);
        if (!state || !state.router) {
          return callback({ error: "Router not found" });
        }

        const producer = state.producers.get(producerId);
        if (!producer) {
          return callback({ error: "Producer not found" });
        }

        if (!state.router.canConsume({ producerId, rtpCapabilities })) {
          return callback({ error: "Cannot consume" });
        }

        const transport = state.transports.get(transportId);
        if (!transport) {
          return callback({ error: "Transport not found" });
        }

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true,
          appData: {
            socketId: socket.id,
            environment: process.env.NODE_ENV,
          },
        });

        consumer.on("transportclose", () => {
          console.log("Consumer transport closed:", consumer.id);
          try {
            consumer.close();
          } catch (e) {
            // ignore
          }
        });

        callback({
          params: {
            id: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          },
        });
      } catch (error) {
        console.error("consume error:", error);
        callback({ error: error.message });
      }
    });

    // Resume Consumer
    socket.on("consumer-resume", async ({ sessionId, consumerId }, callback) => {
      try {
        console.log("consumer-resume for consumer:", consumerId);
        const state = roomState.get(sessionId);
        if (!state) {
          return callback({ error: "Session not found" });
        }

        // Find consumer by checking all transports (each transport is a mediasoup transport instance)
        let consumer = null;
        for (const [, transport] of state.transports) {
          if (transport && transport.consumers) {
            try {
              consumer = transport.consumers.get(consumerId);
              if (consumer) break;
            } catch (e) {
              // continue searching
            }
          }
        }

        if (!consumer) {
          return callback({ error: "Consumer not found" });
        }

        await consumer.resume();
        callback({ success: true });
      } catch (error) {
        console.error("consumer-resume error:", error);
        callback({ error: error.message });
      }
    });

    // Get ICE Servers
    socket.on("get_ice_servers", (callback) => {
      console.log(`ICE servers request from socket: ${socket.id}`);
      const iceServers = getIceServersFromEnv();
      callback(iceServers);
    });

    // =========================
    // ===== CHAT MESSAGE =====
    // =========================
    socket.on("chat_message", async ({ sessionId, message }) => {
      console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}, message: ${message}`);
      try {
        const state = roomState.get(sessionId);
        if (!state) {
          console.log(`No state found for session: ${sessionId}`);
          return;
        }
        const meta = state.sockets.get(socket.id);
        if (!meta) {
          console.log(`No metadata found for socket: ${socket.id}`);
          return;
        }

        // Fetch sender name from authenticationModel
        const sender = await authenticationModel.findById(meta.userId).select("name");
        console.log(`Sender: ${sender?.name || "Unknown"}, userId: ${meta.userId}`);

        // broadcast
        io.to(sessionId).emit("chat_message", {
          userId: meta.userId,
          name: sender?.name || "Unknown",
          message,
          socketId: socket.id,
          at: new Date(),
        });
        console.log(`Chat message broadcast to session: ${sessionId}`);
      } catch (e) {
        console.error("chat_message error:", e?.message || e);
      }
    });

    // =========================
    // ===== STREAMER CONTROLS =====
    // =========================
    socket.on("streamer_start", async ({ sessionId }) => {
      console.log(`Streamer start request for session: ${sessionId}`);
      try {
        const session = await liveSession.findOne({ sessionId });
        if (!session) {
          console.log(`Session not found: ${sessionId}`);
          return;
        }
        session.status = "ACTIVE";
        session.actualStartTime = new Date();
        await session.save();
        io.to(sessionId).emit("streamer_started", { sessionId });
        console.log(`Session ${sessionId} started by streamer`);
      } catch (e) {
        console.error("streamer_start error:", e?.message || e);
      }
    });

    socket.on("streamer_pause", async ({ sessionId }) => {
      console.log(`Streamer pause request for session: ${sessionId}`);
      try {
        const session = await liveSession.findOne({ sessionId });
        if (!session) {
          console.log(`Session not found: ${sessionId}`);
          return;
        }
        session.status = "PAUSED";
        await session.save();
        io.to(sessionId).emit("streamer_paused", { sessionId });
        console.log(`Session ${sessionId} paused by streamer`);
      } catch (e) {
        console.error("streamer_pause error:", e?.message || e);
      }
    });

    socket.on("streamer_resume", async ({ sessionId }) => {
      console.log(`Streamer resume request for session: ${sessionId}`);
      try {
        const session = await liveSession.findOne({ sessionId });
        if (!session) {
          console.log(`Session not found: ${sessionId}`);
          return;
        }
        session.status = "ACTIVE";
        await session.save();
        io.to(sessionId).emit("streamer_resumed", { sessionId });
        console.log(`Session ${sessionId} resumed by streamer`);
      } catch (e) {
        console.error("streamer_resume error:", e?.message || e);
      }
    });

    // =========================
    // ===== WEBRTC SIGNALING =====
    // =========================
    socket.on("offer", ({ sessionId, targetSocketId, sdp }) => {
      console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
      const state = roomState.get(sessionId);
      if (!state || state.streamerSocketId !== socket.id) {
        console.log(`Invalid offer: no state or not streamer`);
        return;
      }
      safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
    });

    socket.on("answer", ({ sessionId, sdp }) => {
      console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
      const state = roomState.get(sessionId);
      if (!state) {
        console.log(`No state found for session: ${sessionId}`);
        return;
      }
      const meta = state.sockets.get(socket.id);
      if (!meta || meta.role === ROLE_MAP.STREAMER) {
        console.log(`Invalid answer: no metadata or is streamer`);
        return;
      }
      safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
    });

    socket.on("ice-candidate", ({ sessionId, targetSocketId, candidate }) => {
      console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
      const state = roomState.get(sessionId);
      if (!state) {
        console.log(`No state found for session: ${sessionId}`);
        return;
      }
      safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
    });

    // =========================
    // ===== WHITEBOARD EVENTS =====
    // =========================
    socket.on("whiteboard_draw", ({ sessionId, drawData, patch }) => {
      console.log(`Whiteboard draw from socket: ${socket.id}, session: ${sessionId}`);
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) {
        console.log(`No state or whiteboardId found for session: ${sessionId}`);
        return;
      }
      const meta = state.sockets.get(socket.id);
      if (!meta) {
        console.log(`No metadata found for socket: ${socket.id}`);
        return;
      }
      socket.to(sessionId).emit("whiteboard_draw", { userId: meta.userId, drawData });
      scheduleFlush(sessionId, { type: "draw", payload: drawData, patch, at: new Date() });
    });

    socket.on("whiteboard_erase", ({ sessionId, eraseData, patch }) => {
      console.log(`Whiteboard erase from socket: ${socket.id}, session: ${sessionId}`);
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) {
        console.log(`No state or whiteboardId found for session: ${sessionId}`);
        return;
      }
      const meta = state.sockets.get(socket.id);
      if (!meta) {
        console.log(`No metadata found for socket: ${socket.id}`);
        return;
      }
      socket.to(sessionId).emit("whiteboard_erase", { userId: meta.userId, eraseData });
      scheduleFlush(sessionId, { type: "erase", payload: eraseData, patch, at: new Date() });
    });

    socket.on("whiteboard_undo", async ({ sessionId }) => {
      console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) {
        console.log(`No state or whiteboardId found for session: ${sessionId}`);
        return;
      }
      const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
      if (!wb) {
        console.log(`Whiteboard not found with ID: ${state.whiteboardId}`);
        return;
      }

      const undoStack = wb.undoStack || [];
      if (undoStack.length === 0) {
        console.log(`No operations to undo for whiteboard: ${state.whiteboardId}`);
        return;
      }

      // pop last op and update stacks
      const last = undoStack.pop();
      wb.undoStack = undoStack.slice(-500);
      wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
      wb.lastActivity = new Date();
      await wb.save();
      io.to(sessionId).emit("whiteboard_undo_applied", { last });
      console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
    });

    socket.on("whiteboard_redo", async ({ sessionId }) => {
      console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) {
        console.log(`No state or whiteboardId found for session: ${sessionId}`);
        return;
      }
      const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
      if (!wb) {
        console.log(`Whiteboard not found with ID: ${state.whiteboardId}`);
        return;
      }

      const redoStack = wb.redoStack || [];
      if (redoStack.length === 0) {
        console.log(`No operations to redo for whiteboard: ${state.whiteboardId}`);
        return;
      }

      const last = redoStack.pop();
      wb.redoStack = redoStack.slice(-500);
      wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
      wb.lastActivity = new Date();
      await wb.save();
      io.to(sessionId).emit("whiteboard_redo_applied", { last });
      console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
    });

    socket.on("whiteboard_save_canvas", async ({ sessionId }) => {
      console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
      await flushCanvasOps(sessionId).catch((err) => {
        console.error(`Error saving canvas for session ${sessionId}:`, err);
      });
      socket.emit("whiteboard_saved");
      console.log(`Whiteboard saved for session: ${sessionId}`);
    });

    socket.on("cursor_update", ({ sessionId, position }) => {
      console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
      const state = roomState.get(sessionId);
      if (!state) {
        console.log(`No state found for session: ${sessionId}`);
        return;
      }
      const meta = state.sockets.get(socket.id);
      if (!meta) {
        console.log(`No metadata found for socket: ${socket.id}`);
        return;
      }
      socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
    });

    socket.on("whiteboard_state_request", async ({ sessionId }) => {
      console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
      const state = roomState.get(sessionId);
      if (!state || !state.whiteboardId) {
        console.log(`No state or whiteboardId found for session: ${sessionId}`);
        return;
      }
      const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
      if (!wb) {
        console.log(`Whiteboard not found with ID: ${state.whiteboardId}`);
        return;
      }
      socket.emit("whiteboard_state_sync", {
        canvasData: wb.canvasData,
        participants: wb.participants,
        versionHistory: wb.versionHistory,
      });
      console.log(`Whiteboard state sent to socket: ${socket.id}`);
    });

    // =========================
    // ===== LEAVE / DISCONNECT =====
    // =========================
    const cleanupSocketFromRoom = async () => {
      console.log(`Cleanup requested for socket: ${socket.id}`);
      try {
        const sid = socket.data?.sessionId;
        if (!sid) {
          console.log(`No session ID found for socket: ${socket.id}`);
          return;
        }
        const state = roomState.get(sid);
        if (!state) {
          console.log(`No state found for session: ${sid}`);
          return;
        }

        const meta = state.sockets.get(socket.id);
        if (!meta) {
          console.log(`No metadata found for socket: ${socket.id}`);
          return;
        }

        // Cleanup Mediasoup transports created by this socket
        for (const [transportId, transport] of state.transports) {
          try {
            if (transport && transport.appData && transport.appData.socketId === socket.id) {
              transport.close();
              state.transports.delete(transportId);
            }
          } catch (e) {
            console.warn("Transport cleanup error:", e);
          }
        }

        // Remove producers created by this socket
        for (const [producerId, producer] of state.producers) {
          try {
            if (producer && producer.appData && producer.appData.socketId === socket.id) {
              producer.close();
              state.producers.delete(producerId);
            }
          } catch (e) {
            console.warn("Producer cleanup error:", e);
          }
        }

        // Whiteboard soft leave
        if (state.whiteboardId) {
          console.log(`Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`);
          const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
          if (wb) {
            const participant = wb.participants.find((p) => p.user.toString() === meta.userId);
            if (participant) {
              participant.status = "LEFT";
              participant.leftAt = new Date();
            }
            await wb.save();
            console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
          }
        }

        // Update liveSessionParticipant record by userId and sessionId
        if (meta.role !== ROLE_MAP.STREAMER) {
          try {
            const participant = await liveSessionParticipant.findOne({ sessionId: sid, userId: meta.userId });
            const p = participant || (await liveSessionParticipant.findOne({ socketId: socket.id }));
            if (p) {
              p.status = "LEFT";
              p.leftAt = new Date();
              p.isActiveDevice = false;
              await p.save();
              console.log(`Participant ${meta.userId} marked as LEFT`);
            }
          } catch (e) {
            console.error("cleanup update error:", e?.message || e);
          }

          state.viewers.delete(socket.id);
          io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
          console.log(`Viewer ${socket.id} left room ${sid}`);
        } else {
          // streamer left — pause session
          state.streamerSocketId = null;
          console.log(`Streamer ${socket.id} left room ${sid}`);

          // Cleanup Mediasoup router when streamer leaves
          if (state.router) {
            try {
              state.router.close();
            } catch (e) {
              console.warn("Error closing router:", e);
            }
            state.router = null;
            console.log(`Mediasoup router closed for session: ${sid}`);
          }

          const session = await liveSession.findOne({ sessionId: sid });
          if (session) {
            session.status = "PAUSED";
            await session.save();
            console.log(`Session ${sid} paused due to streamer leaving`);
          }

          io.to(sid).emit("session_paused_or_ended_by_streamer");
        }

        state.sockets.delete(socket.id);
        socket.leave(sid);
        console.log(`Socket ${socket.id} removed from room state for session: ${sid}`);
      } catch (e) {
        console.error("cleanupSocketFromRoom error:", e?.message || e);
      }
    };

    socket.on("leave_room", () => {
      console.log(`Explicit leave_room request from socket: ${socket.id}`);
      cleanupSocketFromRoom();
    });

    socket.on("disconnect", (reason) => {
      console.log(`Socket disconnected: ${socket.id}, reason: ${reason}`);
      cleanupSocketFromRoom();
    });

    // =========================
    // ===== RECORDING =====
    // =========================
    socket.on("save_recording", async ({ sessionId, recordingFiles }) => {
      console.log(`Save recording request for session: ${sessionId}, files: ${Array.isArray(recordingFiles) ? recordingFiles.length : "unknown"}`);
      try {
        const session = await liveSession.findOne({ sessionId });
        if (!session) {
          console.log(`Session not found: ${sessionId}`);
          return;
        }
        session.recordingUrl = [...(session.recordingUrl || []), ...(recordingFiles || [])];
        await session.save();
        socket.emit("recording_saved", { sessionId, recordingFiles });
        console.log(`Recording saved for session: ${sessionId}`);
      } catch (err) {
        console.error("save_recording error:", err?.message || err);
        socket.emit("error_message", "Recording save failed");
      }
    });
  }); // end io.on connection

  return io;
} // end setupIntegratedSocket






























// import { Server } from "socket.io";
// import jwt from "jsonwebtoken";
// import mongoose from "mongoose";
// import liveSession from "../model/liveSessions/liveeSession.model.js";
// import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
// import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
// import { ROLE_MAP } from "../constant/role.js";
// import authenticationModel from "../../app/model/Authentication/authentication.model.js"
// import crypto from "crypto";
// // ======= Global Variables =======
// let io;
// const roomState = new Map(); // key: sessionId (string) -> { whiteboardId, createdBy, streamerSocketId, viewers: Set, sockets: Map, pendingOps, flushTimer }

// // ======= ICE Servers Helper =======
// function getIceServersFromEnv() {
//   const stun = (process.env.STUN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//   const turn = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//   const servers = [];
//   if (stun.length) servers.push({ urls: stun });
//   if (turn.length && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
//     servers.push({ urls: turn, username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD });
//   }
//   return servers;
// }

// // ======= Throttled Whiteboard DB flush =======
// async function flushCanvasOps(sessionId) {
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;
//   const ops = state.pendingOps || [];
//   if (!ops.length) return;
//   state.pendingOps = [];
//   clearTimeout(state.flushTimer);
//   state.flushTimer = null;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;
//   for (const op of ops) {
//     if (op.type === "draw") wb.totalDrawActions = (wb.totalDrawActions || 0) + 1;
//     if (op.type === "erase") wb.totalErases = (wb.totalErases || 0) + 1;
//     wb.undoStack = [...(wb.undoStack || []), op].slice(-500);
//     if (op.type === "draw" || op.type === "erase") wb.redoStack = [];
//     if (op.patch) wb.canvasData = { ...(wb.canvasData || {}), ...op.patch };
//   }
//   wb.lastActivity = new Date();
//   await wb.save();
// }

// function scheduleFlush(sessionId, op) {
//   const state = roomState.get(sessionId);
//   if (!state) return;
//   if (!state.pendingOps) state.pendingOps = [];
//   state.pendingOps.push(op);
//   if (state.flushTimer) return;
//   state.flushTimer = setTimeout(() => flushCanvasOps(sessionId).catch(() => {}), 2000);
// }

// // ======= Initialize Whiteboard Room (used by controller when creating session) =======
// export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
//   if (!roomState.has(sessionId)) {
//     roomState.set(sessionId, {
//       whiteboardId,
//       createdBy,
//       streamerSocketId: null,
//       viewers: new Set(),
//       sockets: new Map(),
//       pendingOps: [],
//       flushTimer: null,
//     });
//   } else {
//     const s = roomState.get(sessionId);
//     s.whiteboardId = s.whiteboardId || whiteboardId;
//     s.createdBy = s.createdBy || createdBy;
//   }
//   return roomState.get(sessionId);
// };

// // ======= Setup Socket.io =======
// export default function setupIntegratedSocket(server) {
//   io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

//   const safeEmit = (toSocketId, event, payload) => {
//     const s = io.sockets.sockets.get(toSocketId);
//     if (s) s.emit(event, payload);
//   };

//   io.on("connection", (socket) => {
//     console.log("New client connected:", socket.id);

//     socket.on("join_room", async ({ token, sessionId, roomCode }) => {
//       try {
//         if (!token || (!sessionId && !roomCode)) return socket.emit("error_message", "Missing token or sessionId/roomCode");

//         let decoded;
//         try {
//           decoded = jwt.verify(token, process.env.SECRET_KEY);
//         } catch (err) {
//           return socket.emit("error_message", "Invalid token");
//         }
//         const userId = decoded.userId;
//         const userRole = decoded.role;

//         let session;
//         if (sessionId) {
//           session = await liveSession.findOne({ sessionId });
//         } else {
//           session = await liveSession.findOne({ roomCode });
//         }

//         if (!session) return socket.emit("error_message", "Session not found");
//         if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
//           return socket.emit("error_message", `Session is ${session.status}`);
//         }

//         if (session.isPrivate) {
//           const allowed = Array.isArray(session.allowedUsers) && session.allowedUsers.some(u => u.toString() === userId);
//           if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
//         }

//         // ✅ Use sessionId as key
//         const sid = session.sessionId;
//         if (!roomState.has(sid)) {
//           roomState.set(sid, {
//             whiteboardId: session.whiteboardId || null,
//             createdBy: session.streamerId ? session.streamerId.toString() : null,
//             streamerSocketId: null,
//             viewers: new Set(),
//             sockets: new Map(),
//             pendingOps: [],
//             flushTimer: null,
//           });
//         }
//         const state = roomState.get(sid);

//         // Max participants
//         const activeCount = await liveSessionParticipant.countDocuments({ sessionId: session._id, status: { $ne: "LEFT" } });
//         if ((session.maxParticipants || 100) <= activeCount && userRole !== ROLE_MAP.STREAMER) {
//           return socket.emit("error_message", "Max participants limit reached");
//         }

//         // Check if banned
//         let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
//         if (participant && participant.isBanned) return socket.emit("error_message", "You are banned from this session");

//         if (!participant) {
//           participant = await liveSessionParticipant.create({
//             sessionId: session._id,
//             userId,
//             socketId: socket.id,
//             status: "JOINED",
//             isActiveDevice: true,
//             joinedAt: new Date()
//           });
//           session.totalJoins = (session.totalJoins || 0) + 1;
//           await session.save();
//         } else {
//           participant.socketId = socket.id;
//           participant.status = "JOINED";
//           participant.isActiveDevice = true;
//           participant.joinedAt = new Date();
//           participant.leftAt = null;
//           await participant.save();
//         }

//         // Join room
//         state.sockets.set(socket.id, { userId, role: userRole });
//         socket.data = { sessionId: sid, userId, role: userRole };
//         socket.join(sid);

//         if (userRole === ROLE_MAP.STREAMER) {
//           if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
//             return socket.emit("error_message", "Streamer already connected");
//           }
//           state.streamerSocketId = socket.id;
//           socket.emit("joined_room", { as: "STREAMER", sessionId: sid, roomCode: session.roomCode });
//         } else {
//           state.viewers.add(socket.id);
//           socket.emit("joined_room", { as: "VIEWER", sessionId: sid, roomCode: session.roomCode, whiteboardId: state.whiteboardId });
//           if (state.streamerSocketId) {
//             safeEmit(state.streamerSocketId, "viewer_ready", { viewerSocketId: socket.id, viewerUserId: userId });
//           }
//         }

//         if (state.whiteboardId) {
//           const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//           if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
//             wb.participants.push({ user: userId, role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", joinedAt: new Date() });
//             await wb.save();
//           }
//         }

//         const currentParticipants = state.viewers.size + (state.streamerSocketId ? 1 : 0);
//         if ((session.peakParticipants || 0) < currentParticipants) {
//           session.peakParticipants = currentParticipants;
//           await session.save();
//         }

//       } catch (err) {
//         console.error("join_room error:", err);
//         socket.emit("error_message", "Invalid token/session");
//       }
//     });
//     // =========================
    
//     // ===== CHAT MESSAGE =====
//     // =========================
//     // Emits to room and (optionally) persist via ChatMessage controller if you have one
//     socket.on("chat_message", async ({ sessionId, message }) => {
//       try {
//         const state = roomState.get(sessionId);
//         if (!state) return;
//         const meta = state.sockets.get(socket.id);
//         if (!meta) return;

//         // ✅ Fetch sender name from User model
//         const sender = await authenticationModel.findById(meta.userId).select("name");

//         // broadcast
//         io.to(sessionId).emit("chat_message", {
//           userId: meta.userId,
//           name: sender?.name || "Unknown",   // 👈 name include kiya
//           message,
//           socketId: socket.id,
//           at: new Date()
//         });

//       } catch (e) {
//         console.error("chat_message error:", e.message);
//       }
//     });



//     // =========================
//     // ===== STREAMER CONTROLS =====
//     // =========================
//   socket.on("streamer_start", async ({ sessionId }) => {
//     try {
//       const session = await liveSession.findOne({ sessionId }); // <- fixed
//       if (!session) return;
//       session.status = "ACTIVE";
//       session.actualStartTime = new Date();
//       await session.save();
//       io.to(sessionId).emit("streamer_started", { sessionId });
//     } catch (e) { console.error(e.message); }
//   });


//     socket.on("streamer_pause", async ({ sessionId }) => {
//       try {
//         const session = await liveSession.findOne({ sessionId }); // <- fixed
//         if (!session) return;
//         session.status = "PAUSED";
//         await session.save();
//         io.to(sessionId).emit("streamer_paused", { sessionId });
//       } catch (e) { console.error(e.message); }
//     });


//     socket.on("streamer_resume", async ({ sessionId }) => {
//       try {
//         const session = await liveSession.findOne({ sessionId }); // <- fixed
//         if (!session) return;
//         session.status = "ACTIVE";
//         await session.save();
//         io.to(sessionId).emit("streamer_resumed", { sessionId });
//       } catch (e) { console.error(e.message); }
//     });


//     // =========================
//     // ===== WEBRTC SIGNALING =====
//     // =========================
//     // Streamer sends offer to a target viewer socket id
//     socket.on("offer", ({ sessionId, targetSocketId, sdp }) => {
//       const state = roomState.get(sessionId);
//       if (!state || state.streamerSocketId !== socket.id) return;
//       safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
//     });

//     // Viewer sends audio offer to streamer
//     socket.on("viewer_offer", ({ sessionId, sdp }) => {
//       const state = roomState.get(sessionId);
//       if (!state || !state.streamerSocketId) return;
//       safeEmit(state.streamerSocketId, "viewer_offer", { from: socket.id, sdp });
//     });

//     // Streamer sends answer back to viewer
//     socket.on("viewer_answer", ({ sessionId, targetSocketId, sdp }) => {
//       safeEmit(targetSocketId, "viewer_answer", { from: socket.id, sdp });
//     });

//     // Streamer sends answer back to viewer
//     socket.on("viewer_answer", ({ sessionId, targetSocketId, sdp }) => {
//       safeEmit(targetSocketId, "viewer_answer", { from: socket.id, sdp });
//     });


//     // ICE candidate exchange (both directions)
//     socket.on("ice-candidate", ({ sessionId, targetSocketId, candidate }) => {
//       const state = roomState.get(sessionId);
//       if (!state) return;
//       safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
//     });

//     socket.on("get_ice_servers", () => {
//       socket.emit("ice_servers", getIceServersFromEnv());
//     });

//     // =========================
//     // ===== WHITEBOARD EVENTS =====
//     // =========================
//     socket.on("whiteboard_draw", ({ sessionId, drawData, patch }) => {
//       const state = roomState.get(sessionId);
//       if (!state || !state.whiteboardId) return;
//       const meta = state.sockets.get(socket.id);
//       if (!meta) return;
//       socket.to(sessionId).emit("whiteboard_draw", { userId: meta.userId, drawData });
//       scheduleFlush(sessionId, { type: "draw", payload: drawData, patch, at: new Date() });
//     });

//     socket.on("whiteboard_erase", ({ sessionId, eraseData, patch }) => {
//       const state = roomState.get(sessionId);
//       if (!state || !state.whiteboardId) return;
//       const meta = state.sockets.get(socket.id);
//       if (!meta) return;
//       socket.to(sessionId).emit("whiteboard_erase", { userId: meta.userId, eraseData });
//       scheduleFlush(sessionId, { type: "erase", payload: eraseData, patch, at: new Date() });
//     });

//     socket.on("whiteboard_undo", async ({ sessionId }) => {
//       const state = roomState.get(sessionId);
//       if (!state || !state.whiteboardId) return;
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (!wb) return;
//       const last = (wb.undoStack || []).pop();
//       if (!last) return;
//       wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
//       wb.lastActivity = new Date();
//       await wb.save();
//       io.to(sessionId).emit("whiteboard_undo_applied", { last });
//     });

//     socket.on("whiteboard_redo", async ({ sessionId }) => {
//       const state = roomState.get(sessionId);
//       if (!state || !state.whiteboardId) return;
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (!wb) return;
//       const last = (wb.redoStack || []).pop();
//       if (!last) return;
//       wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
//       wb.lastActivity = new Date();
//       await wb.save();
//       io.to(sessionId).emit("whiteboard_redo_applied", { last });
//     });

//     socket.on("whiteboard_save_canvas", async ({ sessionId }) => {
//       await flushCanvasOps(sessionId).catch(() => {});
//       socket.emit("whiteboard_saved");
//     });

//     socket.on("cursor_update", ({ sessionId, position }) => {
//       const state = roomState.get(sessionId);
//       if (!state) return;
//       const meta = state.sockets.get(socket.id);
//       if (!meta) return;
//       socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
//     });

//     socket.on("whiteboard_state_request", async ({ sessionId }) => {
//       const state = roomState.get(sessionId);
//       if (!state || !state.whiteboardId) return;
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (!wb) return;
//       socket.emit("whiteboard_state_sync", {
//         canvasData: wb.canvasData,
//         participants: wb.participants,
//         versionHistory: wb.versionHistory,
//       });
//     });

//     // =========================
//     // ===== LEAVE / DISCONNECT =====
//     // =========================
//     const cleanupSocketFromRoom = async () => {
//       try {
//         const sid = socket.data?.sessionId;
//         if (!sid) return;
//         const state = roomState.get(sid);
//         if (!state) return;

//         const meta = state.sockets.get(socket.id);
//         if (!meta) return;

//         // Whiteboard soft leave
//         if (state.whiteboardId) {
//           const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//           if (wb) {
//             const participant = wb.participants.find(p => p.user.toString() === meta.userId);
//             if (participant) {
//               participant.status = "LEFT";
//               participant.leftAt = new Date();
//             }
//             await wb.save();
//           }
//         }

//         // Update liveSessionParticipant record by userId and sessionId
//         if (meta.role !== ROLE_MAP.STREAMER) {
//           try {
//             // 🔹 Replace ObjectId casting with string sessionId
//             const participant = await liveSessionParticipant.findOne({ sessionId: sid, userId: meta.userId });
//             // fallback: if above fails, try matching socketId
//             const p = participant || await liveSessionParticipant.findOne({ socketId: socket.id });
//             if (p) {
//               p.status = "LEFT";
//               p.leftAt = new Date();
//               p.isActiveDevice = false;
//               await p.save();
//             }
//           } catch (e) { console.error("cleanup update error:", e.message); }

//           state.viewers.delete(socket.id);
//           io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
//         } else {
//           // streamer left — pause session (or END depending on your business rules)
//           state.streamerSocketId = null;

//           // 🔹 Fixed: use sessionId field instead of _id
//           const session = await liveSession.findOne({ sessionId: sid });
//           if (session) {
//             session.status = "PAUSED"; // or "ENDED"
//             await session.save();
//           }

//           io.to(sid).emit("session_paused_or_ended_by_streamer");
//         }

//         state.sockets.delete(socket.id);
//         socket.leave(sid);
//       } catch (e) {
//         console.error("cleanupSocketFromRoom error:", e.message);
//       }
//     };

//     socket.on("leave_room", cleanupSocketFromRoom);
//     socket.on("disconnect", cleanupSocketFromRoom);

//     // =========================
//     // ===== RECORDING =====
//     // =========================
//     socket.on("save_recording", async ({ sessionId, recordingFiles }) => {
//       try {
//         const session = await liveSession.findOne({ sessionId }); // <- fixed
//         if (!session) return;
//         session.recordingUrl = [...(session.recordingUrl || []), ...recordingFiles];
//         await session.save();
//         socket.emit("recording_saved", { sessionId, recordingFiles });
//       } catch (err) {
//         console.error("save_recording error:", err.message);
//         socket.emit("error_message", "Recording save failed");
//       }
//     });
//   }); // connection

//   return io;
// }

// // ======= Get IO Instance =======
// export const getIO = () => {
//   if (!io) throw new Error("Socket.io not initialized yet");
//   return io;
// };





















// import { Server } from "socket.io";
// import jwt from "jsonwebtoken";
// import mongoose from "mongoose";
// import liveSession from "../model/liveSessions/liveeSession.model.js";
// import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
// import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
// import { ROLE_MAP } from "../constant/role.js";
// import authenticationModel from "../../app/model/Authentication/authentication.model.js"
// import crypto from "crypto";
// // ======= Global Variables =======
// let io;
// const roomState = new Map(); // key: sessionId (string) -> { whiteboardId, createdBy, streamerSocketId, viewers: Set, sockets: Map, pendingOps, flushTimer }
 
// // ======= ICE Servers Helper =======
// function getIceServersFromEnv() {
//   console.log("Getting ICE servers from environment");
//   const stun = (process.env.STUN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//   const turn = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//   const servers = [];
//   if (stun.length) servers.push({ urls: stun });
//   if (turn.length && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
//     servers.push({ urls: turn, username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD });
//   }
//   console.log(`Found ${servers.length} ICE servers`);
//   return servers;
// }
 
// // ======= Throttled Whiteboard DB flush =======
// async function flushCanvasOps(sessionId) {
//   console.log(`Flushing canvas operations for session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) {
//     console.log(`No state or whiteboardId found for session: ${sessionId}`);
//     return;
//   }
//   const ops = state.pendingOps || [];
//   if (!ops.length) {
//     console.log(`No pending operations for session: ${sessionId}`);
//     return;
//   }
//   console.log(`Flushing ${ops.length} operations for session: ${sessionId}`);
//   state.pendingOps = [];
//   clearTimeout(state.flushTimer);
//   state.flushTimer = null;
 
//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) {
//     console.log(`Whiteboard not found with ID: ${state.whiteboardId}`);
//     return;
//   }
//   for (const op of ops) {
//     if (op.type === "draw") wb.totalDrawActions = (wb.totalDrawActions || 0) + 1;
//     if (op.type === "erase") wb.totalErases = (wb.totalErases || 0) + 1;
//     wb.undoStack = [...(wb.undoStack || []), op].slice(-500);
//     if (op.type === "draw" || op.type === "erase") wb.redoStack = [];
//     if (op.patch) wb.canvasData = { ...(wb.canvasData || {}), ...op.patch };
//   }
//   wb.lastActivity = new Date();
//   await wb.save();
//   console.log(`Canvas operations flushed for session: ${sessionId}`);
// }
 
// function scheduleFlush(sessionId, op) {
//   console.log(`Scheduling flush for session: ${sessionId}, operation type: ${op.type}`);
//   const state = roomState.get(sessionId);
//   if (!state) {
//     console.log(`No state found for session: ${sessionId}`);
//     return;
//   }
//   if (!state.pendingOps) state.pendingOps = [];
//   state.pendingOps.push(op);
//   if (state.flushTimer) {
//     console.log(`Flush already scheduled for session: ${sessionId}`);
//     return;
//   }
//   state.flushTimer = setTimeout(() => flushCanvasOps(sessionId).catch((err) => {
//     console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
//   }), 2000);
//   console.log(`Flush scheduled for session: ${sessionId}`);
// }
 
// // ======= Initialize Whiteboard Room (used by controller when creating session) =======
// export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
//   console.log(`Initializing whiteboard RTC for session: ${sessionId}, whiteboard: ${whiteboardId}, createdBy: ${createdBy}`);
//   if (!roomState.has(sessionId)) {
//     roomState.set(sessionId, {
//       whiteboardId,
//       createdBy,
//       streamerSocketId: null,
//       viewers: new Set(),
//       sockets: new Map(),
//       pendingOps: [],
//       flushTimer: null,
//     });
//     console.log(`New room state created for session: ${sessionId}`);
//   } else {
//     const s = roomState.get(sessionId);
//     s.whiteboardId = s.whiteboardId || whiteboardId;
//     s.createdBy = s.createdBy || createdBy;
//     console.log(`Existing room state updated for session: ${sessionId}`);
//   }
//   return roomState.get(sessionId);
// };
 
// // ======= Setup Socket.io =======
// export default function setupIntegratedSocket(server) {
//   console.log("Setting up integrated socket");
//   io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
 
//   const safeEmit = (toSocketId, event, payload) => {
//     console.log(`Safe emitting ${event} to socket: ${toSocketId}`);
//     const s = io.sockets.sockets.get(toSocketId);
//     if (s) {
//       s.emit(event, payload);
//       console.log(`Emitted ${event} to socket: ${toSocketId}`);
//     } else {
//       console.log(`Socket not found: ${toSocketId}`);
//     }
//   };
 
//   io.on("connection", (socket) => {
//     console.log("New client connected:", socket.id);
 
//     socket.on("join_room", async ({ token, sessionId, roomCode }) => {
//       console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);
//       try {
//         if (!token || (!sessionId && !roomCode)) {
//           console.log("Missing token or sessionId/roomCode");
//           return socket.emit("error_message", "Missing token or sessionId/roomCode");
//         }
 
//         let decoded;
//         try {
//           decoded = jwt.verify(token, process.env.SECRET_KEY);
//           console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
//         } catch (err) {
//           console.log("Invalid token:", err.message);
//           return socket.emit("error_message", "Invalid token");
//         }
//         const userId = decoded.userId;
//         const userRole = decoded.role;
 
//         let session;
//         if (sessionId) {
//           console.log(`Looking for session by sessionId: ${sessionId}`);
//           session = await liveSession.findOne({ sessionId });
//         } else {
//           console.log(`Looking for session by roomCode: ${roomCode}`);
//           session = await liveSession.findOne({ roomCode });
//         }
 
//         if (!session) {
//           console.log("Session not found");
//           return socket.emit("error_message", "Session not found");
//         }
       
//         console.log(`Session found: ${session.sessionId}, status: ${session.status}`);
//         if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
//           console.log(`Session is ${session.status}, cannot join`);
//           return socket.emit("error_message", `Session is ${session.status}`);
//         }
 
//         if (session.isPrivate) {
//           console.log("Checking private session permissions");
//           const allowed = Array.isArray(session.allowedUsers) && session.allowedUsers.some(u => u.toString() === userId);
//           if (!allowed) {
//             console.log("User not allowed to join private session");
//             return socket.emit("error_message", "You are not allowed to join this private session");
//           }
//         }
 
//         // ✅ Use sessionId as key
//         const sid = session.sessionId;
//         console.log(`Using session ID as key: ${sid}`);
//         if (!roomState.has(sid)) {
//           roomState.set(sid, {
//             whiteboardId: session.whiteboardId || null,
//             createdBy: session.streamerId ? session.streamerId.toString() : null,
//             streamerSocketId: null,
//             viewers: new Set(),
//             sockets: new Map(),
//             pendingOps: [],
//             flushTimer: null,
//           });
//           console.log(`New room state created for session: ${sid}`);
//         }
//         const state = roomState.get(sid);
 
//         // Max participants
//         const activeCount = await liveSessionParticipant.countDocuments({ sessionId: session._id, status: { $ne: "LEFT" } });
//         console.log(`Active participants: ${activeCount}, max allowed: ${session.maxParticipants || 100}`);
//         if ((session.maxParticipants || 100) <= activeCount && userRole !== ROLE_MAP.STREAMER) {
//           console.log("Max participants limit reached");
//           return socket.emit("error_message", "Max participants limit reached");
//         }
 
//         // Check if banned
//         let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
//         if (participant && participant.isBanned) {
//           console.log("User is banned from this session");
//           return socket.emit("error_message", "You are banned from this session");
//         }
 
//         if (!participant) {
//           console.log("Creating new participant record");
//           participant = await liveSessionParticipant.create({
//             sessionId: session._id,
//             userId,
//             socketId: socket.id,
//             status: "JOINED",
//             isActiveDevice: true,
//             joinedAt: new Date()
//           });
//           session.totalJoins = (session.totalJoins || 0) + 1;
//           await session.save();
//           console.log(`New participant created, total joins: ${session.totalJoins}`);
//         } else {
//           console.log("Updating existing participant record");
//           participant.socketId = socket.id;
//           participant.status = "JOINED";
//           participant.isActiveDevice = true;
//           participant.joinedAt = new Date();
//           participant.leftAt = null;
//           await participant.save();
//         }
 
//         // Join room
//         state.sockets.set(socket.id, { userId, role: userRole });
//         socket.data = { sessionId: sid, userId, role: userRole };
//         socket.join(sid);
//         console.log(`Socket ${socket.id} joined room ${sid}`);
 
//         if (userRole === ROLE_MAP.STREAMER) {
//           console.log("User is a streamer");
//           if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
//             console.log("Streamer already connected");
//             return socket.emit("error_message", "Streamer already connected");
//           }
//           state.streamerSocketId = socket.id;
//           socket.emit("joined_room", { as: "STREAMER", sessionId: sid, roomCode: session.roomCode });
//           console.log(`Streamer ${socket.id} joined room ${sid}`);
//         } else {
//           state.viewers.add(socket.id);
//           socket.emit("joined_room", { as: "VIEWER", sessionId: sid, roomCode: session.roomCode, whiteboardId: state.whiteboardId });
//           console.log(`Viewer ${socket.id} joined room ${sid}`);
//           if (state.streamerSocketId) {
//             safeEmit(state.streamerSocketId, "viewer_ready", { viewerSocketId: socket.id, viewerUserId: userId });
//           }
//         }
 
//         if (state.whiteboardId) {
//           console.log(`Adding user to whiteboard: ${state.whiteboardId}`);
//           const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//           if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
//             wb.participants.push({ user: userId, role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", joinedAt: new Date() });
//             await wb.save();
//             console.log(`User added to whiteboard: ${state.whiteboardId}`);
//           }
//         }
 
//         const currentParticipants = state.viewers.size + (state.streamerSocketId ? 1 : 0);
//         console.log(`Current participants: ${currentParticipants}, peak: ${session.peakParticipants || 0}`);
//         if ((session.peakParticipants || 0) < currentParticipants) {
//           session.peakParticipants = currentParticipants;
//           await session.save();
//           console.log(`New peak participants: ${currentParticipants}`);
//         }
 
//       } catch (err) {
//         console.error("join_room error:", err);
//         socket.emit("error_message", "Invalid token/session");
//       }
//     });
   
//     // =========================
//     // ===== CHAT MESSAGE =====
//     // =========================
//     socket.on("chat_message", async ({ sessionId, message }) => {
//       console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}, message: ${message}`);
//       try {
//         const state = roomState.get(sessionId);
//         if (!state) {
//           console.log(`No state found for session: ${sessionId}`);
//           return;
//         }
//         const meta = state.sockets.get(socket.id);
//         if (!meta) {
//           console.log(`No metadata found for socket: ${socket.id}`);
//           return;
//         }
 
//         // ✅ Fetch sender name from User model
//         const sender = await authenticationModel.findById(meta.userId).select("name");
//         console.log(`Sender: ${sender?.name || "Unknown"}, userId: ${meta.userId}`);
 
//         // broadcast
//         io.to(sessionId).emit("chat_message", {
//           userId: meta.userId,
//           name: sender?.name || "Unknown",   // 👈 name include kiya
//           message,
//           socketId: socket.id,
//           at: new Date()
//         });
//         console.log(`Chat message broadcast to session: ${sessionId}`);
 
//       } catch (e) {
//         console.error("chat_message error:", e.message);
//       }
//     });
 
//     // =========================
//     // ===== STREAMER CONTROLS =====
//     // =========================
//     socket.on("streamer_start", async ({ sessionId }) => {
//       console.log(`Streamer start request for session: ${sessionId}`);
//       try {
//         const session = await liveSession.findOne({ sessionId }); // <- fixed
//         if (!session) {
//           console.log(`Session not found: ${sessionId}`);
//           return;
//         }
//         session.status = "ACTIVE";
//         session.actualStartTime = new Date();
//         await session.save();
//         io.to(sessionId).emit("streamer_started", { sessionId });
//         console.log(`Session ${sessionId} started by streamer`);
//       } catch (e) {
//         console.error("streamer_start error:", e.message);
//       }
//     });
//      socket.on("streamer_pause", async ({ sessionId }) => {
//       console.log(`Streamer pause request for session: ${sessionId}`);
//       try {
//         const session = await liveSession.findOne({ sessionId }); // <- fixed
//         if (!session) {
//           console.log(`Session not found: ${sessionId}`);
//           return;
//         }
//         session.status = "PAUSED";
//         await session.save();
//         io.to(sessionId).emit("streamer_paused", { sessionId });
//         console.log(`Session ${sessionId} paused by streamer`);
//       } catch (e) {
//         console.error("streamer_pause error:", e.message);
//       }
//     });
 
//     socket.on("streamer_resume", async ({ sessionId }) => {
//       console.log(`Streamer resume request for session: ${sessionId}`);
//       try {
//         const session = await liveSession.findOne({ sessionId }); // <- fixed
//         if (!session) {
//           console.log(`Session not found: ${sessionId}`);
//           return;
//         }
//         session.status = "ACTIVE";
//         await session.save();
//         io.to(sessionId).emit("streamer_resumed", { sessionId });
//         console.log(`Session ${sessionId} resumed by streamer`);
//       } catch (e) {
//         console.error("streamer_resume error:", e.message);
//       }
//     });
 
//     // =========================
//     // ===== WEBRTC SIGNALING =====
//     // =========================
//     // Streamer sends offer to a target viewer socket id
//     socket.on("offer", ({ sessionId, targetSocketId, sdp }) => {
//       console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//       const state = roomState.get(sessionId);
//       if (!state || state.streamerSocketId !== socket.id) {
//         console.log(`Invalid offer: no state or not streamer`);
//         return;
//       }
//       safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
//     });
 
//     // Viewer sends answer back to streamer
//     socket.on("answer", ({ sessionId, sdp }) => {
//       console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
//       const state = roomState.get(sessionId);
//       if (!state) {
//         console.log(`No state found for session: ${sessionId}`);
//         return;
//       }
//       const meta = state.sockets.get(socket.id);
//       if (!meta || meta.role === ROLE_MAP.STREAMER) {
//         console.log(`Invalid answer: no metadata or is streamer`);
//         return;
//       }
//       safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
//     });
 
//     // ICE candidate exchange (both directions)
//     socket.on("ice-candidate", ({ sessionId, targetSocketId, candidate }) => {
//       console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//       const state = roomState.get(sessionId);
//       if (!state) {
//         console.log(`No state found for session: ${sessionId}`);
//         return;
//       }
//       safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
//     });
 
//     socket.on("get_ice_servers", () => {
//       console.log(`ICE servers request from socket: ${socket.id}`);
//       socket.emit("ice_servers", getIceServersFromEnv());
//     });
 
//     // =========================
//     // ===== WHITEBOARD EVENTS =====
//     // =========================
//     socket.on("whiteboard_draw", ({ sessionId, drawData, patch }) => {
//       console.log(`Whiteboard draw from socket: ${socket.id}, session: ${sessionId}`);
//       const state = roomState.get(sessionId);
//       if (!state || !state.whiteboardId) {
//         console.log(`No state or whiteboardId found for session: ${sessionId}`);
//         return;
//       }
//       const meta = state.sockets.get(socket.id);
//       if (!meta) {
//         console.log(`No metadata found for socket: ${socket.id}`);
//         return;
//       }
//       socket.to(sessionId).emit("whiteboard_draw", { userId: meta.userId, drawData });
//       scheduleFlush(sessionId, { type: "draw", payload: drawData, patch, at: new Date() });
//     });
 
//     socket.on("whiteboard_erase", ({ sessionId, eraseData, patch }) => {
//       console.log(`Whiteboard erase from socket: ${socket.id}, session: ${sessionId}`);
//       const state = roomState.get(sessionId);
//       if (!state || !state.whiteboardId) {
//         console.log(`No state or whiteboardId found for session: ${sessionId}`);
//         return;
//       }
//       const meta = state.sockets.get(socket.id);
//       if (!meta) {
//         console.log(`No metadata found for socket: ${socket.id}`);
//         return;
//       }
//       socket.to(sessionId).emit("whiteboard_erase", { userId: meta.userId, eraseData });
//       scheduleFlush(sessionId, { type: "erase", payload: eraseData, patch, at: new Date() });
//     });
 
//     socket.on("whiteboard_undo", async ({ sessionId }) => {
//       console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
//       const state = roomState.get(sessionId);
//       if (!state || !state.whiteboardId) {
//         console.log(`No state or whiteboardId found for session: ${sessionId}`);
//         return;
//       }
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (!wb) {
//         console.log(`Whiteboard not found with ID: ${state.whiteboardId}`);
//         return;
//       }
//       const last = (wb.undoStack || []).pop();
//       if (!last) {
//         console.log(`No operations to undo for whiteboard: ${state.whiteboardId}`);
//         return;
//       }
//       wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
//       wb.lastActivity = new Date();
//       await wb.save();
//       io.to(sessionId).emit("whiteboard_undo_applied", { last });
//       console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
//     });
 
//     socket.on("whiteboard_redo", async ({ sessionId }) => {
//       console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
//       const state = roomState.get(sessionId);
//       if (!state || !state.whiteboardId) {
//         console.log(`No state or whiteboardId found for session: ${sessionId}`);
//         return;
//       }
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (!wb) {
//         console.log(`Whiteboard not found with ID: ${state.whiteboardId}`);
//         return;
//       }
//       const last = (wb.redoStack || []).pop();
//       if (!last) {
//         console.log(`No operations to redo for whiteboard: ${state.whiteboardId}`);
//         return;
//       }
//       wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
//       wb.lastActivity = new Date();
//       await wb.save();
//       io.to(sessionId).emit("whiteboard_redo_applied", { last });
//       console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
//     });
 
//     socket.on("whiteboard_save_canvas", async ({ sessionId }) => {
//       console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
//       await flushCanvasOps(sessionId).catch((err) => {
//         console.error(`Error saving canvas for session ${sessionId}:`, err);
//       });
//       socket.emit("whiteboard_saved");
//       console.log(`Whiteboard saved for session: ${sessionId}`);
//     });
 
//     socket.on("cursor_update", ({ sessionId, position }) => {
//       console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
//       const state = roomState.get(sessionId);
//       if (!state) {
//         console.log(`No state found for session: ${sessionId}`);
//         return;
//       }
//       const meta = state.sockets.get(socket.id);
//       if (!meta) {
//         console.log(`No metadata found for socket: ${socket.id}`);
//         return;
//       }
//       socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
//     });
 
//     socket.on("whiteboard_state_request", async ({ sessionId }) => {
//       console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
//       const state = roomState.get(sessionId);
//       if (!state || !state.whiteboardId) {
//         console.log(`No state or whiteboardId found for session: ${sessionId}`);
//         return;
//       }
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (!wb) {
//         console.log(`Whiteboard not found with ID: ${state.whiteboardId}`);
//         return;
//       }
//       socket.emit("whiteboard_state_sync", {
//         canvasData: wb.canvasData,
//         participants: wb.participants,
//         versionHistory: wb.versionHistory,
//       });
//       console.log(`Whiteboard state sent to socket: ${socket.id}`);
//     });
 
//     // =========================
//     // ===== LEAVE / DISCONNECT =====
//     // =========================
//     const cleanupSocketFromRoom = async () => {
//       console.log(`Cleanup requested for socket: ${socket.id}`);
//       try {
//         const sid = socket.data?.sessionId;
//         if (!sid) {
//           console.log(`No session ID found for socket: ${socket.id}`);
//           return;
//         }
//         const state = roomState.get(sid);
//         if (!state) {
//           console.log(`No state found for session: ${sid}`);
//           return;
//         }
 
//         const meta = state.sockets.get(socket.id);
//         if (!meta) {
//           console.log(`No metadata found for socket: ${socket.id}`);
//           return;
//         }
 
//         // Whiteboard soft leave
//         if (state.whiteboardId) {
//           console.log(`Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`);
//           const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//           if (wb) {
//             const participant = wb.participants.find(p => p.user.toString() === meta.userId);
//             if (participant) {
//               participant.status = "LEFT";
//               participant.leftAt = new Date();
//             }
//             await wb.save();
//             console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
//           }
//         }
 
//         // Update liveSessionParticipant record by userId and sessionId
//         if (meta.role !== ROLE_MAP.STREAMER) {
//           try {
//             // 🔹 Replace ObjectId casting with string sessionId
//             const participant = await liveSessionParticipant.findOne({ sessionId: sid, userId: meta.userId });
//             // fallback: if above fails, try matching socketId
//             const p = participant || await liveSessionParticipant.findOne({ socketId: socket.id });
//             if (p) {
//               p.status = "LEFT";
//               p.leftAt = new Date();
//               p.isActiveDevice = false;
//               await p.save();
//               console.log(`Participant ${meta.userId} marked as LEFT`);
//             }
//           } catch (e) {
//             console.error("cleanup update error:", e.message);
//           }
 
//           state.viewers.delete(socket.id);
//           io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
//           console.log(`Viewer ${socket.id} left room ${sid}`);
//         } else {
//           // streamer left — pause session (or END depending on your business rules)
//           state.streamerSocketId = null;
//           console.log(`Streamer ${socket.id} left room ${sid}`);
 
//           // 🔹 Fixed: use sessionId field instead of _id
//           const session = await liveSession.findOne({ sessionId: sid });
//           if (session) {
//             session.status = "PAUSED"; // or "ENDED"
//             await session.save();
//             console.log(`Session ${sid} paused due to streamer leaving`);
//           }
 
//           io.to(sid).emit("session_paused_or_ended_by_streamer");
//         }
 
//         state.sockets.delete(socket.id);
//         socket.leave(sid);
//         console.log(`Socket ${socket.id} removed from room state for session: ${sid}`);
//       } catch (e) {
//         console.error("cleanupSocketFromRoom error:", e.message);
//       }
//     };
 
//     socket.on("leave_room", () => {
//       console.log(`Explicit leave_room request from socket: ${socket.id}`);
//       cleanupSocketFromRoom();
//     });
   
//     socket.on("disconnect", (reason) => {
//       console.log(`Socket disconnected: ${socket.id}, reason: ${reason}`);
//       cleanupSocketFromRoom();
//     });
 
//     // =========================
//     // ===== RECORDING =====
//     // =========================
//     socket.on("save_recording", async ({ sessionId, recordingFiles }) => {
//       console.log(`Save recording request for session: ${sessionId}, files: ${recordingFiles.length}`);
//       try {
//         const session = await liveSession.findOne({ sessionId }); // <- fixed
//         if (!session) {
//           console.log(`Session not found: ${sessionId}`);
//           return;
//         }
//         session.recordingUrl = [...(session.recordingUrl || []), ...recordingFiles];
//         await session.save();
//         socket.emit("recording_saved", { sessionId, recordingFiles });
//         console.log(`Recording saved for session: ${sessionId}`);
//       } catch (err) {
//         console.error("save_recording error:", err.message);
//         socket.emit("error_message", "Recording save failed");
//       }
//     });
//   }); // connection
 
//   console.log("Socket.io setup completed");
//   return io;
// }
 
// // ======= Get IO Instance =======
// export const getIO = () => {
//   if (!io) {
//     console.error("Socket.io not initialized yet");
//     throw new Error("Socket.io not initialized yet");
//   }
//   return io;
// };
 