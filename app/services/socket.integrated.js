import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mediasoup from "mediasoup";
import liveSession from "../model/liveSessions/liveeSession.model.js";
import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
import { ROLE_MAP } from "../constant/role.js";
import authenticationModel from "../../app/model/Authentication/authentication.model.js";

// ======= Global Variables =======
let io;
let mediasoupWorker;
const roomState = new Map();

// ======= Utility Functions =======
const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
  return io;
};

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

const getIceServersFromEnv = () => {
  const isProduction = process.env.NODE_ENV === "production";

  const servers = [];
  const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  stunUrls.forEach(url => { if (url) servers.push({ urls: url }); });

  if (isProduction) {
    const turnUrls = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
    const turnUsername = process.env.TURN_USERNAME;
    const turnPassword = process.env.TURN_PASSWORD;

    turnUrls.forEach(url => {
      if (url && turnUsername && turnPassword) {
        servers.push({
          urls: url,
          username: turnUsername,
          credential: turnPassword
        });
      }
    });
  }
  if (servers.length === 0) {
    servers.push({ urls: "stun:stun.l.google.com:19302" });
    servers.push({ urls: "stun:global.stun.twilio.com:3478" });
  }

  return servers;
};

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
      setTimeout(() => createMediasoupWorker().catch(console.error), 2000);
    });

    return mediasoupWorker;
  } catch (error) {
    console.error("Failed to create Mediasoup worker:", error);
    throw error;
  }
};

const flushCanvasOps = async (sessionId) => {
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
    if (op.type === "draw" || op.type === "erase") wb.redoStack = [];
    if (op.patch) wb.canvasData = { ...(wb.canvasData || {}), ...op.patch };
  }

  wb.lastActivity = new Date();
  await wb.save();
  console.log(`Canvas operations flushed for session: ${sessionId}`);
};

const scheduleFlush = (sessionId, op) => {
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
    flushCanvasOps(sessionId).catch(err => {
      console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
    });
  }, 2000);
  
  console.log(`Flush scheduled for session: ${sessionId}`);
};

export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
  console.log(`Initializing whiteboard RTC for session: ${sessionId}, whiteboard: ${whiteboardId}, createdBy: ${createdBy}`);
  
  if (!roomState.has(sessionId)) {
    roomState.set(sessionId, {
      whiteboardId,
      createdBy,
      streamerSocketId: null,
      viewers: new Set(),
      sockets: new Map(),
      participants: new Map(),
      pendingScreenShareRequests: new Map(),
      activeScreenShares: new Map(),
      pendingOps: [],
      flushTimer: null,
      router: null,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
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

// ======= Producer Control Functions =======
const pauseAllProducers = async (sessionId, socketId) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  console.log(`Pausing all producers for socket: ${socketId} in session: ${sessionId}`);
  
  for (const [producerId, producer] of state.producers) {
    if (producer.appData?.socketId === socketId) {
      try {
        await producer.pause();
        console.log(`Producer ${producerId} paused`);
        safeEmit(socketId, "producer-paused", { producerId });
      } catch (error) {
        console.error("Error pausing producer:", error);
      }
    }
  }
};

const resumeAllProducers = async (sessionId, socketId) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  console.log(`Resuming all producers for socket: ${socketId} in session: ${sessionId}`);
  
  for (const [producerId, producer] of state.producers) {
    if (producer.appData?.socketId === socketId) {
      try {
        await producer.resume();
        console.log(`Producer ${producerId} resumed`);
        safeEmit(socketId, "producer-resumed", { producerId });
      } catch (error) {
        console.error("Error resuming producer:", error);
      }
    }
  }
};

const producerPauseHandler = async (socket, sessionId, producerId) => {
  try {
    console.log("producer-pause for producer:", producerId);
    const state = roomState.get(sessionId);
    if (!state) return;

    const producer = state.producers.get(producerId);
    if (producer && producer.appData?.socketId === socket.id) {
      await producer.pause();
      socket.emit("producer-paused", { producerId });
      console.log(`Producer ${producerId} paused`);
    }
  } catch (error) {
    console.error("producer-pause error:", error);
  }
};

const producerResumeHandler = async (socket, sessionId, producerId) => {
  try {
    console.log("producer-resume for producer:", producerId);
    const state = roomState.get(sessionId);
    if (!state) return;

    const producer = state.producers.get(producerId);
    if (producer && producer.appData?.socketId === socket.id) {
      await producer.resume();
      socket.emit("producer-resumed", { producerId });
      console.log(`Producer ${producerId} resumed`);
    }
  } catch (error) {
    console.error("producer-resume error:", error);
  }
};

const producerCloseHandler = async (socket, sessionId, producerId) => {
  try {
    console.log("producer-close for producer:", producerId);
    const state = roomState.get(sessionId);
    if (!state) return;

    const producer = state.producers.get(producerId);
    if (producer) {
      producer.close();
      state.producers.delete(producerId);
      console.log(`Producer ${producerId} closed and removed`);
      socket.emit("producer-closed", { producerId });
    }
  } catch (error) {
    console.error("producer-close error:", error);
  }
};

// ======= Screen Share Functions =======
const handleScreenShareRequest = async (socket, sessionId) => {
  try {
    console.log("Screen share request from:", socket.id);
    const state = roomState.get(sessionId);
    if (!state || !state.streamerSocketId) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    if (state.activeScreenShares.has(meta.userId)) {
      socket.emit("screen-share-error", { message: "You already have an active screen share" });
      return;
    }

    const user = await authenticationModel.findById(meta.userId).select("name");
    
    state.pendingScreenShareRequests.set(meta.userId, {
      userId: meta.userId,
      socketId: socket.id,
      userName: user?.name || "Viewer",
      requestedAt: new Date()
    });

    safeEmit(state.streamerSocketId, "screen-share-request", {
      requestedUserId: meta.userId,
      requesterSocketId: socket.id,
      requesterName: user?.name || "Viewer"
    });
    console.log("📩 Screen-share request received from:", meta.userId, "session:", sessionId);


    socket.emit("screen-share-request-sent");
  } catch (error) {
    console.error("Screen share request error:", error);
    socket.emit("screen-share-error", { message: "Failed to send screen share request" });
  }
};

const handleScreenShareResponse = async (socket, sessionId, requesterIdentifier, allow) => {
  try {
    console.log("Screen share response from streamer:", allow, "for:", requesterIdentifier);
    const state = roomState.get(sessionId);
    if (!state) return;

    // Find the request by socketId or userId
    let request;
    
    // First try to find by socketId (shorter ID)
    if (requesterIdentifier && requesterIdentifier.length < 24) {
      for (const [userId, req] of state.pendingScreenShareRequests) {
        if (req.socketId === requesterIdentifier) {
          request = req;
          break;
        }
      }
    } 
    // If not found, try by userId
    if (!request) {
      request = state.pendingScreenShareRequests.get(requesterIdentifier);
    }

    if (!request) {
      console.log("No pending screen share request found for:", requesterIdentifier);
      return;
    }

    state.pendingScreenShareRequests.delete(request.userId);

    safeEmit(request.socketId, "screen-share-response", {
      allowed: allow,
      message: allow ? "You can now share your screen" : "Streamer denied your screen share request"
    });

    if (allow) {
      // Add to active screen shares
      state.activeScreenShares.set(request.userId, {
        userId: request.userId,
        socketId: request.socketId,
        userName: request.userName,
        startedAt: new Date()
      });
      
      // Update participant status
      const participant = state.participants.get(request.userId);
      if (participant) {
        participant.isScreenSharing = true;
        io.to(sessionId).emit("participant_updated", {
          userId: request.userId,
          updates: { isScreenSharing: true }
        });
      }
      
      // Notify all participants that screen share is starting
      io.to(sessionId).emit("screen-share-started-by-viewer", {
        userId: request.userId,
        userName: request.userName,
        socketId: request.socketId
      });
    }
  } catch (error) {
    console.error("Screen share response error:", error);
  }
};

const handleViewerScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
  try {
    console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const meta = state.sockets.get(socket.id);
    if (!meta) return callback({ error: "Unauthorized" });

    if (!state.activeScreenShares.has(meta.userId)) {
      return callback({ error: "No screen share permission" });
    }

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: {
        socketId: socket.id,
        environment: process.env.NODE_ENV,
        source: 'viewer-screen',
        userId: meta.userId
      },
    });

    state.producers.set(producer.id, producer);

    // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
    if (state.streamerSocketId) {
      safeEmit(state.streamerSocketId, "new-viewer-screen-producer", {
        producerId: producer.id,
        kind: producer.kind,
        userId: meta.userId,
        userName: meta.userName || 'Viewer',
        source: 'viewer-screen'
      });
    }

    // Notify all participants about the new screen share producer
    io.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: meta.userId,
      source: 'viewer-screen'
    });

    callback({ id: producer.id });

    producer.on("transportclose", () => {
      console.log("Viewer screen share producer transport closed:", producer.id);
      try {
        producer.close();
      } catch (e) {
        // ignore
      }
      state.producers.delete(producer.id);
    });

    producer.on("trackended", () => {
      console.log("Viewer screen share track ended:", producer.id);
      handleViewerScreenShareStop(socket, sessionId, meta.userId);
    });

  } catch (error) {
    console.error("Viewer screen share start error:", error);
    callback({ error: error.message });
  }
};

// Handle streamer specifically requesting to consume viewer screen
const handleStreamerConsumeViewerScreen = async (socket, sessionId, producerId) => {
  try {
    console.log("Streamer consuming viewer screen:", producerId);
    const state = roomState.get(sessionId);
    if (!state || !state.router) return;

    const producer = state.producers.get(producerId);
    if (!producer) return;

    // Create a consumer for the streamer
    createConsumer(socket, sessionId, producerId, producer.kind);
  } catch (error) {
    console.error("Streamer consume viewer screen error:", error);
  }
};

// Add this new handler for screen share audio
const handleViewerScreenShareAudio = async (socket, sessionId, transportId, rtpParameters, callback) => {
  try {
    console.log("Viewer screen share audio for transport:", transportId);
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const meta = state.sockets.get(socket.id);
    if (!meta) return callback({ error: "Unauthorized" });

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    const producer = await transport.produce({
      kind: "audio",
      rtpParameters,
      appData: {
        socketId: socket.id,
        environment: process.env.NODE_ENV,
        source: 'viewer-screen-audio',
        userId: meta.userId
      },
    });

    state.producers.set(producer.id, producer);

    // Notify all participants about the new screen share audio producer
    io.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: meta.userId,
      source: 'viewer-screen-audio'
    });

    callback({ id: producer.id });

    producer.on("transportclose", () => {
      console.log("Viewer screen share audio producer transport closed:", producer.id);
      try {
        producer.close();
      } catch (e) {
        // ignore
      }
      state.producers.delete(producer.id);
    });

  } catch (error) {
    console.error("Viewer screen share audio error:", error);
    callback({ error: error.message });
  }
};

const handleViewerScreenShareStop = async (socket, sessionId, userId = null) => {
  try {
    console.log("Viewer screen share stop from:", socket.id);
    const state = roomState.get(sessionId);
    if (!state) return;

    const targetUserId = userId || socket.data?.userId;
    if (!targetUserId) return;

    state.activeScreenShares.delete(targetUserId);

    const participant = state.participants.get(targetUserId);
    if (participant) {
      participant.isScreenSharing = false;
      io.to(sessionId).emit("participant_updated", {
        userId: targetUserId,
        updates: { isScreenSharing: false }
      });
    }

    for (const [producerId, producer] of state.producers) {
      if (producer.appData?.userId === targetUserId && 
          (producer.appData?.source === 'viewer-screen' || producer.appData?.source === 'viewer-screen-audio')) {
        try {
          producer.close();
          state.producers.delete(producerId);
          console.log(`Screen share producer ${producerId} closed`);
        } catch (e) {
          console.warn("Error closing screen share producer:", e);
        }
      }
    }

    io.to(sessionId).emit("screen-share-stopped-by-viewer", {
      userId: targetUserId
    });

    console.log(`Screen share stopped for user: ${targetUserId}`);
  } catch (error) {
    console.error("Viewer screen share stop error:", error);
  }
};


const handleStreamerStopScreenShare = async (socket, sessionId, targetUserId) => {
  try {
    console.log("Streamer stopping screen share for user:", targetUserId);
    const state = roomState.get(sessionId);
    if (!state) return;

    // ❌ yeh missing tha
    state.activeScreenShares.delete(targetUserId);

    // Update participant status
    const participant = state.participants.get(targetUserId);
    if (participant) {
      participant.isScreenSharing = false;
      io.to(sessionId).emit("participant_updated", {
        userId: targetUserId,
        updates: { isScreenSharing: false }
      });
    }

    // Find and close the screen share producer(s)
    for (const [producerId, producer] of state.producers) {
      if (producer.appData?.userId === targetUserId &&
          (producer.appData?.source === "viewer-screen" || producer.appData?.source === "viewer-screen-audio")) {
        try {
          producer.close();
        } catch (e) {}
        state.producers.delete(producerId);
        console.log(`Screen share producer ${producerId} closed`);
      }
    }

    // Notify the viewer
    const viewerSocket = state.participants.get(targetUserId)?.socketId;
    if (viewerSocket) {
      safeEmit(viewerSocket, "screen-share-force-stop", {
        message: "Streamer stopped your screen share"
      });
    }

    // Notify all participants
    io.to(sessionId).emit("screen-share-stopped-by-viewer", {
      userId: targetUserId
    });

    console.log(`✅ Streamer forced stop of screen share for user ${targetUserId}`);
  } catch (error) {
    console.error("Streamer stop screen share error:", error);
  }
};

// ======= Participant Management Functions =======
const getParticipantsHandler = async (socket, sessionId, callback) => {
  try {
    console.log("getParticipants for session:", sessionId);
    const state = roomState.get(sessionId);
    if (!state) return callback([]);
    
    const participants = Array.from(state.participants.values());
    callback(participants);
  } catch (error) {
    console.error("getParticipants error:", error);
    callback([]);
  }
};

const updateParticipantStatusHandler = async (socket, sessionId, updates) => {
  try {
    console.log("updateParticipantStatus for session:", sessionId, "updates:", updates);
    const state = roomState.get(sessionId);
    if (!state) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    const participant = state.participants.get(meta.userId);
    if (participant) {
      Object.assign(participant, updates);
      
      io.to(sessionId).emit("participant_updated", {
        userId: meta.userId,
        updates
      });
    }
  } catch (error) {
    console.error("updateParticipantStatus error:", error);
  }
};

const cleanupSocketFromRoom = async (socket) => {
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

    if (state.pendingScreenShareRequests.has(meta.userId)) {
      state.pendingScreenShareRequests.delete(meta.userId);
    }

    if (state.activeScreenShares.has(meta.userId)) {
      await handleViewerScreenShareStop(socket, sid, meta.userId);
    }

    // Clean up consumers
    for (const [consumerId, consumer] of state.consumers) {
      try {
        if (consumer?.appData?.socketId === socket.id) {
          consumer.close();
          state.consumers.delete(consumerId);
          console.log(`Consumer ${consumerId} cleaned up for socket: ${socket.id}`);
        }
      } catch (e) {
        console.warn("Consumer cleanup error:", e);
      }
    }

    // Clean up transports
    for (const [transportId, transport] of state.transports) {
      try {
        if (transport?.appData?.socketId === socket.id) {
          transport.close();
          state.transports.delete(transportId);
          console.log(`Transport ${transportId} cleaned up for socket: ${socket.id}`);
        }
      } catch (e) {
        console.warn("Transport cleanup error:", e);
      }
    }

    // Clean up producers
    for (const [producerId, producer] of state.producers) {
      try {
        if (producer?.appData?.socketId === socket.id) {
          producer.close();
          state.producers.delete(producerId);
          console.log(`Producer ${producerId} closed and removed`);
        }
      } catch (e) {
        console.warn("Producer cleanup error:", e);
      }
    }

    if (meta.userId) {
      state.participants.delete(meta.userId);
      
      io.to(sid).emit("participant_left", {
        userId: meta.userId,
        socketId: socket.id
      });
    }

    if (state.whiteboardId) {
      console.log(`Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`);
      const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
      if (wb) {
        const participant = wb.participants.find(p => p.user.toString() === meta.userId);
        if (participant) {
          participant.status = "LEFT";
          participant.leftAt = new Date();
        }
        await wb.save();
        console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
      }
    }

    if (meta.role !== ROLE_MAP.STREAMER) {
      try {
        const participant = await liveSessionParticipant.findOne({ 
          $or: [
            { sessionId: sid, userId: meta.userId },
            { socketId: socket.id }
          ]
        });
        
        if (participant) {
          participant.status = "LEFT";
          participant.leftAt = new Date();
          participant.isActiveDevice = false;
          await participant.save();
          console.log(`Participant ${meta.userId} marked as LEFT`);
        }
      } catch (e) {
        console.error("cleanup update error:", e?.message || e);
      }

      state.viewers.delete(socket.id);
      io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
      console.log(`Viewer ${socket.id} left room ${sid}`);
    } else {
      console.log(`Streamer ${socket.id} left room ${sid}`);
      
      if (state.streamerSocketId === socket.id) {
        state.streamerSocketId = null;
        console.log(`Cleared streamerSocketId for session: ${sid}`);
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

    if (state.sockets.size === 0) {
      if (state.pendingOps && state.pendingOps.length > 0) {
        await flushCanvasOps(sid).catch(err => {
          console.error(`Error flushing canvas ops during cleanup for session ${sid}:`, err);
        });
      }

      if (state.flushTimer) clearTimeout(state.flushTimer);
      
      if (state.router) {
        try {
          state.router.close();
          console.log(`Mediasoup router closed for session: ${sid}`);
        } catch (e) {
          console.warn("Error closing router:", e);
        }
        state.router = null;
      }
      
      roomState.delete(sid);
      console.log(`Room state cleaned up for session: ${sid}`);
    }
  } catch (e) {
    console.error("cleanupSocketFromRoom error:", e?.message || e);
  }
};

const handleScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
  try {
    console.log("Screen share start for transport:", transportId, "kind:", kind);
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: {
        socketId: socket.id,
        environment: process.env.NODE_ENV,
        source: 'screen',
        userId: socket.data.userId 
      },
    });

    state.producers.set(producer.id, producer);

    producer.on("transportclose", () => {
      console.log("Screen share producer transport closed:", producer.id);
      try {
        producer.close();
      } catch (e) {
        // ignore
      }
      state.producers.delete(producer.id);
    });

    callback({ id: producer.id });

    socket.to(sessionId).emit("screen-share-started", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: 'screen'
    });
    
    socket.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: 'screen'
    });
  } catch (error) {
    console.error("Screen share start error:", error);
    callback({ error: error.message });
  }
};

const handleViewerAudioProduce = async (socket, sessionId, transportId, rtpParameters, callback) => {
  try {
    console.log("Viewer audio produce for transport:", transportId);
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    const producer = await transport.produce({
      kind: "audio",
      rtpParameters,
      appData: {
        socketId: socket.id,
        environment: process.env.NODE_ENV,
        source: 'viewer-mic',
        userId: socket.data.userId
      },
    });

    state.producers.set(producer.id, producer);

    // Notify all participants about the new audio producer
    io.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: 'viewer-mic'
    });

    // ✅ FIX: Now emit audio permission granted WITH real producerId
    io.to(sessionId).emit("viewer-audio-permission-granted", {
      userId: socket.data.userId,
      producerId: producer.id,
      socketId: socket.id,
      userName: state.sockets.get(socket.id)?.userName || 'Viewer'
    });

    callback({ id: producer.id });

    const meta = state.sockets.get(socket.id);
    if (meta) {
      const participant = state.participants.get(meta.userId);
      if (participant) {
        participant.hasAudio = true;
        io.to(sessionId).emit("participant_updated", {
          userId: meta.userId,
          updates: { hasAudio: true }
        });
      }
    }

    producer.on("transportclose", () => {
      console.log("Viewer audio producer transport closed:", producer.id);
      try {
        producer.close();
      } catch (e) {
        // ignore
      }
      state.producers.delete(producer.id);
    });

  } catch (error) {
    console.error("Viewer audio produce error:", error);
    callback({ error: error.message });
  }
};


const handleViewerVideoProduce = async (socket, sessionId, transportId, rtpParameters, callback) => {
  try {
    console.log("Viewer video produce for transport:", transportId);
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    const producer = await transport.produce({
      kind: "video",
      rtpParameters,
      appData: {
        socketId: socket.id,
        environment: process.env.NODE_ENV,
        source: 'viewer-camera',
        userId: socket.data.userId
      },
    });

    state.producers.set(producer.id, producer);

    // Notify all participants about the new video producer
    io.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: 'viewer-camera'
    });

    callback({ id: producer.id });

    producer.on("transportclose", () => {
      console.log("Viewer video producer transport closed:", producer.id);
      try {
        producer.close();
      } catch (e) {
        // ignore
      }
      state.producers.delete(producer.id);
    });

  } catch (error) {
    console.error("Viewer video produce error:", error);
    callback({ error: error.message });
  }
};

const handleViewerAudioRequest = async (socket, sessionId) => {
  try {
    console.log("Viewer audio permission request from:", socket.id);
    const state = roomState.get(sessionId);
    if (!state || !state.streamerSocketId) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    const user = await authenticationModel.findById(meta.userId).select("name");
    
    safeEmit(state.streamerSocketId, "viewer-audio-request", {
      requestedUserId: meta.userId,
      requesterSocketId: socket.id,
      requesterName: user?.name || "Viewer"
    });
  } catch (error) {
    console.error("Viewer audio request error:", error);
  }
};

const handleViewerVideoRequest = async (socket, sessionId) => {
  try {
    console.log("Viewer video permission request from:", socket.id);
    const state = roomState.get(sessionId);
    if (!state || !state.streamerSocketId) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    const user = await authenticationModel.findById(meta.userId).select("name");
    
    safeEmit(state.streamerSocketId, "viewer-video-request", {
      requestedUserId: meta.userId,
      requesterSocketId: socket.id,
      requesterName: user?.name || "Viewer"
    });
  } catch (error) {
    console.error("Viewer video request error:", error);
  }
};
const handleViewerAudioResponse = (socket, sessionId, requesterSocketId, allow) => {
  console.log(`Viewer audio response from streamer: ${allow} for: ${requesterSocketId}`);

  if (allow) {
    // Sirf viewer ko response bhejo
    io.to(requesterSocketId).emit("viewer-audio-response", { allowed: true });
  } else {
    io.to(requesterSocketId).emit("viewer-audio-response", { allowed: false });
  }
};






const handleViewerVideoResponse = async (socket, sessionId, requesterIdentifier, allow) => {
  try {
    console.log("Viewer video response from streamer:", allow, "for:", requesterIdentifier);
    const state = roomState.get(sessionId);
    if (!state) return;

    // Find the viewer's socket
    let viewerSocketId = requesterIdentifier;
    let viewerUserId = requesterIdentifier;
    
    // Handle both socketId and userId input
    if (requesterIdentifier && requesterIdentifier.length === 24) {
      // It's a userId, find the socket
      for (const [sockId, meta] of state.sockets) {
        if (meta.userId === requesterIdentifier) {
          viewerSocketId = sockId;
          viewerUserId = meta.userId;
          break;
        }
      }
    } else {
      // It's a socketId, find the userId
      const meta = state.sockets.get(requesterIdentifier);
      if (meta) {
        viewerUserId = meta.userId;
      }
    }

    if (!viewerSocketId) {
      console.log("Could not find viewer socket for:", requesterIdentifier);
      return;
    }

    // Send response to viewer
    safeEmit(viewerSocketId, "viewer-video-response", {
      allowed: allow,
      message: allow ? "You can now share video" : "Streamer denied your video request"
    });

    if (allow) {
      // Get the video producer for this viewer
      let videoProducerId = null;
      for (const [producerId, producer] of state.producers) {
        if (producer.appData?.userId === viewerUserId && 
            producer.appData?.source === 'viewer-camera') {
          videoProducerId = producerId;
          break;
        }
      }

      // Update participant status for ALL participants
      const viewerMeta = state.sockets.get(viewerSocketId);
      if (viewerMeta) {
        const participant = state.participants.get(viewerMeta.userId);
        if (participant) {
          participant.hasVideo = true;
          
          // Notify ALL participants that this viewer can now share video
          io.to(sessionId).emit("participant_updated", {
            userId: viewerMeta.userId,
            updates: { hasVideo: true }
          });
          
          // Notify everyone to consume this viewer's video
          io.to(sessionId).emit("viewer-video-permission-granted", {
            userId: viewerMeta.userId,
            producerId: videoProducerId,
            socketId: viewerSocketId,
            userName: viewerMeta.userName || 'Viewer'
          });
        }
      }
    }
  } catch (error) {
    console.error("Viewer video response error:", error);
  }
};

const handleViewerAudioMute = async (socket, sessionId, targetSocketId) => {
  try {
    console.log("Muting viewer audio:", targetSocketId);
    const state = roomState.get(sessionId);
    if (!state) return;

    for (const [producerId, producer] of state.producers) {
      if (producer.appData?.socketId === targetSocketId && 
          producer.kind === "audio" && 
          producer.appData?.source === 'viewer-mic') {
        await producer.pause();
        console.log(`Viewer audio producer ${producerId} muted`);
        
        const viewerMeta = state.sockets.get(targetSocketId);
        if (viewerMeta) {
          const participant = state.participants.get(viewerMeta.userId);
          if (participant) {
            participant.hasAudio = false;
            io.to(sessionId).emit("participant_updated", {
              userId: viewerMeta.userId,
              updates: { hasAudio: false }
            });
          }
        }
        
        safeEmit(targetSocketId, "viewer-audio-muted", {
          producerId: producer.id,
          mutedBy: socket.data.userId
        });
        
        break;
      }
    }
  } catch (error) {
    console.error("Viewer audio mute error:", error);
  }
};

const handleViewerVideoMute = async (socket, sessionId, targetSocketId) => {
  try {
    console.log("Muting viewer video:", targetSocketId);
    const state = roomState.get(sessionId);
    if (!state) return;

    for (const [producerId, producer] of state.producers) {
      if (producer.appData?.socketId === targetSocketId && 
          producer.kind === "video" && 
          producer.appData?.source === 'viewer-camera') {
        await producer.pause();
        console.log(`Viewer video producer ${producerId} muted`);
        
        const viewerMeta = state.sockets.get(targetSocketId);
        if (viewerMeta) {
          const participant = state.participants.get(viewerMeta.userId);
          if (participant) {
            participant.hasVideo = false;
            io.to(sessionId).emit("participant_updated", {
              userId: viewerMeta.userId,
              updates: { hasVideo: false }
            });
          }
        }
        
        safeEmit(targetSocketId, "viewer-video-muted", {
          producerId: producer.id,
          mutedBy: socket.data.userId
        });
        
        break;
      }
    }
  } catch (error) {
    console.error("Viewer video mute error:", error);
  }
};

const createConsumer = async (socket, sessionId, producerId, kind) => {
  try {
    console.log("Creating consumer for producer:", producerId, "kind:", kind);
    const state = roomState.get(sessionId);
    if (!state || !state.router) return;

    // Create a transport for the consumer if it doesn't exist
    let consumerTransport;
    for (const [transportId, transport] of state.transports) {
      if (transport.appData?.socketId === socket.id && transport.appData?.type === 'consumer') {
        consumerTransport = transport;
        break;
      }
    }

    if (!consumerTransport) {
      consumerTransport = await state.router.createWebRtcTransport({
        listenIps: [
          {
            ip: "0.0.0.0",
            announcedIp: process.env.SERVER_IP || "127.0.0.1",
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      consumerTransport.appData = { socketId: socket.id, type: 'consumer' };
      state.transports.set(consumerTransport.id, consumerTransport);

      // Send transport parameters to the client
      socket.emit("new-consumer-transport", {
        id: consumerTransport.id,
        iceParameters: consumerTransport.iceParameters,
        iceCandidates: consumerTransport.iceCandidates,
        dtlsParameters: consumerTransport.dtlsParameters,
      });
    }

    const producer = state.producers.get(producerId);
    if (!producer) {
      console.log("Producer not found for consumer creation:", producerId);
      return;
    }

    const consumer = await consumerTransport.consume({
      producerId,
      rtpCapabilities: state.router.rtpCapabilities,
      paused: false,
    });

    state.consumers.set(consumer.id, consumer);

    // Send consumer parameters to the client
    socket.emit("consumer-created", {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });

    consumer.on("transportclose", () => {
      console.log("Consumer transport closed:", consumer.id);
      state.consumers.delete(consumer.id);
    });

    consumer.on("producerclose", () => {
      console.log("Producer closed for consumer:", consumer.id);
      socket.emit("producer-closed", { consumerId: consumer.id });
      state.consumers.delete(consumer.id);
    });

  } catch (error) {
    console.error("createConsumer error:", error);
  }
};

const joinRoomHandler = async (socket, data) => {
  const { token, sessionId, roomCode } = data;
  console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);
  
  try {
    if (!token || (!sessionId && !roomCode)) {
      return socket.emit("error_message", "Missing token or sessionId/roomCode");
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.SECRET_KEY);
      console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
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
      const allowed = Array.isArray(session.allowedUsers) && 
        session.allowedUsers.some(u => u.toString() === userId);
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
        participants: new Map(),
        pendingScreenShareRequests: new Map(),
        activeScreenShares: new Map(),
        pendingOps: [],
        flushTimer: null,
        router: null,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
      });
      console.log(`New room state created for session: ${sid}`);
    }
    
    const state = roomState.get(sid);

    const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
    const activeCount = await liveSessionParticipant.countDocuments({ 
      sessionId: session._id, 
      status: { $ne: "LEFT" } 
    });
    
    if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
      return socket.emit("error_message", "Max participants limit reached");
    }

    let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
    if (participant && participant.isBanned) {
      return socket.emit("error_message", "You are banned from this session");
    }

    if (userRole === ROLE_MAP.STREAMER) {
      if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
        console.log(`Streamer reconnecting from ${state.streamerSocketId} to ${socket.id}`);
        if (state.sockets.has(state.streamerSocketId)) {
          state.sockets.delete(state.streamerSocketId);
          state.viewers.delete(state.streamerSocketId);
        }
      }
      state.streamerSocketId = socket.id;
      console.log(`Streamer socket ID updated to: ${socket.id}`);
    }

    if (!participant) {
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
      participant.socketId = socket.id;
      participant.status = "JOINED";
      participant.isActiveDevice = true;
      participant.joinedAt = new Date();
      participant.leftAt = null;
      await participant.save();
    }

    const user = await authenticationModel.findById(userId).select("name");
    
    state.participants.set(userId, {
      userId,
      socketId: socket.id,
      name: user?.name || "Unknown",
      role: userRole,
      joinedAt: new Date(),
      isSpeaking: false,
      hasAudio: false,
      hasVideo: false,
      isScreenSharing: false,
    });

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

    state.sockets.set(socket.id, { userId, role: userRole, userName: user?.name || "Unknown" });
    socket.data = { sessionId: sid, userId, role: userRole };
    socket.join(sid);
    console.log(`Socket ${socket.id} joined room ${sid}`);

    const iceServers = getIceServersFromEnv();
    socket.emit("ice_servers", iceServers);

    io.to(sid).emit("participant_joined", {
      userId,
      name: user?.name || "Unknown",
      role: userRole,
      socketId: socket.id,
      joinedAt: new Date(),
      isSpeaking: false,
      hasAudio: false,
      hasVideo: false,
      isScreenSharing: false,
    });

    const currentParticipants = Array.from(state.participants.values());
    socket.emit("participants_list", currentParticipants);

    if (userRole === ROLE_MAP.STREAMER) {
      socket.emit("joined_room", {
        as: "STREAMER",
        sessionId: sid,
        roomCode: session.roomCode,
        hasMediasoup: !!state.router,
        environment: process.env.NODE_ENV,
        iceServers: iceServers,
        activeProducers: Array.from(state.producers.keys()),
        pendingScreenShareRequests: Array.from(state.pendingScreenShareRequests.values()),
        activeScreenShares: Array.from(state.activeScreenShares.values())
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
        iceServers: iceServers,
        activeProducers: Array.from(state.producers.keys())
      });
      console.log(`Viewer ${socket.id} joined room ${sid}`);
      
      if (state.streamerSocketId) {
        safeEmit(state.streamerSocketId, "viewer_ready", { 
          viewerSocketId: socket.id, 
          viewerUserId: userId 
        });
      }
    }

    if (state.whiteboardId) {
      const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
      if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
        wb.participants.push({ 
          user: userId, 
          role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", 
          joinedAt: new Date() 
        });
        await wb.save();
        console.log(`User added to whiteboard: ${state.whiteboardId}`);
      }
    }

    const currentParticipantsCount = state.viewers.size + (state.streamerSocketId ? 1 : 0);
    if ((session.peakParticipants || 0) < currentParticipantsCount) {
      session.peakParticipants = currentParticipantsCount;
      await session.save();
      console.log(`New peak participants: ${currentParticipantsCount}`);
    }
  } catch (err) {
    console.error("join_room error:", err);
    socket.emit("error_message", "Invalid token/session");
    throw err;
  }
};

const chatHandler = async (socket, sessionId, message) => {
  console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}`);
  
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
      at: new Date(),
    });
    
    console.log(`Chat message broadcast to session: ${sessionId}`);
  } catch (err) {
    console.error("chat_message error:", err);
    throw err;
  }
};

const streamerControlHandler = async (socket, data) => {
  const { sessionId, status, emitEvent } = data;
  console.log(`Streamer control request for session: ${sessionId}, status: ${status}`);
  
  try {
    const session = await liveSession.findOne({ sessionId });
    if (!session) return;

    if (status === "PAUSED") {
      await pauseAllProducers(sessionId, socket.id);
    } else if (status === "ACTIVE") {
      await resumeAllProducers(sessionId, socket.id);
    }

    session.status = status;
    if (status === "ACTIVE" && emitEvent === "streamer_started") {
      session.actualStartTime = new Date();
    }

    await session.save();
    io.to(sessionId).emit(emitEvent, { sessionId });
    console.log(`Session ${sessionId} ${status.toLowerCase()} by streamer`);
  } catch (err) {
    console.error("streamer_control error:", err);
    throw err;
  }
};

const getRouterRtpCapabilitiesHandler = async (socket, sessionId, callback) => {
  try {
    console.log("getRouterRtpCapabilities for session:", sessionId);
    const state = roomState.get(sessionId);
    if (!state || !state.router) return callback({ error: "Router not found" });
    callback({ rtpCapabilities: state.router.rtpCapabilities });
  } catch (error) {
    console.error("getRouterRtpCapabilities error:", error);
    callback({ error: error.message });
  }
};

const createWebRtcTransportHandler = async (socket, sessionId, callback) => {
  try {
    console.log("createWebRtcTransport for session:", sessionId);
    const state = roomState.get(sessionId);
    if (!state || !state.router) return callback({ error: "Router not found" });

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
      if (dtlsState === "closed") transport.close();
    });

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
};

const transportConnectHandler = async (socket, sessionId, transportId, dtlsParameters, callback) => {
  try {
    console.log("transport-connect for transport:", transportId);
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    await transport.connect({ dtlsParameters });
    callback({ success: true });
  } catch (error) {
    console.error("transport-connect error:", error);
    callback({ error: error.message });
  }
};

const transportProduceHandler = async (socket, sessionId, transportId, kind, rtpParameters, appData, callback) => {
  try {
    console.log("transport-produce for transport:", transportId, "kind:", kind, "source:", appData?.source);
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: {
        socketId: socket.id,
        environment: process.env.NODE_ENV,
        source: appData?.source || 'camera',
        userId: socket.data.userId 
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

    socket.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: appData?.source || 'camera'
    });
  } catch (error) {
    console.error("transport-produce error:", error);
    callback({ error: error.message });
  }
};

const consumeHandler = async (socket, sessionId, transportId, producerId, rtpCapabilities, callback) => {
  try {
    console.log("consume for producer:", producerId, "transport:", transportId);
    const state = roomState.get(sessionId);
    if (!state || !state.router) {
      console.log("❌ Router not found for session:", sessionId);
      return callback({ error: "Router not found" });
    }

    const producer = state.producers.get(producerId);
    if (!producer) {
      console.log("❌ Producer not found:", producerId);
      return callback({ error: "Producer not found" });
    }

    if (!state.router.canConsume({ producerId, rtpCapabilities })) {
      console.log("❌ Cannot consume - router.canConsume returned false");
      return callback({ error: "Cannot consume" });
    }

    const transport = state.transports.get(transportId);
    if (!transport) {
      console.log("❌ Transport not found:", transportId);
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

    state.consumers.set(consumer.id, consumer);
    console.log("✅ Consumer created:", consumer.id);

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
};

const consumerResumeHandler = async (socket, sessionId, consumerId, callback) => {
  try {
    console.log("consumer-resume for consumer:", consumerId);
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const consumer = state.consumers.get(consumerId);
    if (!consumer) return callback({ error: "Consumer not found" });

    await consumer.resume();
    callback({ success: true });
  } catch (error) {
    console.error("consumer-resume error:", error);
    callback({ error: error.message });
  }
};

const getProducersHandler = async (socket, sessionId, callback) => {
  try {
    console.log("getProducers for session:", sessionId);
    const state = roomState.get(sessionId);
    callback(state ? Array.from(state.producers.keys()) : []);
  } catch (error) {
    console.error("getProducers error:", error);
    callback([]);
  }
};
const getProducerInfoHandler = async (socket, sessionId, producerId, callback) => {
  try {
    console.log("getProducerInfo for producer:", producerId);
    const state = roomState.get(sessionId);
    if (!state) return callback(null);

    const producer = state.producers.get(producerId);
    if (!producer) return callback(null);

    callback({
      id: producer.id,
      kind: producer.kind,
      userId:  producer.appData?.userId,
      socketId: producer.appData?.socketId,
      source: producer.appData?.source || 'camera'
    });
  } catch (error) {
    console.error("getProducerInfo error:", error);
    callback(null);
  }
};

const consumerReadyHandler = async (socket, sessionId, consumerId, callback) => {
  try {
    console.log("consumer-ready for consumer:", consumerId);
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const consumer = state.consumers.get(consumerId);
    if (!consumer) return callback({ error: "Consumer not found" });

    callback({ success: true });
  } catch (error) {
    console.error("consumer-ready error:", error);
    callback({ error: error.message });
  }
};

const offerHandler = (socket, sessionId, targetSocketId, sdp) => {
  console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || state.streamerSocketId !== socket.id) return;
  safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
};

const answerHandler = (socket, sessionId, sdp) => {
  console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state) return;

  const meta = state.sockets.get(socket.id);
  if (!meta || meta.role === ROLE_MAP.STREAMER) return;

  safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
};

const iceCandidateHandler = (socket, sessionId, targetSocketId, candidate) => {
  console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state) return;
  safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
};

const whiteboardEventHandler = (socket, sessionId, type, data, patch) => {
  console.log(`Whiteboard ${type} from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || !state.whiteboardId) return;

  const meta = state.sockets.get(socket.id);
  if (!meta) return;

  socket.to(sessionId).emit(`whiteboard_${type}`, { 
    userId: meta.userId, 
    [`${type}Data`]: data 
  });
  
  scheduleFlush(sessionId, { type, payload: data, patch, at: new Date() });
};

const whiteboardUndoHandler = async (socket, sessionId) => {
  console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || !state.whiteboardId) return;

  const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
  if (!wb) return;

  const undoStack = wb.undoStack || [];
  if (undoStack.length === 0) return;

  const last = undoStack.pop();
  wb.undoStack = undoStack.slice(-500);
  wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
  wb.lastActivity = new Date();
  
  await wb.save();
  io.to(sessionId).emit("whiteboard_undo_applied", { last });
  console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
};

const whiteboardRedoHandler = async (socket, sessionId) => {
  console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || !state.whiteboardId) return;

  const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
  if (!wb) return;

  const redoStack = wb.redoStack || [];
  if (redoStack.length === 0) return;

  const last = redoStack.pop();
  wb.redoStack = redoStack.slice(-500);
  wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
  wb.lastActivity = new Date();
  
  await wb.save();
  io.to(sessionId).emit("whiteboard_redo_applied", { last });
  console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
};

const whiteboardSaveCanvasHandler = async (socket, sessionId) => {
  console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
  await flushCanvasOps(sessionId).catch(err => {
    console.error(`Error saving canvas for session ${sessionId}:`, err);
  });
  socket.emit("whiteboard_saved");
  console.log(`Whiteboard saved for session: ${sessionId}`);
};

const cursorUpdateHandler = (socket, sessionId, position) => {
  console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state) return;

  const meta = state.sockets.get(socket.id);
  if (!meta) return;

  socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
};

const whiteboardStateRequestHandler = async (socket, sessionId) => {
  console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || !state.whiteboardId) return;

  const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
  if (!wb) return;

  socket.emit("whiteboard_state_sync", {
    canvasData: wb.canvasData,
    participants: wb.participants,
    versionHistory: wb.versionHistory,
  });
  
  console.log(`Whiteboard state sent to socket: ${socket.id}`);
};

export const setupIntegratedSocket = async (server) => {
  console.log("Setting up integrated socket");

  try {
    mediasoupWorker = await createMediasoupWorker();
  } catch (error) {
    console.error("Failed to initialize Mediasoup:", error);
    throw error;
  }

  const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5174";
  io = new Server(server, {
    cors: {
      origin: corsOrigin,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  console.log(`Socket.io configured with CORS origin: ${corsOrigin} for ${process.env.NODE_ENV} environment`);

  io.on("connection", (socket) => {
    console.log("New client connected:", socket.id);

    // ====== NEW EVENT HANDLERS ADDED ======
    // These events will forward messages to all clients in the room
    socket.on("new-producer", (data) => {
      console.log("New producer event received, forwarding to room:", data.sessionId);
      socket.to(data.sessionId).emit("new-producer", data);
    });
    
    socket.on("viewer-audio-enabled", (data) => {
      console.log("Viewer audio enabled event received, forwarding to room:", data.sessionId);
      socket.to(data.sessionId).emit("viewer-audio-enabled", data);
    });
    
    socket.on("screen-share-started-by-viewer", (data) => {
      console.log("Screen share started by viewer event received, forwarding to room:", data.sessionId);
      socket.to(data.sessionId).emit("screen-share-started-by-viewer", data);
    });

    // NEW: Handle streamer consuming viewer screen
    socket.on("streamer-consume-viewer-screen", (data) => 
      handleStreamerConsumeViewerScreen(socket, data.sessionId, data.producerId)
    );
    // ====== END OF NEW EVENT HANDLERS ======

    // ====== PERMISSION AND MEDIA EVENT HANDLERS ======
   // yeh tumhara existing call hai
socket.on("viewer-audio-response", (data) => {
  handleViewerAudioResponse(
    socket,
    data.sessionId,
    data.requesterSocketId,
    data.allow
  );
});

    
    socket.on("viewer-video-response", (data) => 
      handleViewerVideoResponse(socket, data.sessionId, data.requesterSocketId, data.allow)
    );
    
    socket.on("screen-share-response", (data) => 
      handleScreenShareResponse(socket, data.sessionId, data.requesterUserId, data.allow)
    );
    
    socket.on("screen-share-force-stop", (data) => 
      handleStreamerStopScreenShare(socket, data.sessionId, data.targetUserId)
    );
    
    socket.on("viewer-audio-muted", (data) => 
      handleViewerAudioMuted(socket, data.sessionId, data)
    );
    
    socket.on("viewer-video-muted", (data) => 
      handleViewerVideoMuted(socket, data.sessionId, data)
    );
    
    socket.on("viewer-audio-started", (data) => 
      handleViewerAudioStarted(socket, data.sessionId, data)
    );
    
    socket.on("viewer-video-started", (data) => 
      handleViewerVideoStarted(socket, data.sessionId, data)
    );
    
    socket.on("screen-share-started-by-viewer", (data) => 
      handleScreenShareStartedByViewer(socket, data.sessionId, data)
    );
    
    socket.on("screen-share-stopped-by-viewer", (data) => 
      handleViewerScreenShareStop(socket, data.sessionId, data.userId)
    );
    
    socket.on("viewer-audio-enabled", (data) => 
      handleViewerAudioEnabled(socket, data.sessionId, data)
    );
    
    socket.on("viewer-video-enabled", (data) => 
      handleViewerVideoEnabled(socket, data.sessionId, data)
    );

    // Room and chat events
    socket.on("join_room", (data) => joinRoomHandler(socket, data));
    socket.on("chat_message", (data) => chatHandler(socket, data.sessionId, data.message));
    socket.on("streamer_control", (data) => streamerControlHandler(socket, data));
    
    // Participant management events
    socket.on("get_participants", (data, cb) => 
      getParticipantsHandler(socket, data.sessionId, cb)
    );
    
    socket.on("update_participant_status", (data) => 
      updateParticipantStatusHandler(socket, data.sessionId, data.updates)
    );
    
    // Screen share events
    socket.on("screen-share-request", (data) => 
      handleScreenShareRequest(socket, data.sessionId)
    );
    
    // Producer control events
    socket.on("producer-pause", (data) => 
      producerPauseHandler(socket, data.sessionId, data.producerId)
    );
    socket.on("producer-resume", (data) => 
      producerResumeHandler(socket, data.sessionId, data.producerId)
    );
    socket.on("producer-close", (data) => 
      producerCloseHandler(socket, data.sessionId, data.producerId)
    );
    
    // Mediasoup events
    socket.on("getRouterRtpCapabilities", (data, cb) => 
      getRouterRtpCapabilitiesHandler(socket, data.sessionId, cb));
    
    socket.on("createWebRtcTransport", (data, cb) => 
      createWebRtcTransportHandler(socket, data.sessionId, cb));
    
    socket.on("transport-connect", (data, cb) =>
      transportConnectHandler(socket, data.sessionId, data.transportId, data.dtlsParameters, cb)
    );
    
    socket.on("transport-produce", (data, cb) =>
      transportProduceHandler(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, data.appData, cb)
    );
    
    // Screen share specific event (for streamer)
    socket.on("transport-produce-screen", (data, cb) =>
      handleScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
    );

    // Viewer audio events
    socket.on("viewer-audio-request", (data) => 
      handleViewerAudioRequest(socket, data.sessionId)
    );

    socket.on("viewer-video-request", (data) => 
      handleViewerVideoRequest(socket, data.sessionId)
    );

    socket.on("transport-produce-viewer-audio", (data, cb) =>
      handleViewerAudioProduce(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
    );

    socket.on("transport-produce-viewer-video", (data, cb) =>
      handleViewerVideoProduce(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
    );

    // Add this to your socket event handlers
    socket.on("transport-produce-viewer-screen-audio", (data, cb) =>
      handleViewerScreenShareAudio(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
    );

    socket.on("viewer-audio-mute", (data) => 
      handleViewerAudioMute(socket, data.sessionId, data.targetSocketId)
    );
    
    socket.on("viewer-video-mute", (data) => 
      handleViewerVideoMute(socket, data.sessionId, data.targetSocketId)
    );
    
    // Viewer screen share events
    socket.on("transport-produce-viewer-screen", (data, cb) =>
      handleViewerScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
    );

    socket.on("screen-share-stop", (data) => 
      handleViewerScreenShareStop(socket, data.sessionId)
    );
        
    socket.on("consume", (data, cb) =>
      consumeHandler(socket, data.sessionId, data.transportId, data.producerId, data.rtpCapabilities, cb)
    );
    
    socket.on("consumer-resume", (data, cb) =>
      consumerResumeHandler(socket, data.sessionId, data.consumerId, cb)
    );
    
    socket.on("getProducers", (data, cb) =>
      getProducersHandler(socket, data.sessionId, cb)
    );
    
    socket.on("getProducerInfo", (data, cb) =>
      getProducerInfoHandler(socket, data.sessionId, data.producerId, cb)
    );
    
    socket.on("consumer-ready", (data, cb) =>
      consumerReadyHandler(socket, data.sessionId, data.consumerId, cb)
    );

    // Whiteboard events
    socket.on("whiteboard_draw", (data) => 
      whiteboardEventHandler(socket, data.sessionId, "draw", data.drawData, data.patch)
    );
    
    socket.on("whiteboard_erase", (data) => 
      whiteboardEventHandler(socket, data.sessionId, "erase", data.eraseData, data.patch)
    );
    
    socket.on("whiteboard_undo", (data) => 
      whiteboardUndoHandler(socket, data.sessionId)
    );
    
    socket.on("whiteboard_redo", (data) => 
      whiteboardRedoHandler(socket, data.sessionId)
    );
    
    socket.on("whiteboard_save", (data) => 
      whiteboardSaveCanvasHandler(socket, data.sessionId)
    );
    
    socket.on("whiteboard_cursor", (data) => 
      cursorUpdateHandler(socket, data.sessionId, data.position)
    );
    
    socket.on("whiteboard_state_request", (data) => 
      whiteboardStateRequestHandler(socket, data.sessionId)
    );

    // WebRTC events
    socket.on("offer", (data) => 
      offerHandler(socket, data.sessionId, data.targetSocketId, data.sdp)
    );
    
    socket.on("answer", (data) => 
      answerHandler(socket, data.sessionId, data.sdp)
    );
    
    socket.on("ice-candidate", (data) => 
      iceCandidateHandler(socket, data.sessionId, data.targetSocketId, data.candidate)
    );

    socket.on("disconnect", () => cleanupSocketFromRoom(socket));
  });

  console.log("✅ Socket.io setup complete with screen share permission system");
  return io;
};

// ====== MISSING HANDLER IMPLEMENTATIONS ======

const handleViewerAudioMuted = async (socket, sessionId, data) => {
  try {
    console.log("Viewer audio muted:", data);
    const state = roomState.get(sessionId);
    if (!state) return;

    // Update participant status
    const participant = state.participants.get(data.userId);
    if (participant) {
      participant.hasAudio = false;
      io.to(sessionId).emit("participant_updated", {
        userId: data.userId,
        updates: { hasAudio: false }
      });
    }

    // Notify all participants
    io.to(sessionId).emit("viewer-audio-muted-global", {
      userId: data.userId,
      userName: data.userName || "Viewer"
    });
  } catch (error) {
    console.error("Viewer audio muted error:", error);
  }
};

const handleViewerVideoMuted = async (socket, sessionId, data) => {
  try {
    console.log("Viewer video muted:", data);
    const state = roomState.get(sessionId);
    if (!state) return;

    // Update participant status
    const participant = state.participants.get(data.userId);
    if (participant) {
      participant.hasVideo = false;
      io.to(sessionId).emit("participant_updated", {
        userId: data.userId,
        updates: { hasVideo: false }
      });
    }

    // Notify all participants
    io.to(sessionId).emit("viewer-video-muted-global", {
      userId: data.userId,
      userName: data.userName || "Viewer"
    });
  } catch (error) {
    console.error("Viewer video muted error:", error);
  }
};

const handleViewerAudioStarted = async (socket, sessionId, data) => {
  try {
    console.log("Viewer audio started:", data);
    const state = roomState.get(sessionId);
    if (!state) return;

    // Update participant status
    const participant = state.participants.get(data.userId);
    if (participant) {
      participant.hasAudio = true;
      io.to(sessionId).emit("participant_updated", {
        userId: data.userId,
        updates: { hasAudio: true }
      });
    }

    // Notify all participants
    io.to(sessionId).emit("viewer-audio-started-global", {
      userId: data.userId,
      userName: data.userName || "Viewer",
      socketId: socket.id
    });
  } catch (error) {
    console.error("Viewer audio started error:", error);
  }
};

const handleViewerVideoStarted = async (socket, sessionId, data) => {
  try {
    console.log("Viewer video started:", data);
    const state = roomState.get(sessionId);
    if (!state) return;

    // Update participant status
    const participant = state.participants.get(data.userId);
    if (participant) {
      participant.hasVideo = true;
      io.to(sessionId).emit("participant_updated", {
        userId: data.userId,
        updates: { hasVideo: true }
      });
    }

    // Notify all participants
    io.to(sessionId).emit("viewer-video-started-global", {
      userId: data.userId,
      userName: data.userName || "Viewer",
      socketId: socket.id
    });
  } catch (error) {
    console.error("Viewer video started error:", error);
  }
};

const handleScreenShareStartedByViewer = async (socket, sessionId, data) => {
  try {
    console.log("Screen share started by viewer:", data);
    const state = roomState.get(sessionId);
    if (!state) return;

    // Update participant status
    const participant = state.participants.get(data.userId);
    if (participant) {
      participant.isScreenSharing = true;
      // Forward to all other participants in the room
      socket.to(sessionId).emit("screen-share-started-by-viewer", data);
    }
  } catch (error) {
    console.error("Screen share started by viewer error:", error);
  }
};

const handleViewerAudioEnabled = async (socket, sessionId, data) => {
  try {
    console.log("Viewer audio enabled:", data);
    const state = roomState.get(sessionId);
    if (!state) return;

    // Update participant status
    const participant = state.participants.get(data.userId);
    if (participant) {
      participant.hasAudio = true;
      // Forward to all other participants in the room
      socket.to(sessionId).emit("viewer-audio-enabled", data);
    }
  } catch (error) {
    console.error("Viewer audio enabled error:", error);
  }
};

const handleViewerVideoEnabled = async (socket, sessionId, data) => {
  try {
    console.log("Viewer video enabled:", data);
    const state = roomState.get(sessionId);
    if (!state) return;

    // Update participant status
    const participant = state.participants.get(data.userId);
    if (participant) {
      participant.hasVideo = true;
      // Forward to all other participants in the room
      socket.to(sessionId).emit("viewer-video-enabled", data);
    }
  } catch (error) {
    console.error("Viewer video enabled error:", error);
  }
};

// Export functions as named exports
export { getIO };






















// This code is working

// import { Server } from "socket.io";
// import jwt from "jsonwebtoken";
// import mediasoup from "mediasoup";
// import liveSession from "../model/liveSessions/liveeSession.model.js";
// import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
// import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
// import { ROLE_MAP } from "../constant/role.js";
// import authenticationModel from "../../app/model/Authentication/authentication.model.js";

// // ======= Global Variables =======
// let io;
// let mediasoupWorker;
// const roomState = new Map();

// // ======= Utility Functions =======
// const getIO = () => {
//   if (!io) throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
//   return io;
// };

// const safeEmit = (toSocketId, event, payload) => {
//   try {
//     const s = io.sockets.sockets.get(toSocketId);
//     if (s) {
//       s.emit(event, payload);
//       console.log(`Emitted ${event} to socket: ${toSocketId}`);
//     } else {
//       console.log(`Socket not found: ${toSocketId}`);
//     }
//   } catch (err) {
//     console.error("safeEmit error:", err);
//   }
// };

// const getIceServersFromEnv = () => {
//   const isProduction = process.env.NODE_ENV === "production";

//   const servers = [];
//   const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
//     .split(",")
//     .map(s => s.trim())
//     .filter(Boolean);
//   stunUrls.forEach(url => { if (url) servers.push({ urls: url }); });

//   if (isProduction) {
//     const turnUrls = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//     const turnUsername = process.env.TURN_USERNAME;
//     const turnPassword = process.env.TURN_PASSWORD;

//     turnUrls.forEach(url => {
//       if (url && turnUsername && turnPassword) {
//         servers.push({
//           urls: url,
//           username: turnUsername,
//           credential: turnPassword
//         });
//       }
//     });
//   }
//   if (servers.length === 0) {
//     servers.push({ urls: "stun:stun.l.google.com:19302" });
//     servers.push({ urls: "stun:global.stun.twilio.com:3478" });
//   }

//   return servers;
// };

// const createMediasoupWorker = async () => {
//   try {
//     const minPort = parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000;
//     const maxPort = parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999;
//     const logLevel = process.env.MEDIASOUP_LOG_LEVEL || "warn";

//     mediasoupWorker = await mediasoup.createWorker({
//       logLevel,
//       rtcMinPort: minPort,
//       rtcMaxPort: maxPort,
//     });

//     console.log(`Mediasoup Worker Created (Ports: ${minPort}-${maxPort}) for ${process.env.NODE_ENV} environment`);

//     mediasoupWorker.on("died", () => {
//       console.error("Mediasoup worker died, restarting in 2 seconds...");
//       setTimeout(() => createMediasoupWorker().catch(console.error), 2000);
//     });

//     return mediasoupWorker;
//   } catch (error) {
//     console.error("Failed to create Mediasoup worker:", error);
//     throw error;
//   }
// };

// const flushCanvasOps = async (sessionId) => {
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
  
//   if (state.flushTimer) {
//     clearTimeout(state.flushTimer);
//     state.flushTimer = null;
//   }

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
// };

// const scheduleFlush = (sessionId, op) => {
//   console.log(`Scheduling flush for session: ${sessionId}, operation type: ${op?.type}`);
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
  
//   state.flushTimer = setTimeout(() => {
//     flushCanvasOps(sessionId).catch(err => {
//       console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
//     });
//   }, 2000);
  
//   console.log(`Flush scheduled for session: ${sessionId}`);
// };

// export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
//   console.log(`Initializing whiteboard RTC for session: ${sessionId}, whiteboard: ${whiteboardId}, createdBy: ${createdBy}`);
  
//   if (!roomState.has(sessionId)) {
//     roomState.set(sessionId, {
//       whiteboardId,
//       createdBy,
//       streamerSocketId: null,
//       viewers: new Set(),
//       sockets: new Map(),
//       participants: new Map(),
//       pendingScreenShareRequests: new Map(),
//       activeScreenShares: new Map(),
//       pendingOps: [],
//       flushTimer: null,
//       router: null,
//       transports: new Map(),
//       producers: new Map(),
//       consumers: new Map(),
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

// // ======= Producer Control Functions =======
// const pauseAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Pausing all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.pause();
//         console.log(`Producer ${producerId} paused`);
//         safeEmit(socketId, "producer-paused", { producerId });
//       } catch (error) {
//         console.error("Error pausing producer:", error);
//       }
//     }
//   }
// };

// const resumeAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Resuming all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.resume();
//         console.log(`Producer ${producerId} resumed`);
//         safeEmit(socketId, "producer-resumed", { producerId });
//       } catch (error) {
//         console.error("Error resuming producer:", error);
//       }
//     }
//   }
// };

// const producerPauseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-pause for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.pause();
//       socket.emit("producer-paused", { producerId });
//       console.log(`Producer ${producerId} paused`);
//     }
//   } catch (error) {
//     console.error("producer-pause error:", error);
//   }
// };

// const producerResumeHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-resume for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.resume();
//       socket.emit("producer-resumed", { producerId });
//       console.log(`Producer ${producerId} resumed`);
//     }
//   } catch (error) {
//     console.error("producer-resume error:", error);
//   }
// };

// const producerCloseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-close for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer) {
//       producer.close();
//       state.producers.delete(producerId);
//       console.log(`Producer ${producerId} closed and removed`);
//       socket.emit("producer-closed", { producerId });
//     }
//   } catch (error) {
//     console.error("producer-close error:", error);
//   }
// };

// // ======= Screen Share Functions =======
// const handleScreenShareRequest = async (socket, sessionId) => {
//   try {
//     console.log("Screen share request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     if (state.activeScreenShares.has(meta.userId)) {
//       socket.emit("screen-share-error", { message: "You already have an active screen share" });
//       return;
//     }

//     const user = await authenticationModel.findById(meta.userId).select("name");
    
//     state.pendingScreenShareRequests.set(meta.userId, {
//       userId: meta.userId,
//       socketId: socket.id,
//       userName: user?.name || "Viewer",
//       requestedAt: new Date()
//     });

//     safeEmit(state.streamerSocketId, "screen-share-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: user?.name || "Viewer"
//     });
//     console.log("📩 Screen-share request received from:", meta.userId, "session:", sessionId);


//     socket.emit("screen-share-request-sent");
//   } catch (error) {
//     console.error("Screen share request error:", error);
//     socket.emit("screen-share-error", { message: "Failed to send screen share request" });
//   }
// };

// const handleScreenShareResponse = async (socket, sessionId, requesterIdentifier, allow) => {
//   try {
//     console.log("Screen share response from streamer:", allow, "for:", requesterIdentifier);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find the request by socketId or userId
//     let request;
    
//     // First try to find by socketId (shorter ID)
//     if (requesterIdentifier && requesterIdentifier.length < 24) {
//       for (const [userId, req] of state.pendingScreenShareRequests) {
//         if (req.socketId === requesterIdentifier) {
//           request = req;
//           break;
//         }
//       }
//     } 
//     // If not found, try by userId
//     if (!request) {
//       request = state.pendingScreenShareRequests.get(requesterIdentifier);
//     }

//     if (!request) {
//       console.log("No pending screen share request found for:", requesterIdentifier);
//       return;
//     }

//     state.pendingScreenShareRequests.delete(request.userId);

//     safeEmit(request.socketId, "screen-share-response", {
//       allowed: allow,
//       message: allow ? "You can now share your screen" : "Streamer denied your screen share request"
//     });

//     if (allow) {
//       // Add to active screen shares
//       state.activeScreenShares.set(request.userId, {
//         userId: request.userId,
//         socketId: request.socketId,
//         userName: request.userName,
//         startedAt: new Date()
//       });
      
//       // Update participant status
//       const participant = state.participants.get(request.userId);
//       if (participant) {
//         participant.isScreenSharing = true;
//         io.to(sessionId).emit("participant_updated", {
//           userId: request.userId,
//           updates: { isScreenSharing: true }
//         });
//       }
      
//       // Notify all participants that screen share is starting
//       io.to(sessionId).emit("screen-share-started-by-viewer", {
//         userId: request.userId,
//         userName: request.userName,
//         socketId: request.socketId
//       });
//     }
//   } catch (error) {
//     console.error("Screen share response error:", error);
//   }
// };

// const handleViewerScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return callback({ error: "Unauthorized" });

//     if (!state.activeScreenShares.has(meta.userId)) {
//       return callback({ error: "No screen share permission" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-screen',
//         userId: meta.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
//     if (state.streamerSocketId) {
//       safeEmit(state.streamerSocketId, "new-viewer-screen-producer", {
//         producerId: producer.id,
//         kind: producer.kind,
//         userId: meta.userId,
//         userName: meta.userName || 'Viewer',
//         source: 'viewer-screen'
//       });
//     }

//     // Notify all participants about the new screen share producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen'
//     });

//     callback({ id: producer.id });

//     producer.on("transportclose", () => {
//       console.log("Viewer screen share producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     producer.on("trackended", () => {
//       console.log("Viewer screen share track ended:", producer.id);
//       handleViewerScreenShareStop(socket, sessionId, meta.userId);
//     });

//   } catch (error) {
//     console.error("Viewer screen share start error:", error);
//     callback({ error: error.message });
//   }
// };

// // Handle streamer specifically requesting to consume viewer screen
// const handleStreamerConsumeViewerScreen = async (socket, sessionId, producerId) => {
//   try {
//     console.log("Streamer consuming viewer screen:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return;

//     const producer = state.producers.get(producerId);
//     if (!producer) return;

//     // Create a consumer for the streamer
//     createConsumer(socket, sessionId, producerId, producer.kind);
//   } catch (error) {
//     console.error("Streamer consume viewer screen error:", error);
//   }
// };

// // Add this new handler for screen share audio
// const handleViewerScreenShareAudio = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share audio for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return callback({ error: "Unauthorized" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-screen-audio',
//         userId: meta.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // Notify all participants about the new screen share audio producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen-audio'
//     });

//     callback({ id: producer.id });

//     producer.on("transportclose", () => {
//       console.log("Viewer screen share audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer screen share audio error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerScreenShareStop = async (socket, sessionId, userId = null) => {
//   try {
//     console.log("Viewer screen share stop from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const targetUserId = userId || socket.data?.userId;
//     if (!targetUserId) return;

//     state.activeScreenShares.delete(targetUserId);

//     const participant = state.participants.get(targetUserId);
//     if (participant) {
//       participant.isScreenSharing = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: targetUserId,
//         updates: { isScreenSharing: false }
//       });
//     }

//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.userId === targetUserId && 
//           (producer.appData?.source === 'viewer-screen' || producer.appData?.source === 'viewer-screen-audio')) {
//         try {
//           producer.close();
//           state.producers.delete(producerId);
//           console.log(`Screen share producer ${producerId} closed`);
//         } catch (e) {
//           console.warn("Error closing screen share producer:", e);
//         }
//       }
//     }

//     io.to(sessionId).emit("screen-share-stopped-by-viewer", {
//       userId: targetUserId
//     });

//     console.log(`Screen share stopped for user: ${targetUserId}`);
//   } catch (error) {
//     console.error("Viewer screen share stop error:", error);
//   }
// };

// const handleStreamerStopScreenShare = async (socket, sessionId, targetUserId) => {
//   try {
//     console.log("Streamer stopping screen share for user:", targetUserId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find and close the screen share producer
//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.userId === targetUserId && 
//           (producer.appData?.source === 'viewer-screen' || producer.appData?.source === 'viewer-screen-audio')) {
//         producer.close();
//         state.producers.delete(producerId);
        
//         // Notify the viewer
//         const viewerSocket = state.participants.get(targetUserId)?.socketId;
//         if (viewerSocket) {
//           safeEmit(viewerSocket, "screen-share-force-stop", {
//             message: "Streamer stopped your screen share"
//           });
//         }
        
//         // Notify all participants
//         io.to(sessionId).emit("screen-share-stopped-by-viewer", {
//           userId: targetUserId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Streamer stop screen share error:", error);
//   }
// };

// // ======= Participant Management Functions =======
// const getParticipantsHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getParticipants for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback([]);
    
//     const participants = Array.from(state.participants.values());
//     callback(participants);
//   } catch (error) {
//     console.error("getParticipants error:", error);
//     callback([]);
//   }
// };

// const updateParticipantStatusHandler = async (socket, sessionId, updates) => {
//   try {
//     console.log("updateParticipantStatus for session:", sessionId, "updates:", updates);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       Object.assign(participant, updates);
      
//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates
//       });
//     }
//   } catch (error) {
//     console.error("updateParticipantStatus error:", error);
//   }
// };

// const cleanupSocketFromRoom = async (socket) => {
//   console.log(`Cleanup requested for socket: ${socket.id}`);
//   try {
//     const sid = socket.data?.sessionId;
//     if (!sid) {
//       console.log(`No session ID found for socket: ${socket.id}`);
//       return;
//     }
    
//     const state = roomState.get(sid);
//     if (!state) {
//       console.log(`No state found for session: ${sid}`);
//       return;
//     }

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.log(`No metadata found for socket: ${socket.id}`);
//       return;
//     }

//     if (state.pendingScreenShareRequests.has(meta.userId)) {
//       state.pendingScreenShareRequests.delete(meta.userId);
//     }

//     if (state.activeScreenShares.has(meta.userId)) {
//       await handleViewerScreenShareStop(socket, sid, meta.userId);
//     }

//     // Clean up consumers
//     for (const [consumerId, consumer] of state.consumers) {
//       try {
//         if (consumer?.appData?.socketId === socket.id) {
//           consumer.close();
//           state.consumers.delete(consumerId);
//           console.log(`Consumer ${consumerId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Consumer cleanup error:", e);
//       }
//     }

//     // Clean up transports
//     for (const [transportId, transport] of state.transports) {
//       try {
//         if (transport?.appData?.socketId === socket.id) {
//           transport.close();
//           state.transports.delete(transportId);
//           console.log(`Transport ${transportId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Transport cleanup error:", e);
//       }
//     }

//     // Clean up producers
//     for (const [producerId, producer] of state.producers) {
//       try {
//         if (producer?.appData?.socketId === socket.id) {
//           producer.close();
//           state.producers.delete(producerId);
//           console.log(`Producer ${producerId} closed and removed`);
//         }
//       } catch (e) {
//         console.warn("Producer cleanup error:", e);
//       }
//     }

//     if (meta.userId) {
//       state.participants.delete(meta.userId);
      
//       io.to(sid).emit("participant_left", {
//         userId: meta.userId,
//         socketId: socket.id
//       });
//     }

//     if (state.whiteboardId) {
//       console.log(`Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`);
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb) {
//         const participant = wb.participants.find(p => p.user.toString() === meta.userId);
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//         }
//         await wb.save();
//         console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
//       }
//     }

//     if (meta.role !== ROLE_MAP.STREAMER) {
//       try {
//         const participant = await liveSessionParticipant.findOne({ 
//           $or: [
//             { sessionId: sid, userId: meta.userId },
//             { socketId: socket.id }
//           ]
//         });
        
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//           participant.isActiveDevice = false;
//           await participant.save();
//           console.log(`Participant ${meta.userId} marked as LEFT`);
//         }
//       } catch (e) {
//         console.error("cleanup update error:", e?.message || e);
//       }

//       state.viewers.delete(socket.id);
//       io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
//       console.log(`Viewer ${socket.id} left room ${sid}`);
//     } else {
//       console.log(`Streamer ${socket.id} left room ${sid}`);
      
//       if (state.streamerSocketId === socket.id) {
//         state.streamerSocketId = null;
//         console.log(`Cleared streamerSocketId for session: ${sid}`);
//       }

//       const session = await liveSession.findOne({ sessionId: sid });
//       if (session) {
//         session.status = "PAUSED";
//         await session.save();
//         console.log(`Session ${sid} paused due to streamer leaving`);
//       }

//       io.to(sid).emit("session_paused_or_ended_by_streamer");
//     }

//     state.sockets.delete(socket.id);
//     socket.leave(sid);
//     console.log(`Socket ${socket.id} removed from room state for session: ${sid}`);

//     if (state.sockets.size === 0) {
//       if (state.pendingOps && state.pendingOps.length > 0) {
//         await flushCanvasOps(sid).catch(err => {
//           console.error(`Error flushing canvas ops during cleanup for session ${sid}:`, err);
//         });
//       }

//       if (state.flushTimer) clearTimeout(state.flushTimer);
      
//       if (state.router) {
//         try {
//           state.router.close();
//           console.log(`Mediasoup router closed for session: ${sid}`);
//         } catch (e) {
//           console.warn("Error closing router:", e);
//         }
//         state.router = null;
//       }
      
//       roomState.delete(sid);
//       console.log(`Room state cleaned up for session: ${sid}`);
//     }
//   } catch (e) {
//     console.error("cleanupSocketFromRoom error:", e?.message || e);
//   }
// };

// const handleScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'screen',
//         userId: socket.data.userId 
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Screen share producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     socket.to(sessionId).emit("screen-share-started", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
    
//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
//   } catch (error) {
//     console.error("Screen share start error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerAudioProduce = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer audio produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-mic',
//         userId: socket.data.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // Notify all participants about the new audio producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'viewer-mic'
//     });

//     // ✅ FIX: Now emit audio permission granted WITH real producerId
//     io.to(sessionId).emit("viewer-audio-permission-granted", {
//       userId: socket.data.userId,
//       producerId: producer.id,
//       socketId: socket.id,
//       userName: state.sockets.get(socket.id)?.userName || 'Viewer'
//     });

//     callback({ id: producer.id });

//     const meta = state.sockets.get(socket.id);
//     if (meta) {
//       const participant = state.participants.get(meta.userId);
//       if (participant) {
//         participant.hasAudio = true;
//         io.to(sessionId).emit("participant_updated", {
//           userId: meta.userId,
//           updates: { hasAudio: true }
//         });
//       }
//     }

//     producer.on("transportclose", () => {
//       console.log("Viewer audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer audio produce error:", error);
//     callback({ error: error.message });
//   }
// };


// const handleViewerVideoProduce = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer video produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "video",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-camera',
//         userId: socket.data.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // Notify all participants about the new video producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'viewer-camera'
//     });

//     callback({ id: producer.id });

//     producer.on("transportclose", () => {
//       console.log("Viewer video producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer video produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerAudioRequest = async (socket, sessionId) => {
//   try {
//     console.log("Viewer audio permission request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const user = await authenticationModel.findById(meta.userId).select("name");
    
//     safeEmit(state.streamerSocketId, "viewer-audio-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: user?.name || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer audio request error:", error);
//   }
// };

// const handleViewerVideoRequest = async (socket, sessionId) => {
//   try {
//     console.log("Viewer video permission request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const user = await authenticationModel.findById(meta.userId).select("name");
    
//     safeEmit(state.streamerSocketId, "viewer-video-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: user?.name || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer video request error:", error);
//   }
// };
// const handleViewerAudioResponse = (socket, sessionId, requesterSocketId, allow) => {
//   console.log(`Viewer audio response from streamer: ${allow} for: ${requesterSocketId}`);

//   if (allow) {
//     // Sirf viewer ko response bhejo
//     io.to(requesterSocketId).emit("viewer-audio-response", { allowed: true });
//   } else {
//     io.to(requesterSocketId).emit("viewer-audio-response", { allowed: false });
//   }
// };






// const handleViewerVideoResponse = async (socket, sessionId, requesterIdentifier, allow) => {
//   try {
//     console.log("Viewer video response from streamer:", allow, "for:", requesterIdentifier);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find the viewer's socket
//     let viewerSocketId = requesterIdentifier;
//     let viewerUserId = requesterIdentifier;
    
//     // Handle both socketId and userId input
//     if (requesterIdentifier && requesterIdentifier.length === 24) {
//       // It's a userId, find the socket
//       for (const [sockId, meta] of state.sockets) {
//         if (meta.userId === requesterIdentifier) {
//           viewerSocketId = sockId;
//           viewerUserId = meta.userId;
//           break;
//         }
//       }
//     } else {
//       // It's a socketId, find the userId
//       const meta = state.sockets.get(requesterIdentifier);
//       if (meta) {
//         viewerUserId = meta.userId;
//       }
//     }

//     if (!viewerSocketId) {
//       console.log("Could not find viewer socket for:", requesterIdentifier);
//       return;
//     }

//     // Send response to viewer
//     safeEmit(viewerSocketId, "viewer-video-response", {
//       allowed: allow,
//       message: allow ? "You can now share video" : "Streamer denied your video request"
//     });

//     if (allow) {
//       // Get the video producer for this viewer
//       let videoProducerId = null;
//       for (const [producerId, producer] of state.producers) {
//         if (producer.appData?.userId === viewerUserId && 
//             producer.appData?.source === 'viewer-camera') {
//           videoProducerId = producerId;
//           break;
//         }
//       }

//       // Update participant status for ALL participants
//       const viewerMeta = state.sockets.get(viewerSocketId);
//       if (viewerMeta) {
//         const participant = state.participants.get(viewerMeta.userId);
//         if (participant) {
//           participant.hasVideo = true;
          
//           // Notify ALL participants that this viewer can now share video
//           io.to(sessionId).emit("participant_updated", {
//             userId: viewerMeta.userId,
//             updates: { hasVideo: true }
//           });
          
//           // Notify everyone to consume this viewer's video
//           io.to(sessionId).emit("viewer-video-permission-granted", {
//             userId: viewerMeta.userId,
//             producerId: videoProducerId,
//             socketId: viewerSocketId,
//             userName: viewerMeta.userName || 'Viewer'
//           });
//         }
//       }
//     }
//   } catch (error) {
//     console.error("Viewer video response error:", error);
//   }
// };

// const handleViewerAudioMute = async (socket, sessionId, targetSocketId) => {
//   try {
//     console.log("Muting viewer audio:", targetSocketId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.socketId === targetSocketId && 
//           producer.kind === "audio" && 
//           producer.appData?.source === 'viewer-mic') {
//         await producer.pause();
//         console.log(`Viewer audio producer ${producerId} muted`);
        
//         const viewerMeta = state.sockets.get(targetSocketId);
//         if (viewerMeta) {
//           const participant = state.participants.get(viewerMeta.userId);
//           if (participant) {
//             participant.hasAudio = false;
//             io.to(sessionId).emit("participant_updated", {
//               userId: viewerMeta.userId,
//               updates: { hasAudio: false }
//             });
//           }
//         }
        
//         safeEmit(targetSocketId, "viewer-audio-muted", {
//           producerId: producer.id,
//           mutedBy: socket.data.userId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Viewer audio mute error:", error);
//   }
// };

// const handleViewerVideoMute = async (socket, sessionId, targetSocketId) => {
//   try {
//     console.log("Muting viewer video:", targetSocketId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.socketId === targetSocketId && 
//           producer.kind === "video" && 
//           producer.appData?.source === 'viewer-camera') {
//         await producer.pause();
//         console.log(`Viewer video producer ${producerId} muted`);
        
//         const viewerMeta = state.sockets.get(targetSocketId);
//         if (viewerMeta) {
//           const participant = state.participants.get(viewerMeta.userId);
//           if (participant) {
//             participant.hasVideo = false;
//             io.to(sessionId).emit("participant_updated", {
//               userId: viewerMeta.userId,
//               updates: { hasVideo: false }
//             });
//           }
//         }
        
//         safeEmit(targetSocketId, "viewer-video-muted", {
//           producerId: producer.id,
//           mutedBy: socket.data.userId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Viewer video mute error:", error);
//   }
// };

// const createConsumer = async (socket, sessionId, producerId, kind) => {
//   try {
//     console.log("Creating consumer for producer:", producerId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return;

//     // Create a transport for the consumer if it doesn't exist
//     let consumerTransport;
//     for (const [transportId, transport] of state.transports) {
//       if (transport.appData?.socketId === socket.id && transport.appData?.type === 'consumer') {
//         consumerTransport = transport;
//         break;
//       }
//     }

//     if (!consumerTransport) {
//       consumerTransport = await state.router.createWebRtcTransport({
//         listenIps: [
//           {
//             ip: "0.0.0.0",
//             announcedIp: process.env.SERVER_IP || "127.0.0.1",
//           },
//         ],
//         enableUdp: true,
//         enableTcp: true,
//         preferUdp: true,
//       });

//       consumerTransport.appData = { socketId: socket.id, type: 'consumer' };
//       state.transports.set(consumerTransport.id, consumerTransport);

//       // Send transport parameters to the client
//       socket.emit("new-consumer-transport", {
//         id: consumerTransport.id,
//         iceParameters: consumerTransport.iceParameters,
//         iceCandidates: consumerTransport.iceCandidates,
//         dtlsParameters: consumerTransport.dtlsParameters,
//       });
//     }

//     const producer = state.producers.get(producerId);
//     if (!producer) {
//       console.log("Producer not found for consumer creation:", producerId);
//       return;
//     }

//     const consumer = await consumerTransport.consume({
//       producerId,
//       rtpCapabilities: state.router.rtpCapabilities,
//       paused: false,
//     });

//     state.consumers.set(consumer.id, consumer);

//     // Send consumer parameters to the client
//     socket.emit("consumer-created", {
//       id: consumer.id,
//       producerId,
//       kind: consumer.kind,
//       rtpParameters: consumer.rtpParameters,
//     });

//     consumer.on("transportclose", () => {
//       console.log("Consumer transport closed:", consumer.id);
//       state.consumers.delete(consumer.id);
//     });

//     consumer.on("producerclose", () => {
//       console.log("Producer closed for consumer:", consumer.id);
//       socket.emit("producer-closed", { consumerId: consumer.id });
//       state.consumers.delete(consumer.id);
//     });

//   } catch (error) {
//     console.error("createConsumer error:", error);
//   }
// };

// const joinRoomHandler = async (socket, data) => {
//   const { token, sessionId, roomCode } = data;
//   console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);
  
//   try {
//     if (!token || (!sessionId && !roomCode)) {
//       return socket.emit("error_message", "Missing token or sessionId/roomCode");
//     }

//     let decoded;
//     try {
//       decoded = jwt.verify(token, process.env.SECRET_KEY);
//       console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
//     } catch (err) {
//       return socket.emit("error_message", "Invalid token");
//     }
    
//     const userId = decoded.userId;
//     const userRole = decoded.role;

//     let session;
//     if (sessionId) {
//       session = await liveSession.findOne({ sessionId });
//     } else {
//       session = await liveSession.findOne({ roomCode });
//     }

//     if (!session) return socket.emit("error_message", "Session not found");
//     if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
//       return socket.emit("error_message", `Session is ${session.status}`);
//     }

//     if (session.isPrivate) {
//       const allowed = Array.isArray(session.allowedUsers) && 
//         session.allowedUsers.some(u => u.toString() === userId);
//       if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
//     }

//     const sid = session.sessionId;
//     if (!roomState.has(sid)) {
//       roomState.set(sid, {
//         whiteboardId: session.whiteboardId || null,
//         createdBy: session.streamerId ? session.streamerId.toString() : null,
//         streamerSocketId: null,
//         viewers: new Set(),
//         sockets: new Map(),
//         participants: new Map(),
//         pendingScreenShareRequests: new Map(),
//         activeScreenShares: new Map(),
//         pendingOps: [],
//         flushTimer: null,
//         router: null,
//         transports: new Map(),
//         producers: new Map(),
//         consumers: new Map(),
//       });
//       console.log(`New room state created for session: ${sid}`);
//     }
    
//     const state = roomState.get(sid);

//     const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
//     const activeCount = await liveSessionParticipant.countDocuments({ 
//       sessionId: session._id, 
//       status: { $ne: "LEFT" } 
//     });
    
//     if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
//       return socket.emit("error_message", "Max participants limit reached");
//     }

//     let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
//     if (participant && participant.isBanned) {
//       return socket.emit("error_message", "You are banned from this session");
//     }

//     if (userRole === ROLE_MAP.STREAMER) {
//       if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
//         console.log(`Streamer reconnecting from ${state.streamerSocketId} to ${socket.id}`);
//         if (state.sockets.has(state.streamerSocketId)) {
//           state.sockets.delete(state.streamerSocketId);
//           state.viewers.delete(state.streamerSocketId);
//         }
//       }
//       state.streamerSocketId = socket.id;
//       console.log(`Streamer socket ID updated to: ${socket.id}`);
//     }

//     if (!participant) {
//       participant = await liveSessionParticipant.create({
//         sessionId: session._id,
//         userId,
//         socketId: socket.id,
//         status: "JOINED",
//         isActiveDevice: true,
//         joinedAt: new Date(),
//       });
//       session.totalJoins = (session.totalJoins || 0) + 1;
//       await session.save();
//       console.log(`New participant created, total joins: ${session.totalJoins}`);
//     } else {
//       participant.socketId = socket.id;
//       participant.status = "JOINED";
//       participant.isActiveDevice = true;
//       participant.joinedAt = new Date();
//       participant.leftAt = null;
//       await participant.save();
//     }

//     const user = await authenticationModel.findById(userId).select("name");
    
//     state.participants.set(userId, {
//       userId,
//       socketId: socket.id,
//       name: user?.name || "Unknown",
//       role: userRole,
//       joinedAt: new Date(),
//       isSpeaking: false,
//       hasAudio: false,
//       hasVideo: false,
//       isScreenSharing: false,
//     });

//     if (userRole === ROLE_MAP.STREAMER && !state.router) {
//       console.log("Creating Mediasoup router for session:", sid);
//       const mediaCodecs = [
//         {
//           kind: "audio",
//           mimeType: "audio/opus",
//           clockRate: 48000,
//           channels: 2,
//         },
//         {
//           kind: "video",
//           mimeType: "video/VP8",
//           clockRate: 90000,
//           parameters: {
//             "x-google-start-bitrate": process.env.NODE_ENV === "production" ? 500000 : 1000000,
//           },
//         },
//       ];

//       state.router = await mediasoupWorker.createRouter({ mediaCodecs });
//       console.log("Mediasoup router created for session:", sid);
//     }

//     state.sockets.set(socket.id, { userId, role: userRole, userName: user?.name || "Unknown" });
//     socket.data = { sessionId: sid, userId, role: userRole };
//     socket.join(sid);
//     console.log(`Socket ${socket.id} joined room ${sid}`);

//     const iceServers = getIceServersFromEnv();
//     socket.emit("ice_servers", iceServers);

//     io.to(sid).emit("participant_joined", {
//       userId,
//       name: user?.name || "Unknown",
//       role: userRole,
//       socketId: socket.id,
//       joinedAt: new Date(),
//       isSpeaking: false,
//       hasAudio: false,
//       hasVideo: false,
//       isScreenSharing: false,
//     });

//     const currentParticipants = Array.from(state.participants.values());
//     socket.emit("participants_list", currentParticipants);

//     if (userRole === ROLE_MAP.STREAMER) {
//       socket.emit("joined_room", {
//         as: "STREAMER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys()),
//         pendingScreenShareRequests: Array.from(state.pendingScreenShareRequests.values()),
//         activeScreenShares: Array.from(state.activeScreenShares.values())
//       });
//       console.log(`Streamer ${socket.id} joined room ${sid}`);
//     } else {
//       state.viewers.add(socket.id);
//       socket.emit("joined_room", {
//         as: "VIEWER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         whiteboardId: state.whiteboardId,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys())
//       });
//       console.log(`Viewer ${socket.id} joined room ${sid}`);
      
//       if (state.streamerSocketId) {
//         safeEmit(state.streamerSocketId, "viewer_ready", { 
//           viewerSocketId: socket.id, 
//           viewerUserId: userId 
//         });
//       }
//     }

//     if (state.whiteboardId) {
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
//         wb.participants.push({ 
//           user: userId, 
//           role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", 
//           joinedAt: new Date() 
//         });
//         await wb.save();
//         console.log(`User added to whiteboard: ${state.whiteboardId}`);
//       }
//     }

//     const currentParticipantsCount = state.viewers.size + (state.streamerSocketId ? 1 : 0);
//     if ((session.peakParticipants || 0) < currentParticipantsCount) {
//       session.peakParticipants = currentParticipantsCount;
//       await session.save();
//       console.log(`New peak participants: ${currentParticipantsCount}`);
//     }
//   } catch (err) {
//     console.error("join_room error:", err);
//     socket.emit("error_message", "Invalid token/session");
//     throw err;
//   }
// };

// const chatHandler = async (socket, sessionId, message) => {
//   console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}`);
  
//   try {
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const sender = await authenticationModel.findById(meta.userId).select("name");
    
//     io.to(sessionId).emit("chat_message", {
//       userId: meta.userId,
//       name: sender?.name || "Unknown",
//       message,
//       socketId: socket.id,
//       at: new Date(),
//     });
    
//     console.log(`Chat message broadcast to session: ${sessionId}`);
//   } catch (err) {
//     console.error("chat_message error:", err);
//     throw err;
//   }
// };

// const streamerControlHandler = async (socket, data) => {
//   const { sessionId, status, emitEvent } = data;
//   console.log(`Streamer control request for session: ${sessionId}, status: ${status}`);
  
//   try {
//     const session = await liveSession.findOne({ sessionId });
//     if (!session) return;

//     if (status === "PAUSED") {
//       await pauseAllProducers(sessionId, socket.id);
//     } else if (status === "ACTIVE") {
//       await resumeAllProducers(sessionId, socket.id);
//     }

//     session.status = status;
//     if (status === "ACTIVE" && emitEvent === "streamer_started") {
//       session.actualStartTime = new Date();
//     }

//     await session.save();
//     io.to(sessionId).emit(emitEvent, { sessionId });
//     console.log(`Session ${sessionId} ${status.toLowerCase()} by streamer`);
//   } catch (err) {
//     console.error("streamer_control error:", err);
//     throw err;
//   }
// };

// const getRouterRtpCapabilitiesHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getRouterRtpCapabilities for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });
//     callback({ rtpCapabilities: state.router.rtpCapabilities });
//   } catch (error) {
//     console.error("getRouterRtpCapabilities error:", error);
//     callback({ error: error.message });
//   }
// };

// const createWebRtcTransportHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("createWebRtcTransport for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });

//     const transport = await state.router.createWebRtcTransport({
//       listenIps: [
//         {
//           ip: "0.0.0.0",
//           announcedIp: process.env.SERVER_IP || "127.0.0.1",
//         },
//       ],
//       enableUdp: true,
//       enableTcp: true,
//       preferUdp: true,
//       initialAvailableOutgoingBitrate: process.env.NODE_ENV === "production" ? 500000 : 1000000,
//     });

//     transport.on("dtlsstatechange", (dtlsState) => {
//       if (dtlsState === "closed") transport.close();
//     });

//     transport.appData = { socketId: socket.id };
//     state.transports.set(transport.id, transport);

//     callback({
//       params: {
//         id: transport.id,
//         iceParameters: transport.iceParameters,
//         iceCandidates: transport.iceCandidates,
//         dtlsParameters: transport.dtlsParameters,
//       },
//     });
//   } catch (error) {
//     console.error("createWebRtcTransport error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportConnectHandler = async (socket, sessionId, transportId, dtlsParameters, callback) => {
//   try {
//     console.log("transport-connect for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     await transport.connect({ dtlsParameters });
//     callback({ success: true });
//   } catch (error) {
//     console.error("transport-connect error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportProduceHandler = async (socket, sessionId, transportId, kind, rtpParameters, appData, callback) => {
//   try {
//     console.log("transport-produce for transport:", transportId, "kind:", kind, "source:", appData?.source);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: appData?.source || 'camera',
//         userId: socket.data.userId 
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("transport-produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumeHandler = async (socket, sessionId, transportId, producerId, rtpCapabilities, callback) => {
//   try {
//     console.log("consume for producer:", producerId, "transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) {
//       console.log("❌ Router not found for session:", sessionId);
//       return callback({ error: "Router not found" });
//     }

//     const producer = state.producers.get(producerId);
//     if (!producer) {
//       console.log("❌ Producer not found:", producerId);
//       return callback({ error: "Producer not found" });
//     }

//     if (!state.router.canConsume({ producerId, rtpCapabilities })) {
//       console.log("❌ Cannot consume - router.canConsume returned false");
//       return callback({ error: "Cannot consume" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) {
//       console.log("❌ Transport not found:", transportId);
//       return callback({ error: "Transport not found" });
//     }

//     const consumer = await transport.consume({
//       producerId,
//       rtpCapabilities,
//       paused: true,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//       },
//     });

//     state.consumers.set(consumer.id, consumer);
//     console.log("✅ Consumer created:", consumer.id);

//     callback({
//       params: {
//         id: consumer.id,
//         producerId,
//         kind: consumer.kind,
//         rtpParameters: consumer.rtpParameters,
//       },
//     });
//   } catch (error) {
//     console.error("consume error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumerResumeHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-resume for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     await consumer.resume();
//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-resume error:", error);
//     callback({ error: error.message });
//   }
// };

// const getProducersHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getProducers for session:", sessionId);
//     const state = roomState.get(sessionId);
//     callback(state ? Array.from(state.producers.keys()) : []);
//   } catch (error) {
//     console.error("getProducers error:", error);
//     callback([]);
//   }
// };
// const getProducerInfoHandler = async (socket, sessionId, producerId, callback) => {
//   try {
//     console.log("getProducerInfo for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback(null);

//     const producer = state.producers.get(producerId);
//     if (!producer) return callback(null);

//     callback({
//       id: producer.id,
//       kind: producer.kind,
//       userId:  producer.appData?.userId,
//       socketId: producer.appData?.socketId,
//       source: producer.appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("getProducerInfo error:", error);
//     callback(null);
//   }
// };

// const consumerReadyHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-ready for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-ready error:", error);
//     callback({ error: error.message });
//   }
// };

// const offerHandler = (socket, sessionId, targetSocketId, sdp) => {
//   console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || state.streamerSocketId !== socket.id) return;
//   safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
// };

// const answerHandler = (socket, sessionId, sdp) => {
//   console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta || meta.role === ROLE_MAP.STREAMER) return;

//   safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
// };

// const iceCandidateHandler = (socket, sessionId, targetSocketId, candidate) => {
//   console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;
//   safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
// };

// const whiteboardEventHandler = (socket, sessionId, type, data, patch) => {
//   console.log(`Whiteboard ${type} from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit(`whiteboard_${type}`, { 
//     userId: meta.userId, 
//     [`${type}Data`]: data 
//   });
  
//   scheduleFlush(sessionId, { type, payload: data, patch, at: new Date() });
// };

// const whiteboardUndoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const undoStack = wb.undoStack || [];
//   if (undoStack.length === 0) return;

//   const last = undoStack.pop();
//   wb.undoStack = undoStack.slice(-500);
//   wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_undo_applied", { last });
//   console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardRedoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const redoStack = wb.redoStack || [];
//   if (redoStack.length === 0) return;

//   const last = redoStack.pop();
//   wb.redoStack = redoStack.slice(-500);
//   wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_redo_applied", { last });
//   console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardSaveCanvasHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
//   await flushCanvasOps(sessionId).catch(err => {
//     console.error(`Error saving canvas for session ${sessionId}:`, err);
//   });
//   socket.emit("whiteboard_saved");
//   console.log(`Whiteboard saved for session: ${sessionId}`);
// };

// const cursorUpdateHandler = (socket, sessionId, position) => {
//   console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
// };

// const whiteboardStateRequestHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   socket.emit("whiteboard_state_sync", {
//     canvasData: wb.canvasData,
//     participants: wb.participants,
//     versionHistory: wb.versionHistory,
//   });
  
//   console.log(`Whiteboard state sent to socket: ${socket.id}`);
// };

// export const setupIntegratedSocket = async (server) => {
//   console.log("Setting up integrated socket");

//   try {
//     mediasoupWorker = await createMediasoupWorker();
//   } catch (error) {
//     console.error("Failed to initialize Mediasoup:", error);
//     throw error;
//   }

//   const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5174";
//   io = new Server(server, {
//     cors: {
//       origin: corsOrigin,
//       methods: ["GET", "POST"],
//       credentials: true,
//     },
//   });

//   console.log(`Socket.io configured with CORS origin: ${corsOrigin} for ${process.env.NODE_ENV} environment`);

//   io.on("connection", (socket) => {
//     console.log("New client connected:", socket.id);

//     // ====== NEW EVENT HANDLERS ADDED ======
//     // These events will forward messages to all clients in the room
//     socket.on("new-producer", (data) => {
//       console.log("New producer event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("new-producer", data);
//     });
    
//     socket.on("viewer-audio-enabled", (data) => {
//       console.log("Viewer audio enabled event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("viewer-audio-enabled", data);
//     });
    
//     socket.on("screen-share-started-by-viewer", (data) => {
//       console.log("Screen share started by viewer event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("screen-share-started-by-viewer", data);
//     });

//     // NEW: Handle streamer consuming viewer screen
//     socket.on("streamer-consume-viewer-screen", (data) => 
//       handleStreamerConsumeViewerScreen(socket, data.sessionId, data.producerId)
//     );
//     // ====== END OF NEW EVENT HANDLERS ======

//     // ====== PERMISSION AND MEDIA EVENT HANDLERS ======
//    // yeh tumhara existing call hai
// socket.on("viewer-audio-response", (data) => {
//   handleViewerAudioResponse(
//     socket,
//     data.sessionId,
//     data.requesterSocketId,
//     data.allow
//   );
// });

    
//     socket.on("viewer-video-response", (data) => 
//       handleViewerVideoResponse(socket, data.sessionId, data.requesterSocketId, data.allow)
//     );
    
//     socket.on("screen-share-response", (data) => 
//       handleScreenShareResponse(socket, data.sessionId, data.requesterUserId, data.allow)
//     );
    
//     socket.on("screen-share-force-stop", (data) => 
//       handleStreamerStopScreenShare(socket, data.sessionId, data.targetUserId)
//     );
    
//     socket.on("viewer-audio-muted", (data) => 
//       handleViewerAudioMuted(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-video-muted", (data) => 
//       handleViewerVideoMuted(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-audio-started", (data) => 
//       handleViewerAudioStarted(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-video-started", (data) => 
//       handleViewerVideoStarted(socket, data.sessionId, data)
//     );
    
//     socket.on("screen-share-started-by-viewer", (data) => 
//       handleScreenShareStartedByViewer(socket, data.sessionId, data)
//     );
    
//     socket.on("screen-share-stopped-by-viewer", (data) => 
//       handleViewerScreenShareStop(socket, data.sessionId, data.userId)
//     );
    
//     socket.on("viewer-audio-enabled", (data) => 
//       handleViewerAudioEnabled(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-video-enabled", (data) => 
//       handleViewerVideoEnabled(socket, data.sessionId, data)
//     );

//     // Room and chat events
//     socket.on("join_room", (data) => joinRoomHandler(socket, data));
//     socket.on("chat_message", (data) => chatHandler(socket, data.sessionId, data.message));
//     socket.on("streamer_control", (data) => streamerControlHandler(socket, data));
    
//     // Participant management events
//     socket.on("get_participants", (data, cb) => 
//       getParticipantsHandler(socket, data.sessionId, cb)
//     );
    
//     socket.on("update_participant_status", (data) => 
//       updateParticipantStatusHandler(socket, data.sessionId, data.updates)
//     );
    
//     // Screen share events
//     socket.on("screen-share-request", (data) => 
//       handleScreenShareRequest(socket, data.sessionId)
//     );
    
//     // Producer control events
//     socket.on("producer-pause", (data) => 
//       producerPauseHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-resume", (data) => 
//       producerResumeHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-close", (data) => 
//       producerCloseHandler(socket, data.sessionId, data.producerId)
//     );
    
//     // Mediasoup events
//     socket.on("getRouterRtpCapabilities", (data, cb) => 
//       getRouterRtpCapabilitiesHandler(socket, data.sessionId, cb));
    
//     socket.on("createWebRtcTransport", (data, cb) => 
//       createWebRtcTransportHandler(socket, data.sessionId, cb));
    
//     socket.on("transport-connect", (data, cb) =>
//       transportConnectHandler(socket, data.sessionId, data.transportId, data.dtlsParameters, cb)
//     );
    
//     socket.on("transport-produce", (data, cb) =>
//       transportProduceHandler(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, data.appData, cb)
//     );
    
//     // Screen share specific event (for streamer)
//     socket.on("transport-produce-screen", (data, cb) =>
//       handleScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//     );

//     // Viewer audio events
//     socket.on("viewer-audio-request", (data) => 
//       handleViewerAudioRequest(socket, data.sessionId)
//     );

//     socket.on("viewer-video-request", (data) => 
//       handleViewerVideoRequest(socket, data.sessionId)
//     );

//     socket.on("transport-produce-viewer-audio", (data, cb) =>
//       handleViewerAudioProduce(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     socket.on("transport-produce-viewer-video", (data, cb) =>
//       handleViewerVideoProduce(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     // Add this to your socket event handlers
//     socket.on("transport-produce-viewer-screen-audio", (data, cb) =>
//       handleViewerScreenShareAudio(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     socket.on("viewer-audio-mute", (data) => 
//       handleViewerAudioMute(socket, data.sessionId, data.targetSocketId)
//     );
    
//     socket.on("viewer-video-mute", (data) => 
//       handleViewerVideoMute(socket, data.sessionId, data.targetSocketId)
//     );
    
//     // Viewer screen share events
//     socket.on("transport-produce-viewer-screen", (data, cb) =>
//       handleViewerScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//     );

//     socket.on("screen-share-stop", (data) => 
//       handleViewerScreenShareStop(socket, data.sessionId)
//     );
        
//     socket.on("consume", (data, cb) =>
//       consumeHandler(socket, data.sessionId, data.transportId, data.producerId, data.rtpCapabilities, cb)
//     );
    
//     socket.on("consumer-resume", (data, cb) =>
//       consumerResumeHandler(socket, data.sessionId, data.consumerId, cb)
//     );
    
//     socket.on("getProducers", (data, cb) =>
//       getProducersHandler(socket, data.sessionId, cb)
//     );
    
//     socket.on("getProducerInfo", (data, cb) =>
//       getProducerInfoHandler(socket, data.sessionId, data.producerId, cb)
//     );
    
//     socket.on("consumer-ready", (data, cb) =>
//       consumerReadyHandler(socket, data.sessionId, data.consumerId, cb)
//     );

//     // Whiteboard events
//     socket.on("whiteboard_draw", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "draw", data.drawData, data.patch)
//     );
    
//     socket.on("whiteboard_erase", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "erase", data.eraseData, data.patch)
//     );
    
//     socket.on("whiteboard_undo", (data) => 
//       whiteboardUndoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_redo", (data) => 
//       whiteboardRedoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_save", (data) => 
//       whiteboardSaveCanvasHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_cursor", (data) => 
//       cursorUpdateHandler(socket, data.sessionId, data.position)
//     );
    
//     socket.on("whiteboard_state_request", (data) => 
//       whiteboardStateRequestHandler(socket, data.sessionId)
//     );

//     // WebRTC events
//     socket.on("offer", (data) => 
//       offerHandler(socket, data.sessionId, data.targetSocketId, data.sdp)
//     );
    
//     socket.on("answer", (data) => 
//       answerHandler(socket, data.sessionId, data.sdp)
//     );
    
//     socket.on("ice-candidate", (data) => 
//       iceCandidateHandler(socket, data.sessionId, data.targetSocketId, data.candidate)
//     );

//     socket.on("disconnect", () => cleanupSocketFromRoom(socket));
//   });

//   console.log("✅ Socket.io setup complete with screen share permission system");
//   return io;
// };

// // ====== MISSING HANDLER IMPLEMENTATIONS ======

// const handleViewerAudioMuted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio muted:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasAudio: false }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-audio-muted-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer audio muted error:", error);
//   }
// };

// const handleViewerVideoMuted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer video muted:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasVideo = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasVideo: false }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-video-muted-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer video muted error:", error);
//   }
// };

// const handleViewerAudioStarted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio started:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = true;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasAudio: true }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-audio-started-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer",
//       socketId: socket.id
//     });
//   } catch (error) {
//     console.error("Viewer audio started error:", error);
//   }
// };

// const handleViewerVideoStarted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer video started:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasVideo = true;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasVideo: true }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-video-started-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer",
//       socketId: socket.id
//     });
//   } catch (error) {
//     console.error("Viewer video started error:", error);
//   }
// };

// const handleScreenShareStartedByViewer = async (socket, sessionId, data) => {
//   try {
//     console.log("Screen share started by viewer:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.isScreenSharing = true;
//       // Forward to all other participants in the room
//       socket.to(sessionId).emit("screen-share-started-by-viewer", data);
//     }
//   } catch (error) {
//     console.error("Screen share started by viewer error:", error);
//   }
// };

// const handleViewerAudioEnabled = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio enabled:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = true;
//       // Forward to all other participants in the room
//       socket.to(sessionId).emit("viewer-audio-enabled", data);
//     }
//   } catch (error) {
//     console.error("Viewer audio enabled error:", error);
//   }
// };

// const handleViewerVideoEnabled = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer video enabled:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasVideo = true;
//       // Forward to all other participants in the room
//       socket.to(sessionId).emit("viewer-video-enabled", data);
//     }
//   } catch (error) {
//     console.error("Viewer video enabled error:", error);
//   }
// };

// // Export functions as named exports
// export { getIO };





























// import { Server } from "socket.io";
// import jwt from "jsonwebtoken";
// import mediasoup from "mediasoup";
// import liveSession from "../model/liveSessions/liveeSession.model.js";
// import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
// import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
// import { ROLE_MAP } from "../constant/role.js";
// import authenticationModel from "../../app/model/Authentication/authentication.model.js";

// // ======= Global Variables =======
// let io;
// let mediasoupWorker;
// const roomState = new Map();

// // ======= Utility Functions =======
// const getIO = () => {
//   if (!io) throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
//   return io;
// };

// const safeEmit = (toSocketId, event, payload) => {
//   try {
//     const s = io.sockets.sockets.get(toSocketId);
//     if (s) {
//       s.emit(event, payload);
//       console.log(`Emitted ${event} to socket: ${toSocketId}`);
//     } else {
//       console.log(`Socket not found: ${toSocketId}`);
//     }
//   } catch (err) {
//     console.error("safeEmit error:", err);
//   }
// };

// const getIceServersFromEnv = () => {
//   const isProduction = process.env.NODE_ENV === "production";

//   const servers = [];
//   const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
//     .split(",")
//     .map(s => s.trim())
//     .filter(Boolean);
//   stunUrls.forEach(url => { if (url) servers.push({ urls: url }); });

//   if (isProduction) {
//     const turnUrls = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//     const turnUsername = process.env.TURN_USERNAME;
//     const turnPassword = process.env.TURN_PASSWORD;

//     turnUrls.forEach(url => {
//       if (url && turnUsername && turnPassword) {
//         servers.push({
//           urls: url,
//           username: turnUsername,
//           credential: turnPassword
//         });
//       }
//     });
//   }
//   if (servers.length === 0) {
//     servers.push({ urls: "stun:stun.l.google.com:19302" });
//     servers.push({ urls: "stun:global.stun.twilio.com:3478" });
//   }

//   return servers;
// };

// const createMediasoupWorker = async () => {
//   try {
//     const minPort = parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000;
//     const maxPort = parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999;
//     const logLevel = process.env.MEDIASOUP_LOG_LEVEL || "warn";

//     mediasoupWorker = await mediasoup.createWorker({
//       logLevel,
//       rtcMinPort: minPort,
//       rtcMaxPort: maxPort,
//     });

//     console.log(`Mediasoup Worker Created (Ports: ${minPort}-${maxPort}) for ${process.env.NODE_ENV} environment`);

//     mediasoupWorker.on("died", () => {
//       console.error("Mediasoup worker died, restarting in 2 seconds...");
//       setTimeout(() => createMediasoupWorker().catch(console.error), 2000);
//     });

//     return mediasoupWorker;
//   } catch (error) {
//     console.error("Failed to create Mediasoup worker:", error);
//     throw error;
//   }
// };

// const flushCanvasOps = async (sessionId) => {
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
  
//   if (state.flushTimer) {
//     clearTimeout(state.flushTimer);
//     state.flushTimer = null;
//   }

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
// };

// const scheduleFlush = (sessionId, op) => {
//   console.log(`Scheduling flush for session: ${sessionId}, operation type: ${op?.type}`);
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
  
//   state.flushTimer = setTimeout(() => {
//     flushCanvasOps(sessionId).catch(err => {
//       console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
//     });
//   }, 2000);
  
//   console.log(`Flush scheduled for session: ${sessionId}`);
// };

// export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
//   console.log(`Initializing whiteboard RTC for session: ${sessionId}, whiteboard: ${whiteboardId}, createdBy: ${createdBy}`);
  
//   if (!roomState.has(sessionId)) {
//     roomState.set(sessionId, {
//       whiteboardId,
//       createdBy,
//       streamerSocketId: null,
//       viewers: new Set(),
//       sockets: new Map(),
//       participants: new Map(),
//       pendingScreenShareRequests: new Map(),
//       activeScreenShares: new Map(),
//       pendingOps: [],
//       flushTimer: null,
//       router: null,
//       transports: new Map(),
//       producers: new Map(),
//       consumers: new Map(),
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

// // ======= Producer Control Functions =======
// const pauseAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Pausing all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.pause();
//         console.log(`Producer ${producerId} paused`);
//         safeEmit(socketId, "producer-paused", { producerId });
//       } catch (error) {
//         console.error("Error pausing producer:", error);
//       }
//     }
//   }
// };

// const resumeAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Resuming all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.resume();
//         console.log(`Producer ${producerId} resumed`);
//         safeEmit(socketId, "producer-resumed", { producerId });
//       } catch (error) {
//         console.error("Error resuming producer:", error);
//       }
//     }
//   }
// };

// const producerPauseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-pause for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.pause();
//       socket.emit("producer-paused", { producerId });
//       console.log(`Producer ${producerId} paused`);
//     }
//   } catch (error) {
//     console.error("producer-pause error:", error);
//   }
// };

// const producerResumeHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-resume for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.resume();
//       socket.emit("producer-resumed", { producerId });
//       console.log(`Producer ${producerId} resumed`);
//     }
//   } catch (error) {
//     console.error("producer-resume error:", error);
//   }
// };

// const producerCloseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-close for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer) {
//       producer.close();
//       state.producers.delete(producerId);
//       console.log(`Producer ${producerId} closed and removed`);
//       socket.emit("producer-closed", { producerId });
//     }
//   } catch (error) {
//     console.error("producer-close error:", error);
//   }
// };

// // ======= Screen Share Functions =======
// const handleScreenShareRequest = async (socket, sessionId) => {
//   try {
//     console.log("Screen share request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     if (state.activeScreenShares.has(meta.userId)) {
//       socket.emit("screen-share-error", { message: "You already have an active screen share" });
//       return;
//     }

//     const user = await authenticationModel.findById(meta.userId).select("name");
    
//     state.pendingScreenShareRequests.set(meta.userId, {
//       userId: meta.userId,
//       socketId: socket.id,
//       userName: user?.name || "Viewer",
//       requestedAt: new Date()
//     });

//     safeEmit(state.streamerSocketId, "screen-share-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: user?.name || "Viewer"
//     });
//     console.log("📩 Screen-share request received from:", meta.userId, "session:", sessionId);


//     socket.emit("screen-share-request-sent");
//   } catch (error) {
//     console.error("Screen share request error:", error);
//     socket.emit("screen-share-error", { message: "Failed to send screen share request" });
//   }
// };

// const handleScreenShareResponse = async (socket, sessionId, requesterIdentifier, allow) => {
//   try {
//     console.log("Screen share response from streamer:", allow, "for:", requesterIdentifier);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find the request by socketId or userId
//     let request;
    
//     // First try to find by socketId (shorter ID)
//     if (requesterIdentifier && requesterIdentifier.length < 24) {
//       for (const [userId, req] of state.pendingScreenShareRequests) {
//         if (req.socketId === requesterIdentifier) {
//           request = req;
//           break;
//         }
//       }
//     } 
//     // If not found, try by userId
//     if (!request) {
//       request = state.pendingScreenShareRequests.get(requesterIdentifier);
//     }

//     if (!request) {
//       console.log("No pending screen share request found for:", requesterIdentifier);
//       return;
//     }

//     state.pendingScreenShareRequests.delete(request.userId);

//     safeEmit(request.socketId, "screen-share-response", {
//       allowed: allow,
//       message: allow ? "You can now share your screen" : "Streamer denied your screen share request"
//     });

//     if (allow) {
//       // Add to active screen shares
//       state.activeScreenShares.set(request.userId, {
//         userId: request.userId,
//         socketId: request.socketId,
//         userName: request.userName,
//         startedAt: new Date()
//       });
      
//       // Update participant status
//       const participant = state.participants.get(request.userId);
//       if (participant) {
//         participant.isScreenSharing = true;
//         io.to(sessionId).emit("participant_updated", {
//           userId: request.userId,
//           updates: { isScreenSharing: true }
//         });
//       }
      
//       // Notify all participants that screen share is starting
//       io.to(sessionId).emit("screen-share-started-by-viewer", {
//         userId: request.userId,
//         userName: request.userName,
//         socketId: request.socketId
//       });
//     }
//   } catch (error) {
//     console.error("Screen share response error:", error);
//   }
// };

// const handleViewerScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return callback({ error: "Unauthorized" });

//     if (!state.activeScreenShares.has(meta.userId)) {
//       return callback({ error: "No screen share permission" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-screen',
//         userId: meta.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
//     if (state.streamerSocketId) {
//       safeEmit(state.streamerSocketId, "new-viewer-screen-producer", {
//         producerId: producer.id,
//         kind: producer.kind,
//         userId: meta.userId,
//         userName: meta.userName || 'Viewer',
//         source: 'viewer-screen'
//       });
//     }

//     // Notify all participants about the new screen share producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen'
//     });

//     callback({ id: producer.id });

//     producer.on("transportclose", () => {
//       console.log("Viewer screen share producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     producer.on("trackended", () => {
//       console.log("Viewer screen share track ended:", producer.id);
//       handleViewerScreenShareStop(socket, sessionId, meta.userId);
//     });

//   } catch (error) {
//     console.error("Viewer screen share start error:", error);
//     callback({ error: error.message });
//   }
// };

// // Handle streamer specifically requesting to consume viewer screen
// const handleStreamerConsumeViewerScreen = async (socket, sessionId, producerId) => {
//   try {
//     console.log("Streamer consuming viewer screen:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return;

//     const producer = state.producers.get(producerId);
//     if (!producer) return;

//     // Create a consumer for the streamer
//     createConsumer(socket, sessionId, producerId, producer.kind);
//   } catch (error) {
//     console.error("Streamer consume viewer screen error:", error);
//   }
// };

// // Add this new handler for screen share audio
// const handleViewerScreenShareAudio = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share audio for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return callback({ error: "Unauthorized" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-screen-audio',
//         userId: meta.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // Notify all participants about the new screen share audio producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen-audio'
//     });

//     callback({ id: producer.id });

//     producer.on("transportclose", () => {
//       console.log("Viewer screen share audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer screen share audio error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerScreenShareStop = async (socket, sessionId, userId = null) => {
//   try {
//     console.log("Viewer screen share stop from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const targetUserId = userId || socket.data?.userId;
//     if (!targetUserId) return;

//     state.activeScreenShares.delete(targetUserId);

//     const participant = state.participants.get(targetUserId);
//     if (participant) {
//       participant.isScreenSharing = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: targetUserId,
//         updates: { isScreenSharing: false }
//       });
//     }

//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.userId === targetUserId && 
//           (producer.appData?.source === 'viewer-screen' || producer.appData?.source === 'viewer-screen-audio')) {
//         try {
//           producer.close();
//           state.producers.delete(producerId);
//           console.log(`Screen share producer ${producerId} closed`);
//         } catch (e) {
//           console.warn("Error closing screen share producer:", e);
//         }
//       }
//     }

//     io.to(sessionId).emit("screen-share-stopped-by-viewer", {
//       userId: targetUserId
//     });

//     console.log(`Screen share stopped for user: ${targetUserId}`);
//   } catch (error) {
//     console.error("Viewer screen share stop error:", error);
//   }
// };

// const handleStreamerStopScreenShare = async (socket, sessionId, targetUserId) => {
//   try {
//     console.log("Streamer stopping screen share for user:", targetUserId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find and close the screen share producer
//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.userId === targetUserId && 
//           (producer.appData?.source === 'viewer-screen' || producer.appData?.source === 'viewer-screen-audio')) {
//         producer.close();
//         state.producers.delete(producerId);
        
//         // Notify the viewer
//         const viewerSocket = state.participants.get(targetUserId)?.socketId;
//         if (viewerSocket) {
//           safeEmit(viewerSocket, "screen-share-force-stop", {
//             message: "Streamer stopped your screen share"
//           });
//         }
        
//         // Notify all participants
//         io.to(sessionId).emit("screen-share-stopped-by-viewer", {
//           userId: targetUserId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Streamer stop screen share error:", error);
//   }
// };

// // ======= Participant Management Functions =======
// const getParticipantsHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getParticipants for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback([]);
    
//     const participants = Array.from(state.participants.values());
//     callback(participants);
//   } catch (error) {
//     console.error("getParticipants error:", error);
//     callback([]);
//   }
// };

// const updateParticipantStatusHandler = async (socket, sessionId, updates) => {
//   try {
//     console.log("updateParticipantStatus for session:", sessionId, "updates:", updates);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       Object.assign(participant, updates);
      
//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates
//       });
//     }
//   } catch (error) {
//     console.error("updateParticipantStatus error:", error);
//   }
// };

// const cleanupSocketFromRoom = async (socket) => {
//   console.log(`Cleanup requested for socket: ${socket.id}`);
//   try {
//     const sid = socket.data?.sessionId;
//     if (!sid) {
//       console.log(`No session ID found for socket: ${socket.id}`);
//       return;
//     }
    
//     const state = roomState.get(sid);
//     if (!state) {
//       console.log(`No state found for session: ${sid}`);
//       return;
//     }

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.log(`No metadata found for socket: ${socket.id}`);
//       return;
//     }

//     if (state.pendingScreenShareRequests.has(meta.userId)) {
//       state.pendingScreenShareRequests.delete(meta.userId);
//     }

//     if (state.activeScreenShares.has(meta.userId)) {
//       await handleViewerScreenShareStop(socket, sid, meta.userId);
//     }

//     // Clean up consumers
//     for (const [consumerId, consumer] of state.consumers) {
//       try {
//         if (consumer?.appData?.socketId === socket.id) {
//           consumer.close();
//           state.consumers.delete(consumerId);
//           console.log(`Consumer ${consumerId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Consumer cleanup error:", e);
//       }
//     }

//     // Clean up transports
//     for (const [transportId, transport] of state.transports) {
//       try {
//         if (transport?.appData?.socketId === socket.id) {
//           transport.close();
//           state.transports.delete(transportId);
//           console.log(`Transport ${transportId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Transport cleanup error:", e);
//       }
//     }

//     // Clean up producers
//     for (const [producerId, producer] of state.producers) {
//       try {
//         if (producer?.appData?.socketId === socket.id) {
//           producer.close();
//           state.producers.delete(producerId);
//           console.log(`Producer ${producerId} closed and removed`);
//         }
//       } catch (e) {
//         console.warn("Producer cleanup error:", e);
//       }
//     }

//     if (meta.userId) {
//       state.participants.delete(meta.userId);
      
//       io.to(sid).emit("participant_left", {
//         userId: meta.userId,
//         socketId: socket.id
//       });
//     }

//     if (state.whiteboardId) {
//       console.log(`Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`);
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb) {
//         const participant = wb.participants.find(p => p.user.toString() === meta.userId);
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//         }
//         await wb.save();
//         console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
//       }
//     }

//     if (meta.role !== ROLE_MAP.STREAMER) {
//       try {
//         const participant = await liveSessionParticipant.findOne({ 
//           $or: [
//             { sessionId: sid, userId: meta.userId },
//             { socketId: socket.id }
//           ]
//         });
        
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//           participant.isActiveDevice = false;
//           await participant.save();
//           console.log(`Participant ${meta.userId} marked as LEFT`);
//         }
//       } catch (e) {
//         console.error("cleanup update error:", e?.message || e);
//       }

//       state.viewers.delete(socket.id);
//       io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
//       console.log(`Viewer ${socket.id} left room ${sid}`);
//     } else {
//       console.log(`Streamer ${socket.id} left room ${sid}`);
      
//       if (state.streamerSocketId === socket.id) {
//         state.streamerSocketId = null;
//         console.log(`Cleared streamerSocketId for session: ${sid}`);
//       }

//       const session = await liveSession.findOne({ sessionId: sid });
//       if (session) {
//         session.status = "PAUSED";
//         await session.save();
//         console.log(`Session ${sid} paused due to streamer leaving`);
//       }

//       io.to(sid).emit("session_paused_or_ended_by_streamer");
//     }

//     state.sockets.delete(socket.id);
//     socket.leave(sid);
//     console.log(`Socket ${socket.id} removed from room state for session: ${sid}`);

//     if (state.sockets.size === 0) {
//       if (state.pendingOps && state.pendingOps.length > 0) {
//         await flushCanvasOps(sid).catch(err => {
//           console.error(`Error flushing canvas ops during cleanup for session ${sid}:`, err);
//         });
//       }

//       if (state.flushTimer) clearTimeout(state.flushTimer);
      
//       if (state.router) {
//         try {
//           state.router.close();
//           console.log(`Mediasoup router closed for session: ${sid}`);
//         } catch (e) {
//           console.warn("Error closing router:", e);
//         }
//         state.router = null;
//       }
      
//       roomState.delete(sid);
//       console.log(`Room state cleaned up for session: ${sid}`);
//     }
//   } catch (e) {
//     console.error("cleanupSocketFromRoom error:", e?.message || e);
//   }
// };

// const handleScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'screen'
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Screen share producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     socket.to(sessionId).emit("screen-share-started", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
    
//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
//   } catch (error) {
//     console.error("Screen share start error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerAudioProduce = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer audio produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-mic',
//         userId: socket.data.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // Notify all participants about the new audio producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'viewer-mic'
//     });

//     // ✅ FIX: Now emit audio permission granted WITH real producerId
//     io.to(sessionId).emit("viewer-audio-permission-granted", {
//       userId: socket.data.userId,
//       producerId: producer.id,
//       socketId: socket.id,
//       userName: state.sockets.get(socket.id)?.userName || 'Viewer'
//     });

//     callback({ id: producer.id });

//     const meta = state.sockets.get(socket.id);
//     if (meta) {
//       const participant = state.participants.get(meta.userId);
//       if (participant) {
//         participant.hasAudio = true;
//         io.to(sessionId).emit("participant_updated", {
//           userId: meta.userId,
//           updates: { hasAudio: true }
//         });
//       }
//     }

//     producer.on("transportclose", () => {
//       console.log("Viewer audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer audio produce error:", error);
//     callback({ error: error.message });
//   }
// };


// const handleViewerVideoProduce = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer video produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "video",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-camera',
//         userId: socket.data.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // Notify all participants about the new video producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'viewer-camera'
//     });

//     callback({ id: producer.id });

//     producer.on("transportclose", () => {
//       console.log("Viewer video producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer video produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerAudioRequest = async (socket, sessionId) => {
//   try {
//     console.log("Viewer audio permission request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const user = await authenticationModel.findById(meta.userId).select("name");
    
//     safeEmit(state.streamerSocketId, "viewer-audio-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: user?.name || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer audio request error:", error);
//   }
// };

// const handleViewerVideoRequest = async (socket, sessionId) => {
//   try {
//     console.log("Viewer video permission request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const user = await authenticationModel.findById(meta.userId).select("name");
    
//     safeEmit(state.streamerSocketId, "viewer-video-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: user?.name || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer video request error:", error);
//   }
// };
// const handleViewerAudioResponse = (socket, sessionId, requesterSocketId, allow) => {
//   console.log(`Viewer audio response from streamer: ${allow} for: ${requesterSocketId}`);

//   if (allow) {
//     // Sirf viewer ko response bhejo
//     io.to(requesterSocketId).emit("viewer-audio-response", { allowed: true });
//   } else {
//     io.to(requesterSocketId).emit("viewer-audio-response", { allowed: false });
//   }
// };






// const handleViewerVideoResponse = async (socket, sessionId, requesterIdentifier, allow) => {
//   try {
//     console.log("Viewer video response from streamer:", allow, "for:", requesterIdentifier);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find the viewer's socket
//     let viewerSocketId = requesterIdentifier;
//     let viewerUserId = requesterIdentifier;
    
//     // Handle both socketId and userId input
//     if (requesterIdentifier && requesterIdentifier.length === 24) {
//       // It's a userId, find the socket
//       for (const [sockId, meta] of state.sockets) {
//         if (meta.userId === requesterIdentifier) {
//           viewerSocketId = sockId;
//           viewerUserId = meta.userId;
//           break;
//         }
//       }
//     } else {
//       // It's a socketId, find the userId
//       const meta = state.sockets.get(requesterIdentifier);
//       if (meta) {
//         viewerUserId = meta.userId;
//       }
//     }

//     if (!viewerSocketId) {
//       console.log("Could not find viewer socket for:", requesterIdentifier);
//       return;
//     }

//     // Send response to viewer
//     safeEmit(viewerSocketId, "viewer-video-response", {
//       allowed: allow,
//       message: allow ? "You can now share video" : "Streamer denied your video request"
//     });

//     if (allow) {
//       // Get the video producer for this viewer
//       let videoProducerId = null;
//       for (const [producerId, producer] of state.producers) {
//         if (producer.appData?.userId === viewerUserId && 
//             producer.appData?.source === 'viewer-camera') {
//           videoProducerId = producerId;
//           break;
//         }
//       }

//       // Update participant status for ALL participants
//       const viewerMeta = state.sockets.get(viewerSocketId);
//       if (viewerMeta) {
//         const participant = state.participants.get(viewerMeta.userId);
//         if (participant) {
//           participant.hasVideo = true;
          
//           // Notify ALL participants that this viewer can now share video
//           io.to(sessionId).emit("participant_updated", {
//             userId: viewerMeta.userId,
//             updates: { hasVideo: true }
//           });
          
//           // Notify everyone to consume this viewer's video
//           io.to(sessionId).emit("viewer-video-permission-granted", {
//             userId: viewerMeta.userId,
//             producerId: videoProducerId,
//             socketId: viewerSocketId,
//             userName: viewerMeta.userName || 'Viewer'
//           });
//         }
//       }
//     }
//   } catch (error) {
//     console.error("Viewer video response error:", error);
//   }
// };

// const handleViewerAudioMute = async (socket, sessionId, targetSocketId) => {
//   try {
//     console.log("Muting viewer audio:", targetSocketId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.socketId === targetSocketId && 
//           producer.kind === "audio" && 
//           producer.appData?.source === 'viewer-mic') {
//         await producer.pause();
//         console.log(`Viewer audio producer ${producerId} muted`);
        
//         const viewerMeta = state.sockets.get(targetSocketId);
//         if (viewerMeta) {
//           const participant = state.participants.get(viewerMeta.userId);
//           if (participant) {
//             participant.hasAudio = false;
//             io.to(sessionId).emit("participant_updated", {
//               userId: viewerMeta.userId,
//               updates: { hasAudio: false }
//             });
//           }
//         }
        
//         safeEmit(targetSocketId, "viewer-audio-muted", {
//           producerId: producer.id,
//           mutedBy: socket.data.userId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Viewer audio mute error:", error);
//   }
// };

// const handleViewerVideoMute = async (socket, sessionId, targetSocketId) => {
//   try {
//     console.log("Muting viewer video:", targetSocketId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.socketId === targetSocketId && 
//           producer.kind === "video" && 
//           producer.appData?.source === 'viewer-camera') {
//         await producer.pause();
//         console.log(`Viewer video producer ${producerId} muted`);
        
//         const viewerMeta = state.sockets.get(targetSocketId);
//         if (viewerMeta) {
//           const participant = state.participants.get(viewerMeta.userId);
//           if (participant) {
//             participant.hasVideo = false;
//             io.to(sessionId).emit("participant_updated", {
//               userId: viewerMeta.userId,
//               updates: { hasVideo: false }
//             });
//           }
//         }
        
//         safeEmit(targetSocketId, "viewer-video-muted", {
//           producerId: producer.id,
//           mutedBy: socket.data.userId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Viewer video mute error:", error);
//   }
// };

// const createConsumer = async (socket, sessionId, producerId, kind) => {
//   try {
//     console.log("Creating consumer for producer:", producerId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return;

//     // Create a transport for the consumer if it doesn't exist
//     let consumerTransport;
//     for (const [transportId, transport] of state.transports) {
//       if (transport.appData?.socketId === socket.id && transport.appData?.type === 'consumer') {
//         consumerTransport = transport;
//         break;
//       }
//     }

//     if (!consumerTransport) {
//       consumerTransport = await state.router.createWebRtcTransport({
//         listenIps: [
//           {
//             ip: "0.0.0.0",
//             announcedIp: process.env.SERVER_IP || "127.0.0.1",
//           },
//         ],
//         enableUdp: true,
//         enableTcp: true,
//         preferUdp: true,
//       });

//       consumerTransport.appData = { socketId: socket.id, type: 'consumer' };
//       state.transports.set(consumerTransport.id, consumerTransport);

//       // Send transport parameters to the client
//       socket.emit("new-consumer-transport", {
//         id: consumerTransport.id,
//         iceParameters: consumerTransport.iceParameters,
//         iceCandidates: consumerTransport.iceCandidates,
//         dtlsParameters: consumerTransport.dtlsParameters,
//       });
//     }

//     const producer = state.producers.get(producerId);
//     if (!producer) {
//       console.log("Producer not found for consumer creation:", producerId);
//       return;
//     }

//     const consumer = await consumerTransport.consume({
//       producerId,
//       rtpCapabilities: state.router.rtpCapabilities,
//       paused: false,
//     });

//     state.consumers.set(consumer.id, consumer);

//     // Send consumer parameters to the client
//     socket.emit("consumer-created", {
//       id: consumer.id,
//       producerId,
//       kind: consumer.kind,
//       rtpParameters: consumer.rtpParameters,
//     });

//     consumer.on("transportclose", () => {
//       console.log("Consumer transport closed:", consumer.id);
//       state.consumers.delete(consumer.id);
//     });

//     consumer.on("producerclose", () => {
//       console.log("Producer closed for consumer:", consumer.id);
//       socket.emit("producer-closed", { consumerId: consumer.id });
//       state.consumers.delete(consumer.id);
//     });

//   } catch (error) {
//     console.error("createConsumer error:", error);
//   }
// };

// const joinRoomHandler = async (socket, data) => {
//   const { token, sessionId, roomCode } = data;
//   console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);
  
//   try {
//     if (!token || (!sessionId && !roomCode)) {
//       return socket.emit("error_message", "Missing token or sessionId/roomCode");
//     }

//     let decoded;
//     try {
//       decoded = jwt.verify(token, process.env.SECRET_KEY);
//       console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
//     } catch (err) {
//       return socket.emit("error_message", "Invalid token");
//     }
    
//     const userId = decoded.userId;
//     const userRole = decoded.role;

//     let session;
//     if (sessionId) {
//       session = await liveSession.findOne({ sessionId });
//     } else {
//       session = await liveSession.findOne({ roomCode });
//     }

//     if (!session) return socket.emit("error_message", "Session not found");
//     if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
//       return socket.emit("error_message", `Session is ${session.status}`);
//     }

//     if (session.isPrivate) {
//       const allowed = Array.isArray(session.allowedUsers) && 
//         session.allowedUsers.some(u => u.toString() === userId);
//       if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
//     }

//     const sid = session.sessionId;
//     if (!roomState.has(sid)) {
//       roomState.set(sid, {
//         whiteboardId: session.whiteboardId || null,
//         createdBy: session.streamerId ? session.streamerId.toString() : null,
//         streamerSocketId: null,
//         viewers: new Set(),
//         sockets: new Map(),
//         participants: new Map(),
//         pendingScreenShareRequests: new Map(),
//         activeScreenShares: new Map(),
//         pendingOps: [],
//         flushTimer: null,
//         router: null,
//         transports: new Map(),
//         producers: new Map(),
//         consumers: new Map(),
//       });
//       console.log(`New room state created for session: ${sid}`);
//     }
    
//     const state = roomState.get(sid);

//     const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
//     const activeCount = await liveSessionParticipant.countDocuments({ 
//       sessionId: session._id, 
//       status: { $ne: "LEFT" } 
//     });
    
//     if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
//       return socket.emit("error_message", "Max participants limit reached");
//     }

//     let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
//     if (participant && participant.isBanned) {
//       return socket.emit("error_message", "You are banned from this session");
//     }

//     if (userRole === ROLE_MAP.STREAMER) {
//       if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
//         console.log(`Streamer reconnecting from ${state.streamerSocketId} to ${socket.id}`);
//         if (state.sockets.has(state.streamerSocketId)) {
//           state.sockets.delete(state.streamerSocketId);
//           state.viewers.delete(state.streamerSocketId);
//         }
//       }
//       state.streamerSocketId = socket.id;
//       console.log(`Streamer socket ID updated to: ${socket.id}`);
//     }

//     if (!participant) {
//       participant = await liveSessionParticipant.create({
//         sessionId: session._id,
//         userId,
//         socketId: socket.id,
//         status: "JOINED",
//         isActiveDevice: true,
//         joinedAt: new Date(),
//       });
//       session.totalJoins = (session.totalJoins || 0) + 1;
//       await session.save();
//       console.log(`New participant created, total joins: ${session.totalJoins}`);
//     } else {
//       participant.socketId = socket.id;
//       participant.status = "JOINED";
//       participant.isActiveDevice = true;
//       participant.joinedAt = new Date();
//       participant.leftAt = null;
//       await participant.save();
//     }

//     const user = await authenticationModel.findById(userId).select("name");
    
//     state.participants.set(userId, {
//       userId,
//       socketId: socket.id,
//       name: user?.name || "Unknown",
//       role: userRole,
//       joinedAt: new Date(),
//       isSpeaking: false,
//       hasAudio: false,
//       hasVideo: false,
//       isScreenSharing: false,
//     });

//     if (userRole === ROLE_MAP.STREAMER && !state.router) {
//       console.log("Creating Mediasoup router for session:", sid);
//       const mediaCodecs = [
//         {
//           kind: "audio",
//           mimeType: "audio/opus",
//           clockRate: 48000,
//           channels: 2,
//         },
//         {
//           kind: "video",
//           mimeType: "video/VP8",
//           clockRate: 90000,
//           parameters: {
//             "x-google-start-bitrate": process.env.NODE_ENV === "production" ? 500000 : 1000000,
//           },
//         },
//       ];

//       state.router = await mediasoupWorker.createRouter({ mediaCodecs });
//       console.log("Mediasoup router created for session:", sid);
//     }

//     state.sockets.set(socket.id, { userId, role: userRole, userName: user?.name || "Unknown" });
//     socket.data = { sessionId: sid, userId, role: userRole };
//     socket.join(sid);
//     console.log(`Socket ${socket.id} joined room ${sid}`);

//     const iceServers = getIceServersFromEnv();
//     socket.emit("ice_servers", iceServers);

//     io.to(sid).emit("participant_joined", {
//       userId,
//       name: user?.name || "Unknown",
//       role: userRole,
//       socketId: socket.id,
//       joinedAt: new Date(),
//       isSpeaking: false,
//       hasAudio: false,
//       hasVideo: false,
//       isScreenSharing: false,
//     });

//     const currentParticipants = Array.from(state.participants.values());
//     socket.emit("participants_list", currentParticipants);

//     if (userRole === ROLE_MAP.STREAMER) {
//       socket.emit("joined_room", {
//         as: "STREAMER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys()),
//         pendingScreenShareRequests: Array.from(state.pendingScreenShareRequests.values()),
//         activeScreenShares: Array.from(state.activeScreenShares.values())
//       });
//       console.log(`Streamer ${socket.id} joined room ${sid}`);
//     } else {
//       state.viewers.add(socket.id);
//       socket.emit("joined_room", {
//         as: "VIEWER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         whiteboardId: state.whiteboardId,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys())
//       });
//       console.log(`Viewer ${socket.id} joined room ${sid}`);
      
//       if (state.streamerSocketId) {
//         safeEmit(state.streamerSocketId, "viewer_ready", { 
//           viewerSocketId: socket.id, 
//           viewerUserId: userId 
//         });
//       }
//     }

//     if (state.whiteboardId) {
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
//         wb.participants.push({ 
//           user: userId, 
//           role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", 
//           joinedAt: new Date() 
//         });
//         await wb.save();
//         console.log(`User added to whiteboard: ${state.whiteboardId}`);
//       }
//     }

//     const currentParticipantsCount = state.viewers.size + (state.streamerSocketId ? 1 : 0);
//     if ((session.peakParticipants || 0) < currentParticipantsCount) {
//       session.peakParticipants = currentParticipantsCount;
//       await session.save();
//       console.log(`New peak participants: ${currentParticipantsCount}`);
//     }
//   } catch (err) {
//     console.error("join_room error:", err);
//     socket.emit("error_message", "Invalid token/session");
//     throw err;
//   }
// };

// const chatHandler = async (socket, sessionId, message) => {
//   console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}`);
  
//   try {
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const sender = await authenticationModel.findById(meta.userId).select("name");
    
//     io.to(sessionId).emit("chat_message", {
//       userId: meta.userId,
//       name: sender?.name || "Unknown",
//       message,
//       socketId: socket.id,
//       at: new Date(),
//     });
    
//     console.log(`Chat message broadcast to session: ${sessionId}`);
//   } catch (err) {
//     console.error("chat_message error:", err);
//     throw err;
//   }
// };

// const streamerControlHandler = async (socket, data) => {
//   const { sessionId, status, emitEvent } = data;
//   console.log(`Streamer control request for session: ${sessionId}, status: ${status}`);
  
//   try {
//     const session = await liveSession.findOne({ sessionId });
//     if (!session) return;

//     if (status === "PAUSED") {
//       await pauseAllProducers(sessionId, socket.id);
//     } else if (status === "ACTIVE") {
//       await resumeAllProducers(sessionId, socket.id);
//     }

//     session.status = status;
//     if (status === "ACTIVE" && emitEvent === "streamer_started") {
//       session.actualStartTime = new Date();
//     }

//     await session.save();
//     io.to(sessionId).emit(emitEvent, { sessionId });
//     console.log(`Session ${sessionId} ${status.toLowerCase()} by streamer`);
//   } catch (err) {
//     console.error("streamer_control error:", err);
//     throw err;
//   }
// };

// const getRouterRtpCapabilitiesHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getRouterRtpCapabilities for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });
//     callback({ rtpCapabilities: state.router.rtpCapabilities });
//   } catch (error) {
//     console.error("getRouterRtpCapabilities error:", error);
//     callback({ error: error.message });
//   }
// };

// const createWebRtcTransportHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("createWebRtcTransport for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });

//     const transport = await state.router.createWebRtcTransport({
//       listenIps: [
//         {
//           ip: "0.0.0.0",
//           announcedIp: process.env.SERVER_IP || "127.0.0.1",
//         },
//       ],
//       enableUdp: true,
//       enableTcp: true,
//       preferUdp: true,
//       initialAvailableOutgoingBitrate: process.env.NODE_ENV === "production" ? 500000 : 1000000,
//     });

//     transport.on("dtlsstatechange", (dtlsState) => {
//       if (dtlsState === "closed") transport.close();
//     });

//     transport.appData = { socketId: socket.id };
//     state.transports.set(transport.id, transport);

//     callback({
//       params: {
//         id: transport.id,
//         iceParameters: transport.iceParameters,
//         iceCandidates: transport.iceCandidates,
//         dtlsParameters: transport.dtlsParameters,
//       },
//     });
//   } catch (error) {
//     console.error("createWebRtcTransport error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportConnectHandler = async (socket, sessionId, transportId, dtlsParameters, callback) => {
//   try {
//     console.log("transport-connect for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     await transport.connect({ dtlsParameters });
//     callback({ success: true });
//   } catch (error) {
//     console.error("transport-connect error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportProduceHandler = async (socket, sessionId, transportId, kind, rtpParameters, appData, callback) => {
//   try {
//     console.log("transport-produce for transport:", transportId, "kind:", kind, "source:", appData?.source);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: appData?.source || 'camera'
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("transport-produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumeHandler = async (socket, sessionId, transportId, producerId, rtpCapabilities, callback) => {
//   try {
//     console.log("consume for producer:", producerId, "transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) {
//       console.log("❌ Router not found for session:", sessionId);
//       return callback({ error: "Router not found" });
//     }

//     const producer = state.producers.get(producerId);
//     if (!producer) {
//       console.log("❌ Producer not found:", producerId);
//       return callback({ error: "Producer not found" });
//     }

//     if (!state.router.canConsume({ producerId, rtpCapabilities })) {
//       console.log("❌ Cannot consume - router.canConsume returned false");
//       return callback({ error: "Cannot consume" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) {
//       console.log("❌ Transport not found:", transportId);
//       return callback({ error: "Transport not found" });
//     }

//     const consumer = await transport.consume({
//       producerId,
//       rtpCapabilities,
//       paused: true,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//       },
//     });

//     state.consumers.set(consumer.id, consumer);
//     console.log("✅ Consumer created:", consumer.id);

//     callback({
//       params: {
//         id: consumer.id,
//         producerId,
//         kind: consumer.kind,
//         rtpParameters: consumer.rtpParameters,
//       },
//     });
//   } catch (error) {
//     console.error("consume error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumerResumeHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-resume for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     await consumer.resume();
//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-resume error:", error);
//     callback({ error: error.message });
//   }
// };

// const getProducersHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getProducers for session:", sessionId);
//     const state = roomState.get(sessionId);
//     callback(state ? Array.from(state.producers.keys()) : []);
//   } catch (error) {
//     console.error("getProducers error:", error);
//     callback([]);
//   }
// };
// const getProducerInfoHandler = async (socket, sessionId, producerId, callback) => {
//   try {
//     console.log("getProducerInfo for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback(null);

//     const producer = state.producers.get(producerId);
//     if (!producer) return callback(null);

//     callback({
//       id: producer.id,
//       kind: producer.kind,
//       userId: socket.data?.userId,
//       socketId: producer.appData?.socketId,
//       source: producer.appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("getProducerInfo error:", error);
//     callback(null);
//   }
// };

// const consumerReadyHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-ready for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-ready error:", error);
//     callback({ error: error.message });
//   }
// };

// const offerHandler = (socket, sessionId, targetSocketId, sdp) => {
//   console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || state.streamerSocketId !== socket.id) return;
//   safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
// };

// const answerHandler = (socket, sessionId, sdp) => {
//   console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta || meta.role === ROLE_MAP.STREAMER) return;

//   safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
// };

// const iceCandidateHandler = (socket, sessionId, targetSocketId, candidate) => {
//   console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;
//   safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
// };

// const whiteboardEventHandler = (socket, sessionId, type, data, patch) => {
//   console.log(`Whiteboard ${type} from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit(`whiteboard_${type}`, { 
//     userId: meta.userId, 
//     [`${type}Data`]: data 
//   });
  
//   scheduleFlush(sessionId, { type, payload: data, patch, at: new Date() });
// };

// const whiteboardUndoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const undoStack = wb.undoStack || [];
//   if (undoStack.length === 0) return;

//   const last = undoStack.pop();
//   wb.undoStack = undoStack.slice(-500);
//   wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_undo_applied", { last });
//   console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardRedoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const redoStack = wb.redoStack || [];
//   if (redoStack.length === 0) return;

//   const last = redoStack.pop();
//   wb.redoStack = redoStack.slice(-500);
//   wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_redo_applied", { last });
//   console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardSaveCanvasHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
//   await flushCanvasOps(sessionId).catch(err => {
//     console.error(`Error saving canvas for session ${sessionId}:`, err);
//   });
//   socket.emit("whiteboard_saved");
//   console.log(`Whiteboard saved for session: ${sessionId}`);
// };

// const cursorUpdateHandler = (socket, sessionId, position) => {
//   console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
// };

// const whiteboardStateRequestHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   socket.emit("whiteboard_state_sync", {
//     canvasData: wb.canvasData,
//     participants: wb.participants,
//     versionHistory: wb.versionHistory,
//   });
  
//   console.log(`Whiteboard state sent to socket: ${socket.id}`);
// };

// export const setupIntegratedSocket = async (server) => {
//   console.log("Setting up integrated socket");

//   try {
//     mediasoupWorker = await createMediasoupWorker();
//   } catch (error) {
//     console.error("Failed to initialize Mediasoup:", error);
//     throw error;
//   }

//   const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5174";
//   io = new Server(server, {
//     cors: {
//       origin: corsOrigin,
//       methods: ["GET", "POST"],
//       credentials: true,
//     },
//   });

//   console.log(`Socket.io configured with CORS origin: ${corsOrigin} for ${process.env.NODE_ENV} environment`);

//   io.on("connection", (socket) => {
//     console.log("New client connected:", socket.id);

//     // ====== NEW EVENT HANDLERS ADDED ======
//     // These events will forward messages to all clients in the room
//     socket.on("new-producer", (data) => {
//       console.log("New producer event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("new-producer", data);
//     });
    
//     socket.on("viewer-audio-enabled", (data) => {
//       console.log("Viewer audio enabled event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("viewer-audio-enabled", data);
//     });
    
//     socket.on("screen-share-started-by-viewer", (data) => {
//       console.log("Screen share started by viewer event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("screen-share-started-by-viewer", data);
//     });

//     // NEW: Handle streamer consuming viewer screen
//     socket.on("streamer-consume-viewer-screen", (data) => 
//       handleStreamerConsumeViewerScreen(socket, data.sessionId, data.producerId)
//     );
//     // ====== END OF NEW EVENT HANDLERS ======

//     // ====== PERMISSION AND MEDIA EVENT HANDLERS ======
//    // yeh tumhara existing call hai
// socket.on("viewer-audio-response", (data) => {
//   handleViewerAudioResponse(
//     socket,
//     data.sessionId,
//     data.requesterSocketId,
//     data.allow
//   );
// });

    
//     socket.on("viewer-video-response", (data) => 
//       handleViewerVideoResponse(socket, data.sessionId, data.requesterSocketId, data.allow)
//     );
    
//     socket.on("screen-share-response", (data) => 
//       handleScreenShareResponse(socket, data.sessionId, data.requesterUserId, data.allow)
//     );
    
//     socket.on("screen-share-force-stop", (data) => 
//       handleStreamerStopScreenShare(socket, data.sessionId, data.targetUserId)
//     );
    
//     socket.on("viewer-audio-muted", (data) => 
//       handleViewerAudioMuted(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-video-muted", (data) => 
//       handleViewerVideoMuted(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-audio-started", (data) => 
//       handleViewerAudioStarted(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-video-started", (data) => 
//       handleViewerVideoStarted(socket, data.sessionId, data)
//     );
    
//     socket.on("screen-share-started-by-viewer", (data) => 
//       handleScreenShareStartedByViewer(socket, data.sessionId, data)
//     );
    
//     socket.on("screen-share-stopped-by-viewer", (data) => 
//       handleViewerScreenShareStop(socket, data.sessionId, data.userId)
//     );
    
//     socket.on("viewer-audio-enabled", (data) => 
//       handleViewerAudioEnabled(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-video-enabled", (data) => 
//       handleViewerVideoEnabled(socket, data.sessionId, data)
//     );

//     // Room and chat events
//     socket.on("join_room", (data) => joinRoomHandler(socket, data));
//     socket.on("chat_message", (data) => chatHandler(socket, data.sessionId, data.message));
//     socket.on("streamer_control", (data) => streamerControlHandler(socket, data));
    
//     // Participant management events
//     socket.on("get_participants", (data, cb) => 
//       getParticipantsHandler(socket, data.sessionId, cb)
//     );
    
//     socket.on("update_participant_status", (data) => 
//       updateParticipantStatusHandler(socket, data.sessionId, data.updates)
//     );
    
//     // Screen share events
//     socket.on("screen-share-request", (data) => 
//       handleScreenShareRequest(socket, data.sessionId)
//     );
    
//     // Producer control events
//     socket.on("producer-pause", (data) => 
//       producerPauseHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-resume", (data) => 
//       producerResumeHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-close", (data) => 
//       producerCloseHandler(socket, data.sessionId, data.producerId)
//     );
    
//     // Mediasoup events
//     socket.on("getRouterRtpCapabilities", (data, cb) => 
//       getRouterRtpCapabilitiesHandler(socket, data.sessionId, cb));
    
//     socket.on("createWebRtcTransport", (data, cb) => 
//       createWebRtcTransportHandler(socket, data.sessionId, cb));
    
//     socket.on("transport-connect", (data, cb) =>
//       transportConnectHandler(socket, data.sessionId, data.transportId, data.dtlsParameters, cb)
//     );
    
//     socket.on("transport-produce", (data, cb) =>
//       transportProduceHandler(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, data.appData, cb)
//     );
    
//     // Screen share specific event (for streamer)
//     socket.on("transport-produce-screen", (data, cb) =>
//       handleScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//     );

//     // Viewer audio events
//     socket.on("viewer-audio-request", (data) => 
//       handleViewerAudioRequest(socket, data.sessionId)
//     );

//     socket.on("viewer-video-request", (data) => 
//       handleViewerVideoRequest(socket, data.sessionId)
//     );

//     socket.on("transport-produce-viewer-audio", (data, cb) =>
//       handleViewerAudioProduce(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     socket.on("transport-produce-viewer-video", (data, cb) =>
//       handleViewerVideoProduce(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     // Add this to your socket event handlers
//     socket.on("transport-produce-viewer-screen-audio", (data, cb) =>
//       handleViewerScreenShareAudio(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     socket.on("viewer-audio-mute", (data) => 
//       handleViewerAudioMute(socket, data.sessionId, data.targetSocketId)
//     );
    
//     socket.on("viewer-video-mute", (data) => 
//       handleViewerVideoMute(socket, data.sessionId, data.targetSocketId)
//     );
    
//     // Viewer screen share events
//     socket.on("transport-produce-viewer-screen", (data, cb) =>
//       handleViewerScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//     );

//     socket.on("screen-share-stop", (data) => 
//       handleViewerScreenShareStop(socket, data.sessionId)
//     );
        
//     socket.on("consume", (data, cb) =>
//       consumeHandler(socket, data.sessionId, data.transportId, data.producerId, data.rtpCapabilities, cb)
//     );
    
//     socket.on("consumer-resume", (data, cb) =>
//       consumerResumeHandler(socket, data.sessionId, data.consumerId, cb)
//     );
    
//     socket.on("getProducers", (data, cb) =>
//       getProducersHandler(socket, data.sessionId, cb)
//     );
    
//     socket.on("getProducerInfo", (data, cb) =>
//       getProducerInfoHandler(socket, data.sessionId, data.producerId, cb)
//     );
    
//     socket.on("consumer-ready", (data, cb) =>
//       consumerReadyHandler(socket, data.sessionId, data.consumerId, cb)
//     );

//     // Whiteboard events
//     socket.on("whiteboard_draw", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "draw", data.drawData, data.patch)
//     );
    
//     socket.on("whiteboard_erase", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "erase", data.eraseData, data.patch)
//     );
    
//     socket.on("whiteboard_undo", (data) => 
//       whiteboardUndoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_redo", (data) => 
//       whiteboardRedoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_save", (data) => 
//       whiteboardSaveCanvasHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_cursor", (data) => 
//       cursorUpdateHandler(socket, data.sessionId, data.position)
//     );
    
//     socket.on("whiteboard_state_request", (data) => 
//       whiteboardStateRequestHandler(socket, data.sessionId)
//     );

//     // WebRTC events
//     socket.on("offer", (data) => 
//       offerHandler(socket, data.sessionId, data.targetSocketId, data.sdp)
//     );
    
//     socket.on("answer", (data) => 
//       answerHandler(socket, data.sessionId, data.sdp)
//     );
    
//     socket.on("ice-candidate", (data) => 
//       iceCandidateHandler(socket, data.sessionId, data.targetSocketId, data.candidate)
//     );

//     socket.on("disconnect", () => cleanupSocketFromRoom(socket));
//   });

//   console.log("✅ Socket.io setup complete with screen share permission system");
//   return io;
// };

// // ====== MISSING HANDLER IMPLEMENTATIONS ======

// const handleViewerAudioMuted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio muted:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasAudio: false }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-audio-muted-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer audio muted error:", error);
//   }
// };

// const handleViewerVideoMuted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer video muted:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasVideo = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasVideo: false }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-video-muted-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer video muted error:", error);
//   }
// };

// const handleViewerAudioStarted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio started:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = true;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasAudio: true }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-audio-started-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer",
//       socketId: socket.id
//     });
//   } catch (error) {
//     console.error("Viewer audio started error:", error);
//   }
// };

// const handleViewerVideoStarted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer video started:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasVideo = true;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasVideo: true }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-video-started-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer",
//       socketId: socket.id
//     });
//   } catch (error) {
//     console.error("Viewer video started error:", error);
//   }
// };

// const handleScreenShareStartedByViewer = async (socket, sessionId, data) => {
//   try {
//     console.log("Screen share started by viewer:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.isScreenSharing = true;
//       // Forward to all other participants in the room
//       socket.to(sessionId).emit("screen-share-started-by-viewer", data);
//     }
//   } catch (error) {
//     console.error("Screen share started by viewer error:", error);
//   }
// };

// const handleViewerAudioEnabled = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio enabled:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = true;
//       // Forward to all other participants in the room
//       socket.to(sessionId).emit("viewer-audio-enabled", data);
//     }
//   } catch (error) {
//     console.error("Viewer audio enabled error:", error);
//   }
// };

// const handleViewerVideoEnabled = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer video enabled:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasVideo = true;
//       // Forward to all other participants in the room
//       socket.to(sessionId).emit("viewer-video-enabled", data);
//     }
//   } catch (error) {
//     console.error("Viewer video enabled error:", error);
//   }
// };

// // Export functions as named exports
// export { getIO };










// working code 
// import { Server } from "socket.io";
// import jwt from "jsonwebtoken";
// import mediasoup from "mediasoup";
// import liveSession from "../model/liveSessions/liveeSession.model.js";
// import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
// import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
// import { ROLE_MAP } from "../constant/role.js";
// import authenticationModel from "../../app/model/Authentication/authentication.model.js";

// // ======= Global Variables =======
// let io;
// let mediasoupWorker;
// const roomState = new Map();

// // ======= Utility Functions =======
// const getIO = () => {
//   if (!io) throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
//   return io;
// };

// const safeEmit = (toSocketId, event, payload) => {
//   try {
//     const s = io.sockets.sockets.get(toSocketId);
//     if (s) {
//       s.emit(event, payload);
//       console.log(`Emitted ${event} to socket: ${toSocketId}`);
//     } else {
//       console.log(`Socket not found: ${toSocketId}`);
//     }
//   } catch (err) {
//     console.error("safeEmit error:", err);
//   }
// };

// const getIceServersFromEnv = () => {
//   const isProduction = process.env.NODE_ENV === "production";

//   const servers = [];
//   const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
//     .split(",")
//     .map(s => s.trim())
//     .filter(Boolean);
//   stunUrls.forEach(url => { if (url) servers.push({ urls: url }); });

//   if (isProduction) {
//     const turnUrls = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//     const turnUsername = process.env.TURN_USERNAME;
//     const turnPassword = process.env.TURN_PASSWORD;

//     turnUrls.forEach(url => {
//       if (url && turnUsername && turnPassword) {
//         servers.push({
//           urls: url,
//           username: turnUsername,
//           credential: turnPassword
//         });
//       }
//     });
//   }
//   if (servers.length === 0) {
//     servers.push({ urls: "stun:stun.l.google.com:19302" });
//     servers.push({ urls: "stun:global.stun.twilio.com:3478" });
//   }

//   return servers;
// };

// const createMediasoupWorker = async () => {
//   try {
//     const minPort = parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000;
//     const maxPort = parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999;
//     const logLevel = process.env.MEDIASOUP_LOG_LEVEL || "warn";

//     mediasoupWorker = await mediasoup.createWorker({
//       logLevel,
//       rtcMinPort: minPort,
//       rtcMaxPort: maxPort,
//     });

//     console.log(`Mediasoup Worker Created (Ports: ${minPort}-${maxPort}) for ${process.env.NODE_ENV} environment`);

//     mediasoupWorker.on("died", () => {
//       console.error("Mediasoup worker died, restarting in 2 seconds...");
//       setTimeout(() => createMediasoupWorker().catch(console.error), 2000);
//     });

//     return mediasoupWorker;
//   } catch (error) {
//     console.error("Failed to create Mediasoup worker:", error);
//     throw error;
//   }
// };

// const flushCanvasOps = async (sessionId) => {
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
  
//   if (state.flushTimer) {
//     clearTimeout(state.flushTimer);
//     state.flushTimer = null;
//   }

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
// };

// const scheduleFlush = (sessionId, op) => {
//   console.log(`Scheduling flush for session: ${sessionId}, operation type: ${op?.type}`);
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
  
//   state.flushTimer = setTimeout(() => {
//     flushCanvasOps(sessionId).catch(err => {
//       console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
//     });
//   }, 2000);
  
//   console.log(`Flush scheduled for session: ${sessionId}`);
// };

// export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
//   console.log(`Initializing whiteboard RTC for session: ${sessionId}, whiteboard: ${whiteboardId}, createdBy: ${createdBy}`);
  
//   if (!roomState.has(sessionId)) {
//     roomState.set(sessionId, {
//       whiteboardId,
//       createdBy,
//       streamerSocketId: null,
//       viewers: new Set(),
//       sockets: new Map(),
//       participants: new Map(),
//       pendingScreenShareRequests: new Map(),
//       activeScreenShares: new Map(),
//       pendingOps: [],
//       flushTimer: null,
//       router: null,
//       transports: new Map(),
//       producers: new Map(),
//       consumers: new Map(),
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

// // ======= Producer Control Functions =======
// const pauseAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Pausing all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.pause();
//         console.log(`Producer ${producerId} paused`);
//         safeEmit(socketId, "producer-paused", { producerId });
//       } catch (error) {
//         console.error("Error pausing producer:", error);
//       }
//     }
//   }
// };

// const resumeAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Resuming all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.resume();
//         console.log(`Producer ${producerId} resumed`);
//         safeEmit(socketId, "producer-resumed", { producerId });
//       } catch (error) {
//         console.error("Error resuming producer:", error);
//       }
//     }
//   }
// };

// const producerPauseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-pause for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.pause();
//       socket.emit("producer-paused", { producerId });
//       console.log(`Producer ${producerId} paused`);
//     }
//   } catch (error) {
//     console.error("producer-pause error:", error);
//   }
// };

// const producerResumeHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-resume for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.resume();
//       socket.emit("producer-resumed", { producerId });
//       console.log(`Producer ${producerId} resumed`);
//     }
//   } catch (error) {
//     console.error("producer-resume error:", error);
//   }
// };

// const producerCloseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-close for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer) {
//       producer.close();
//       state.producers.delete(producerId);
//       console.log(`Producer ${producerId} closed and removed`);
//       socket.emit("producer-closed", { producerId });
//     }
//   } catch (error) {
//     console.error("producer-close error:", error);
//   }
// };

// // ======= Screen Share Functions =======
// const handleScreenShareRequest = async (socket, sessionId) => {
//   try {
//     console.log("Screen share request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     if (state.activeScreenShares.has(meta.userId)) {
//       socket.emit("screen-share-error", { message: "You already have an active screen share" });
//       return;
//     }

//     const user = await authenticationModel.findById(meta.userId).select("name");
    
//     state.pendingScreenShareRequests.set(meta.userId, {
//       userId: meta.userId,
//       socketId: socket.id,
//       userName: user?.name || "Viewer",
//       requestedAt: new Date()
//     });

//     safeEmit(state.streamerSocketId, "screen-share-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: user?.name || "Viewer"
//     });
//     console.log("📩 Screen-share request received from:", meta.userId, "session:", sessionId);


//     socket.emit("screen-share-request-sent");
//   } catch (error) {
//     console.error("Screen share request error:", error);
//     socket.emit("screen-share-error", { message: "Failed to send screen share request" });
//   }
// };

// const handleScreenShareResponse = async (socket, sessionId, requesterIdentifier, allow) => {
//   try {
//     console.log("Screen share response from streamer:", allow, "for:", requesterIdentifier);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find the request by socketId or userId
//     let request;
    
//     // First try to find by socketId (shorter ID)
//     if (requesterIdentifier && requesterIdentifier.length < 24) {
//       for (const [userId, req] of state.pendingScreenShareRequests) {
//         if (req.socketId === requesterIdentifier) {
//           request = req;
//           break;
//         }
//       }
//     } 
//     // If not found, try by userId
//     if (!request) {
//       request = state.pendingScreenShareRequests.get(requesterIdentifier);
//     }

//     if (!request) {
//       console.log("No pending screen share request found for:", requesterIdentifier);
//       return;
//     }

//     state.pendingScreenShareRequests.delete(request.userId);

//     safeEmit(request.socketId, "screen-share-response", {
//       allowed: allow,
//       message: allow ? "You can now share your screen" : "Streamer denied your screen share request"
//     });

//     if (allow) {
//       // Add to active screen shares
//       state.activeScreenShares.set(request.userId, {
//         userId: request.userId,
//         socketId: request.socketId,
//         userName: request.userName,
//         startedAt: new Date()
//       });
      
//       // Update participant status
//       const participant = state.participants.get(request.userId);
//       if (participant) {
//         participant.isScreenSharing = true;
//         io.to(sessionId).emit("participant_updated", {
//           userId: request.userId,
//           updates: { isScreenSharing: true }
//         });
//       }
      
//       // Notify all participants that screen share is starting
//       io.to(sessionId).emit("screen-share-started-by-viewer", {
//         userId: request.userId,
//         userName: request.userName,
//         socketId: request.socketId
//       });
//     }
//   } catch (error) {
//     console.error("Screen share response error:", error);
//   }
// };

// const handleViewerScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return callback({ error: "Unauthorized" });

//     if (!state.activeScreenShares.has(meta.userId)) {
//       return callback({ error: "No screen share permission" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-screen',
//         userId: meta.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
//     if (state.streamerSocketId) {
//       safeEmit(state.streamerSocketId, "new-viewer-screen-producer", {
//         producerId: producer.id,
//         kind: producer.kind,
//         userId: meta.userId,
//         userName: meta.userName || 'Viewer',
//         source: 'viewer-screen'
//       });
//     }

//     // Notify all participants about the new screen share producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen'
//     });

//     callback({ id: producer.id });

//     producer.on("transportclose", () => {
//       console.log("Viewer screen share producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     producer.on("trackended", () => {
//       console.log("Viewer screen share track ended:", producer.id);
//       handleViewerScreenShareStop(socket, sessionId, meta.userId);
//     });

//   } catch (error) {
//     console.error("Viewer screen share start error:", error);
//     callback({ error: error.message });
//   }
// };

// // Handle streamer specifically requesting to consume viewer screen
// const handleStreamerConsumeViewerScreen = async (socket, sessionId, producerId) => {
//   try {
//     console.log("Streamer consuming viewer screen:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return;

//     const producer = state.producers.get(producerId);
//     if (!producer) return;

//     // Create a consumer for the streamer
//     createConsumer(socket, sessionId, producerId, producer.kind);
//   } catch (error) {
//     console.error("Streamer consume viewer screen error:", error);
//   }
// };

// // Add this new handler for screen share audio
// const handleViewerScreenShareAudio = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share audio for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return callback({ error: "Unauthorized" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-screen-audio',
//         userId: meta.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // Notify all participants about the new screen share audio producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen-audio'
//     });

//     callback({ id: producer.id });

//     producer.on("transportclose", () => {
//       console.log("Viewer screen share audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer screen share audio error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerScreenShareStop = async (socket, sessionId, userId = null) => {
//   try {
//     console.log("Viewer screen share stop from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const targetUserId = userId || socket.data?.userId;
//     if (!targetUserId) return;

//     state.activeScreenShares.delete(targetUserId);

//     const participant = state.participants.get(targetUserId);
//     if (participant) {
//       participant.isScreenSharing = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: targetUserId,
//         updates: { isScreenSharing: false }
//       });
//     }

//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.userId === targetUserId && 
//           (producer.appData?.source === 'viewer-screen' || producer.appData?.source === 'viewer-screen-audio')) {
//         try {
//           producer.close();
//           state.producers.delete(producerId);
//           console.log(`Screen share producer ${producerId} closed`);
//         } catch (e) {
//           console.warn("Error closing screen share producer:", e);
//         }
//       }
//     }

//     io.to(sessionId).emit("screen-share-stopped-by-viewer", {
//       userId: targetUserId
//     });

//     console.log(`Screen share stopped for user: ${targetUserId}`);
//   } catch (error) {
//     console.error("Viewer screen share stop error:", error);
//   }
// };

// const handleStreamerStopScreenShare = async (socket, sessionId, targetUserId) => {
//   try {
//     console.log("Streamer stopping screen share for user:", targetUserId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find and close the screen share producer
//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.userId === targetUserId && 
//           (producer.appData?.source === 'viewer-screen' || producer.appData?.source === 'viewer-screen-audio')) {
//         producer.close();
//         state.producers.delete(producerId);
        
//         // Notify the viewer
//         const viewerSocket = state.participants.get(targetUserId)?.socketId;
//         if (viewerSocket) {
//           safeEmit(viewerSocket, "screen-share-force-stop", {
//             message: "Streamer stopped your screen share"
//           });
//         }
        
//         // Notify all participants
//         io.to(sessionId).emit("screen-share-stopped-by-viewer", {
//           userId: targetUserId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Streamer stop screen share error:", error);
//   }
// };

// // ======= Participant Management Functions =======
// const getParticipantsHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getParticipants for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback([]);
    
//     const participants = Array.from(state.participants.values());
//     callback(participants);
//   } catch (error) {
//     console.error("getParticipants error:", error);
//     callback([]);
//   }
// };

// const updateParticipantStatusHandler = async (socket, sessionId, updates) => {
//   try {
//     console.log("updateParticipantStatus for session:", sessionId, "updates:", updates);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       Object.assign(participant, updates);
      
//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates
//       });
//     }
//   } catch (error) {
//     console.error("updateParticipantStatus error:", error);
//   }
// };

// const cleanupSocketFromRoom = async (socket) => {
//   console.log(`Cleanup requested for socket: ${socket.id}`);
//   try {
//     const sid = socket.data?.sessionId;
//     if (!sid) {
//       console.log(`No session ID found for socket: ${socket.id}`);
//       return;
//     }
    
//     const state = roomState.get(sid);
//     if (!state) {
//       console.log(`No state found for session: ${sid}`);
//       return;
//     }

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.log(`No metadata found for socket: ${socket.id}`);
//       return;
//     }

//     if (state.pendingScreenShareRequests.has(meta.userId)) {
//       state.pendingScreenShareRequests.delete(meta.userId);
//     }

//     if (state.activeScreenShares.has(meta.userId)) {
//       await handleViewerScreenShareStop(socket, sid, meta.userId);
//     }

//     // Clean up consumers
//     for (const [consumerId, consumer] of state.consumers) {
//       try {
//         if (consumer?.appData?.socketId === socket.id) {
//           consumer.close();
//           state.consumers.delete(consumerId);
//           console.log(`Consumer ${consumerId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Consumer cleanup error:", e);
//       }
//     }

//     // Clean up transports
//     for (const [transportId, transport] of state.transports) {
//       try {
//         if (transport?.appData?.socketId === socket.id) {
//           transport.close();
//           state.transports.delete(transportId);
//           console.log(`Transport ${transportId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Transport cleanup error:", e);
//       }
//     }

//     // Clean up producers
//     for (const [producerId, producer] of state.producers) {
//       try {
//         if (producer?.appData?.socketId === socket.id) {
//           producer.close();
//           state.producers.delete(producerId);
//           console.log(`Producer ${producerId} closed and removed`);
//         }
//       } catch (e) {
//         console.warn("Producer cleanup error:", e);
//       }
//     }

//     if (meta.userId) {
//       state.participants.delete(meta.userId);
      
//       io.to(sid).emit("participant_left", {
//         userId: meta.userId,
//         socketId: socket.id
//       });
//     }

//     if (state.whiteboardId) {
//       console.log(`Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`);
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb) {
//         const participant = wb.participants.find(p => p.user.toString() === meta.userId);
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//         }
//         await wb.save();
//         console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
//       }
//     }

//     if (meta.role !== ROLE_MAP.STREAMER) {
//       try {
//         const participant = await liveSessionParticipant.findOne({ 
//           $or: [
//             { sessionId: sid, userId: meta.userId },
//             { socketId: socket.id }
//           ]
//         });
        
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//           participant.isActiveDevice = false;
//           await participant.save();
//           console.log(`Participant ${meta.userId} marked as LEFT`);
//         }
//       } catch (e) {
//         console.error("cleanup update error:", e?.message || e);
//       }

//       state.viewers.delete(socket.id);
//       io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
//       console.log(`Viewer ${socket.id} left room ${sid}`);
//     } else {
//       console.log(`Streamer ${socket.id} left room ${sid}`);
      
//       if (state.streamerSocketId === socket.id) {
//         state.streamerSocketId = null;
//         console.log(`Cleared streamerSocketId for session: ${sid}`);
//       }

//       const session = await liveSession.findOne({ sessionId: sid });
//       if (session) {
//         session.status = "PAUSED";
//         await session.save();
//         console.log(`Session ${sid} paused due to streamer leaving`);
//       }

//       io.to(sid).emit("session_paused_or_ended_by_streamer");
//     }

//     state.sockets.delete(socket.id);
//     socket.leave(sid);
//     console.log(`Socket ${socket.id} removed from room state for session: ${sid}`);

//     if (state.sockets.size === 0) {
//       if (state.pendingOps && state.pendingOps.length > 0) {
//         await flushCanvasOps(sid).catch(err => {
//           console.error(`Error flushing canvas ops during cleanup for session ${sid}:`, err);
//         });
//       }

//       if (state.flushTimer) clearTimeout(state.flushTimer);
      
//       if (state.router) {
//         try {
//           state.router.close();
//           console.log(`Mediasoup router closed for session: ${sid}`);
//         } catch (e) {
//           console.warn("Error closing router:", e);
//         }
//         state.router = null;
//       }
      
//       roomState.delete(sid);
//       console.log(`Room state cleaned up for session: ${sid}`);
//     }
//   } catch (e) {
//     console.error("cleanupSocketFromRoom error:", e?.message || e);
//   }
// };

// const handleScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'screen'
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Screen share producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     socket.to(sessionId).emit("screen-share-started", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
    
//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
//   } catch (error) {
//     console.error("Screen share start error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerAudioProduce = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer audio produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-mic',
//         userId: socket.data.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // Notify all participants about the new audio producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'viewer-mic'
//     });

//     // ✅ FIX: Now emit audio permission granted WITH real producerId
//     io.to(sessionId).emit("viewer-audio-permission-granted", {
//       userId: socket.data.userId,
//       producerId: producer.id,
//       socketId: socket.id,
//       userName: state.sockets.get(socket.id)?.userName || 'Viewer'
//     });

//     callback({ id: producer.id });

//     const meta = state.sockets.get(socket.id);
//     if (meta) {
//       const participant = state.participants.get(meta.userId);
//       if (participant) {
//         participant.hasAudio = true;
//         io.to(sessionId).emit("participant_updated", {
//           userId: meta.userId,
//           updates: { hasAudio: true }
//         });
//       }
//     }

//     producer.on("transportclose", () => {
//       console.log("Viewer audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer audio produce error:", error);
//     callback({ error: error.message });
//   }
// };


// const handleViewerVideoProduce = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer video produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "video",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-camera',
//         userId: socket.data.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // Notify all participants about the new video producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'viewer-camera'
//     });

//     callback({ id: producer.id });

//     producer.on("transportclose", () => {
//       console.log("Viewer video producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer video produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerAudioRequest = async (socket, sessionId) => {
//   try {
//     console.log("Viewer audio permission request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const user = await authenticationModel.findById(meta.userId).select("name");
    
//     safeEmit(state.streamerSocketId, "viewer-audio-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: user?.name || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer audio request error:", error);
//   }
// };

// const handleViewerVideoRequest = async (socket, sessionId) => {
//   try {
//     console.log("Viewer video permission request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const user = await authenticationModel.findById(meta.userId).select("name");
    
//     safeEmit(state.streamerSocketId, "viewer-video-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: user?.name || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer video request error:", error);
//   }
// };

// const handleViewerAudioResponse = (socket, sessionId, requesterSocketId, allow) => {
//   console.log(`Viewer audio response from streamer: ${allow} for: ${requesterSocketId}`);

//   if (allow) {
//     // Sirf viewer ko response bhejo
//     io.to(requesterSocketId).emit("viewer-audio-response", { allowed: true });
//   } else {
//     io.to(requesterSocketId).emit("viewer-audio-response", { allowed: false });
//   }
// };

// const handleViewerVideoResponse = async (socket, sessionId, requesterIdentifier, allow) => {
//   try {
//     console.log("Viewer video response from streamer:", allow, "for:", requesterIdentifier);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find the viewer's socket
//     let viewerSocketId = requesterIdentifier;
//     let viewerUserId = requesterIdentifier;
    
//     // Handle both socketId and userId input
//     if (requesterIdentifier && requesterIdentifier.length === 24) {
//       // It's a userId, find the socket
//       for (const [sockId, meta] of state.sockets) {
//         if (meta.userId === requesterIdentifier) {
//           viewerSocketId = sockId;
//           viewerUserId = meta.userId;
//           break;
//         }
//       }
//     } else {
//       // It's a socketId, find the userId
//       const meta = state.sockets.get(requesterIdentifier);
//       if (meta) {
//         viewerUserId = meta.userId;
//       }
//     }

//     if (!viewerSocketId) {
//       console.log("Could not find viewer socket for:", requesterIdentifier);
//       return;
//     }

//     // Send response to viewer
//     safeEmit(viewerSocketId, "viewer-video-response", {
//       allowed: allow,
//       message: allow ? "You can now share video" : "Streamer denied your video request"
//     });

//     if (allow) {
//       // Get the video producer for this viewer
//       let videoProducerId = null;
//       for (const [producerId, producer] of state.producers) {
//         if (producer.appData?.userId === viewerUserId && 
//             producer.appData?.source === 'viewer-camera') {
//           videoProducerId = producerId;
//           break;
//         }
//       }

//       // Update participant status for ALL participants
//       const viewerMeta = state.sockets.get(viewerSocketId);
//       if (viewerMeta) {
//         const participant = state.participants.get(viewerMeta.userId);
//         if (participant) {
//           participant.hasVideo = true;
          
//           // Notify ALL participants that this viewer can now share video
//           io.to(sessionId).emit("participant_updated", {
//             userId: viewerMeta.userId,
//             updates: { hasVideo: true }
//           });
          
//           // Notify everyone to consume this viewer's video
//           io.to(sessionId).emit("viewer-video-permission-granted", {
//             userId: viewerMeta.userId,
//             producerId: videoProducerId,
//             socketId: viewerSocketId,
//             userName: viewerMeta.userName || 'Viewer'
//           });
//         }
//       }
//     }
//   } catch (error) {
//     console.error("Viewer video response error:", error);
//   }
// };

// const handleViewerAudioMute = async (socket, sessionId, targetSocketId) => {
//   try {
//     console.log("Muting viewer audio:", targetSocketId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.socketId === targetSocketId && 
//           producer.kind === "audio" && 
//           producer.appData?.source === 'viewer-mic') {
//         await producer.pause();
//         console.log(`Viewer audio producer ${producerId} muted`);
        
//         const viewerMeta = state.sockets.get(targetSocketId);
//         if (viewerMeta) {
//           const participant = state.participants.get(viewerMeta.userId);
//           if (participant) {
//             participant.hasAudio = false;
//             io.to(sessionId).emit("participant_updated", {
//               userId: viewerMeta.userId,
//               updates: { hasAudio: false }
//             });
//           }
//         }
        
//         safeEmit(targetSocketId, "viewer-audio-muted", {
//           producerId: producer.id,
//           mutedBy: socket.data.userId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Viewer audio mute error:", error);
//   }
// };

// const handleViewerVideoMute = async (socket, sessionId, targetSocketId) => {
//   try {
//     console.log("Muting viewer video:", targetSocketId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.socketId === targetSocketId && 
//           producer.kind === "video" && 
//           producer.appData?.source === 'viewer-camera') {
//         await producer.pause();
//         console.log(`Viewer video producer ${producerId} muted`);
        
//         const viewerMeta = state.sockets.get(targetSocketId);
//         if (viewerMeta) {
//           const participant = state.participants.get(viewerMeta.userId);
//           if (participant) {
//             participant.hasVideo = false;
//             io.to(sessionId).emit("participant_updated", {
//               userId: viewerMeta.userId,
//               updates: { hasVideo: false }
//             });
//           }
//         }
        
//         safeEmit(targetSocketId, "viewer-video-muted", {
//           producerId: producer.id,
//           mutedBy: socket.data.userId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Viewer video mute error:", error);
//   }
// };

// const createConsumer = async (socket, sessionId, producerId, kind) => {
//   try {
//     console.log("Creating consumer for producer:", producerId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return;

//     // Create a transport for the consumer if it doesn't exist
//     let consumerTransport;
//     for (const [transportId, transport] of state.transports) {
//       if (transport.appData?.socketId === socket.id && transport.appData?.type === 'consumer') {
//         consumerTransport = transport;
//         break;
//       }
//     }

//     if (!consumerTransport) {
//       consumerTransport = await state.router.createWebRtcTransport({
//         listenIps: [
//           {
//             ip: "0.0.0.0",
//             announcedIp: process.env.SERVER_IP || "127.0.0.1",
//           },
//         ],
//         enableUdp: true,
//         enableTcp: true,
//         preferUdp: true,
//       });

//       consumerTransport.appData = { socketId: socket.id, type: 'consumer' };
//       state.transports.set(consumerTransport.id, consumerTransport);

//       // Send transport parameters to the client
//       socket.emit("new-consumer-transport", {
//         id: consumerTransport.id,
//         iceParameters: consumerTransport.iceParameters,
//         iceCandidates: consumerTransport.iceCandidates,
//         dtlsParameters: consumerTransport.dtlsParameters,
//       });
//     }

//     const producer = state.producers.get(producerId);
//     if (!producer) {
//       console.log("Producer not found for consumer creation:", producerId);
//       return;
//     }

//     const consumer = await consumerTransport.consume({
//       producerId,
//       rtpCapabilities: state.router.rtpCapabilities,
//       paused: false,
//     });

//     state.consumers.set(consumer.id, consumer);

//     // Send consumer parameters to the client
//     // socket.emit("consumer-created", {
//     //   id: consumer.id,
//     //   producerId,
//     //   kind: consumer.kind,
//     //   rtpParameters: consumer.rtpParameters,
//     // });
//     socket.emit("consumer-created", {
//   id: consumer.id,
//   producerId,
//   kind: consumer.kind,
//   rtpParameters: consumer.rtpParameters,
//   userId: producer.appData?.userId,   // ✅ add
//   source: producer.appData?.source,   // ✅ add
// });


//     consumer.on("transportclose", () => {
//       console.log("Consumer transport closed:", consumer.id);
//       state.consumers.delete(consumer.id);
//     });

//     consumer.on("producerclose", () => {
//       console.log("Producer closed for consumer:", consumer.id);
//       socket.emit("producer-closed", { consumerId: consumer.id });
//       state.consumers.delete(consumer.id);
//     });

//   } catch (error) {
//     console.error("createConsumer error:", error);
//   }
// };

// const joinRoomHandler = async (socket, data) => {
//   const { token, sessionId, roomCode } = data;
//   console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);
  
//   try {
//     if (!token || (!sessionId && !roomCode)) {
//       return socket.emit("error_message", "Missing token or sessionId/roomCode");
//     }

//     let decoded;
//     try {
//       decoded = jwt.verify(token, process.env.SECRET_KEY);
//       console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
//     } catch (err) {
//       return socket.emit("error_message", "Invalid token");
//     }
    
//     const userId = decoded.userId;
//     const userRole = decoded.role;

//     let session;
//     if (sessionId) {
//       session = await liveSession.findOne({ sessionId });
//     } else {
//       session = await liveSession.findOne({ roomCode });
//     }

//     if (!session) return socket.emit("error_message", "Session not found");
//     if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
//       return socket.emit("error_message", `Session is ${session.status}`);
//     }

//     if (session.isPrivate) {
//       const allowed = Array.isArray(session.allowedUsers) && 
//         session.allowedUsers.some(u => u.toString() === userId);
//       if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
//     }

//     const sid = session.sessionId;
//     if (!roomState.has(sid)) {
//       roomState.set(sid, {
//         whiteboardId: session.whiteboardId || null,
//         createdBy: session.streamerId ? session.streamerId.toString() : null,
//         streamerSocketId: null,
//         viewers: new Set(),
//         sockets: new Map(),
//         participants: new Map(),
//         pendingScreenShareRequests: new Map(),
//         activeScreenShares: new Map(),
//         pendingOps: [],
//         flushTimer: null,
//         router: null,
//         transports: new Map(),
//         producers: new Map(),
//         consumers: new Map(),
//       });
//       console.log(`New room state created for session: ${sid}`);
//     }
    
//     const state = roomState.get(sid);

//     const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
//     const activeCount = await liveSessionParticipant.countDocuments({ 
//       sessionId: session._id, 
//       status: { $ne: "LEFT" } 
//     });
    
//     if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
//       return socket.emit("error_message", "Max participants limit reached");
//     }

//     let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
//     if (participant && participant.isBanned) {
//       return socket.emit("error_message", "You are banned from this session");
//     }

//     if (userRole === ROLE_MAP.STREAMER) {
//       if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
//         console.log(`Streamer reconnecting from ${state.streamerSocketId} to ${socket.id}`);
//         if (state.sockets.has(state.streamerSocketId)) {
//           state.sockets.delete(state.streamerSocketId);
//           state.viewers.delete(state.streamerSocketId);
//         }
//       }
//       state.streamerSocketId = socket.id;
//       console.log(`Streamer socket ID updated to: ${socket.id}`);
//     }

//     if (!participant) {
//       participant = await liveSessionParticipant.create({
//         sessionId: session._id,
//         userId,
//         socketId: socket.id,
//         status: "JOINED",
//         isActiveDevice: true,
//         joinedAt: new Date(),
//       });
//       session.totalJoins = (session.totalJoins || 0) + 1;
//       await session.save();
//       console.log(`New participant created, total joins: ${session.totalJoins}`);
//     } else {
//       participant.socketId = socket.id;
//       participant.status = "JOINED";
//       participant.isActiveDevice = true;
//       participant.joinedAt = new Date();
//       participant.leftAt = null;
//       await participant.save();
//     }

//     const user = await authenticationModel.findById(userId).select("name");
    
//     state.participants.set(userId, {
//       userId,
//       socketId: socket.id,
//       name: user?.name || "Unknown",
//       role: userRole,
//       joinedAt: new Date(),
//       isSpeaking: false,
//       hasAudio: false,
//       hasVideo: false,
//       isScreenSharing: false,
//     });

//     if (userRole === ROLE_MAP.STREAMER && !state.router) {
//       console.log("Creating Mediasoup router for session:", sid);
//       const mediaCodecs = [
//         {
//           kind: "audio",
//           mimeType: "audio/opus",
//           clockRate: 48000,
//           channels: 2,
//         },
//         {
//           kind: "video",
//           mimeType: "video/VP8",
//           clockRate: 90000,
//           parameters: {
//             "x-google-start-bitrate": process.env.NODE_ENV === "production" ? 500000 : 1000000,
//           },
//         },
//       ];

//       state.router = await mediasoupWorker.createRouter({ mediaCodecs });
//       console.log("Mediasoup router created for session:", sid);
//     }

//     state.sockets.set(socket.id, { userId, role: userRole, userName: user?.name || "Unknown" });
//     socket.data = { sessionId: sid, userId, role: userRole };
//     socket.join(sid);
//     console.log(`Socket ${socket.id} joined room ${sid}`);

//     const iceServers = getIceServersFromEnv();
//     socket.emit("ice_servers", iceServers);

//     io.to(sid).emit("participant_joined", {
//       userId,
//       name: user?.name || "Unknown",
//       role: userRole,
//       socketId: socket.id,
//       joinedAt: new Date(),
//       isSpeaking: false,
//       hasAudio: false,
//       hasVideo: false,
//       isScreenSharing: false,
//     });

//     const currentParticipants = Array.from(state.participants.values());
//     socket.emit("participants_list", currentParticipants);

//     if (userRole === ROLE_MAP.STREAMER) {
//       socket.emit("joined_room", {
//         as: "STREAMER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys()),
//         pendingScreenShareRequests: Array.from(state.pendingScreenShareRequests.values()),
//         activeScreenShares: Array.from(state.activeScreenShares.values())
//       });
//       console.log(`Streamer ${socket.id} joined room ${sid}`);
//     } else {
//       state.viewers.add(socket.id);
//       socket.emit("joined_room", {
//         as: "VIEWER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         whiteboardId: state.whiteboardId,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys())
//       });
//       console.log(`Viewer ${socket.id} joined room ${sid}`);
      
//       if (state.streamerSocketId) {
//         safeEmit(state.streamerSocketId, "viewer_ready", { 
//           viewerSocketId: socket.id, 
//           viewerUserId: userId 
//         });
//       }
//     }

//     if (state.whiteboardId) {
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
//         wb.participants.push({ 
//           user: userId, 
//           role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", 
//           joinedAt: new Date() 
//         });
//         await wb.save();
//         console.log(`User added to whiteboard: ${state.whiteboardId}`);
//       }
//     }

//     const currentParticipantsCount = state.viewers.size + (state.streamerSocketId ? 1 : 0);
//     if ((session.peakParticipants || 0) < currentParticipantsCount) {
//       session.peakParticipants = currentParticipantsCount;
//       await session.save();
//       console.log(`New peak participants: ${currentParticipantsCount}`);
//     }
//   } catch (err) {
//     console.error("join_room error:", err);
//     socket.emit("error_message", "Invalid token/session");
//     throw err;
//   }
// };

// const chatHandler = async (socket, sessionId, message) => {
//   console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}`);
  
//   try {
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const sender = await authenticationModel.findById(meta.userId).select("name");
    
//     io.to(sessionId).emit("chat_message", {
//       userId: meta.userId,
//       name: sender?.name || "Unknown",
//       message,
//       socketId: socket.id,
//       at: new Date(),
//     });
    
//     console.log(`Chat message broadcast to session: ${sessionId}`);
//   } catch (err) {
//     console.error("chat_message error:", err);
//     throw err;
//   }
// };

// const streamerControlHandler = async (socket, data) => {
//   const { sessionId, status, emitEvent } = data;
//   console.log(`Streamer control request for session: ${sessionId}, status: ${status}`);
  
//   try {
//     const session = await liveSession.findOne({ sessionId });
//     if (!session) return;

//     if (status === "PAUSED") {
//       await pauseAllProducers(sessionId, socket.id);
//     } else if (status === "ACTIVE") {
//       await resumeAllProducers(sessionId, socket.id);
//     }

//     session.status = status;
//     if (status === "ACTIVE" && emitEvent === "streamer_started") {
//       session.actualStartTime = new Date();
//     }

//     await session.save();
//     io.to(sessionId).emit(emitEvent, { sessionId });
//     console.log(`Session ${sessionId} ${status.toLowerCase()} by streamer`);
//   } catch (err) {
//     console.error("streamer_control error:", err);
//     throw err;
//   }
// };

// const getRouterRtpCapabilitiesHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getRouterRtpCapabilities for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });
//     callback({ rtpCapabilities: state.router.rtpCapabilities });
//   } catch (error) {
//     console.error("getRouterRtpCapabilities error:", error);
//     callback({ error: error.message });
//   }
// };

// const createWebRtcTransportHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("createWebRtcTransport for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });

//     const transport = await state.router.createWebRtcTransport({
//       listenIps: [
//         {
//           ip: "0.0.0.0",
//           announcedIp: process.env.SERVER_IP || "127.0.0.1",
//         },
//       ],
//       enableUdp: true,
//       enableTcp: true,
//       preferUdp: true,
//       initialAvailableOutgoingBitrate: process.env.NODE_ENV === "production" ? 500000 : 1000000,
//     });

//     transport.on("dtlsstatechange", (dtlsState) => {
//       if (dtlsState === "closed") transport.close();
//     });

//     transport.appData = { socketId: socket.id };
//     state.transports.set(transport.id, transport);

//     callback({
//       params: {
//         id: transport.id,
//         iceParameters: transport.iceParameters,
//         iceCandidates: transport.iceCandidates,
//         dtlsParameters: transport.dtlsParameters,
//       },
//     });
//   } catch (error) {
//     console.error("createWebRtcTransport error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportConnectHandler = async (socket, sessionId, transportId, dtlsParameters, callback) => {
//   try {
//     console.log("transport-connect for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     await transport.connect({ dtlsParameters });
//     callback({ success: true });
//   } catch (error) {
//     console.error("transport-connect error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportProduceHandler = async (socket, sessionId, transportId, kind, rtpParameters, appData, callback) => {
//   try {
//     console.log("transport-produce for transport:", transportId, "kind:", kind, "source:", appData?.source);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: appData?.source || 'camera'
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("transport-produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumeHandler = async (socket, sessionId, transportId, producerId, rtpCapabilities, callback) => {
//   try {
//     console.log("consume for producer:", producerId, "transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) {
//       console.log("❌ Router not found for session:", sessionId);
//       return callback({ error: "Router not found" });
//     }

//     const producer = state.producers.get(producerId);
//     if (!producer) {
//       console.log("❌ Producer not found:", producerId);
//       return callback({ error: "Producer not found" });
//     }

//     if (!state.router.canConsume({ producerId, rtpCapabilities })) {
//       console.log("❌ Cannot consume - router.canConsume returned false");
//       return callback({ error: "Cannot consume" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) {
//       console.log("❌ Transport not found:", transportId);
//       return callback({ error: "Transport not found" });
//     }

//     const consumer = await transport.consume({
//       producerId,
//       rtpCapabilities,
//       paused: true,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//       },
//     });

//     state.consumers.set(consumer.id, consumer);
//     console.log("✅ Consumer created:", consumer.id);

//     callback({
//       params: {
//         id: consumer.id,
//         producerId,
//         kind: consumer.kind,
//         rtpParameters: consumer.rtpParameters,
//       },
//     });
//   } catch (error) {
//     console.error("consume error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumerResumeHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-resume for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     await consumer.resume();
//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-resume error:", error);
//     callback({ error: error.message });
//   }
// };

// const getProducersHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getProducers for session:", sessionId);
//     const state = roomState.get(sessionId);
//     callback(state ? Array.from(state.producers.keys()) : []);
//   } catch (error) {
//     console.error("getProducers error:", error);
//     callback([]);
//   }
// };
// const getProducerInfoHandler = async (socket, sessionId, producerId, callback) => {
//   try {
//     console.log("getProducerInfo for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback(null);

//     const producer = state.producers.get(producerId);
//     if (!producer) return callback(null);

//     callback({
//       id: producer.id,
//       kind: producer.kind,
//       userId: socket.data?.userId,
//       socketId: producer.appData?.socketId,
//       source: producer.appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("getProducerInfo error:", error);
//     callback(null);
//   }
// };

// const consumerReadyHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-ready for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-ready error:", error);
//     callback({ error: error.message });
//   }
// };

// const offerHandler = (socket, sessionId, targetSocketId, sdp) => {
//   console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || state.streamerSocketId !== socket.id) return;
//   safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
// };

// const answerHandler = (socket, sessionId, sdp) => {
//   console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta || meta.role === ROLE_MAP.STREAMER) return;

//   safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
// };

// const iceCandidateHandler = (socket, sessionId, targetSocketId, candidate) => {
//   console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;
//   safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
// };

// const whiteboardEventHandler = (socket, sessionId, type, data, patch) => {
//   console.log(`Whiteboard ${type} from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit(`whiteboard_${type}`, { 
//     userId: meta.userId, 
//     [`${type}Data`]: data 
//   });
  
//   scheduleFlush(sessionId, { type, payload: data, patch, at: new Date() });
// };

// const whiteboardUndoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const undoStack = wb.undoStack || [];
//   if (undoStack.length === 0) return;

//   const last = undoStack.pop();
//   wb.undoStack = undoStack.slice(-500);
//   wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_undo_applied", { last });
//   console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardRedoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const redoStack = wb.redoStack || [];
//   if (redoStack.length === 0) return;

//   const last = redoStack.pop();
//   wb.redoStack = redoStack.slice(-500);
//   wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_redo_applied", { last });
//   console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardSaveCanvasHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
//   await flushCanvasOps(sessionId).catch(err => {
//     console.error(`Error saving canvas for session ${sessionId}:`, err);
//   });
//   socket.emit("whiteboard_saved");
//   console.log(`Whiteboard saved for session: ${sessionId}`);
// };

// const cursorUpdateHandler = (socket, sessionId, position) => {
//   console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
// };

// const whiteboardStateRequestHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   socket.emit("whiteboard_state_sync", {
//     canvasData: wb.canvasData,
//     participants: wb.participants,
//     versionHistory: wb.versionHistory,
//   });
  
//   console.log(`Whiteboard state sent to socket: ${socket.id}`);
// };

// export const setupIntegratedSocket = async (server) => {
//   console.log("Setting up integrated socket");

//   try {
//     mediasoupWorker = await createMediasoupWorker();
//   } catch (error) {
//     console.error("Failed to initialize Mediasoup:", error);
//     throw error;
//   }

//   const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5174";
//   io = new Server(server, {
//     cors: {
//       origin: corsOrigin,
//       methods: ["GET", "POST"],
//       credentials: true,
//     },
//   });

//   console.log(`Socket.io configured with CORS origin: ${corsOrigin} for ${process.env.NODE_ENV} environment`);

//   io.on("connection", (socket) => {
//     console.log("New client connected:", socket.id);

//     // ====== NEW EVENT HANDLERS ADDED ======
//     // These events will forward messages to all clients in the room
//     socket.on("new-producer", (data) => {
//       console.log("New producer event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("new-producer", data);
//     });
    
//     socket.on("viewer-audio-enabled", (data) => {
//       console.log("Viewer audio enabled event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("viewer-audio-enabled", data);
//     });
    
//     socket.on("screen-share-started-by-viewer", (data) => {
//       console.log("Screen share started by viewer event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("screen-share-started-by-viewer", data);
//     });

//     // NEW: Handle streamer consuming viewer screen
//     socket.on("streamer-consume-viewer-screen", (data) => 
//       handleStreamerConsumeViewerScreen(socket, data.sessionId, data.producerId)
//     );
//     // ====== END OF NEW EVENT HANDLERS ======

//     // ====== PERMISSION AND MEDIA EVENT HANDLERS ======
//    // yeh tumhara existing call hai
// socket.on("viewer-audio-response", (data) => {
//   handleViewerAudioResponse(
//     socket,
//     data.sessionId,
//     data.requesterSocketId,
//     data.allow
//   );
// });

    
//     socket.on("viewer-video-response", (data) => 
//       handleViewerVideoResponse(socket, data.sessionId, data.requesterSocketId, data.allow)
//     );
    
//     socket.on("screen-share-response", (data) => 
//       handleScreenShareResponse(socket, data.sessionId, data.requesterUserId, data.allow)
//     );
    
//     socket.on("screen-share-force-stop", (data) => 
//       handleStreamerStopScreenShare(socket, data.sessionId, data.targetUserId)
//     );
    
//     socket.on("viewer-audio-muted", (data) => 
//       handleViewerAudioMuted(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-video-muted", (data) => 
//       handleViewerVideoMuted(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-audio-started", (data) => 
//       handleViewerAudioStarted(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-video-started", (data) => 
//       handleViewerVideoStarted(socket, data.sessionId, data)
//     );
    
//     socket.on("screen-share-started-by-viewer", (data) => 
//       handleScreenShareStartedByViewer(socket, data.sessionId, data)
//     );
    
//     socket.on("screen-share-stopped-by-viewer", (data) => 
//       handleViewerScreenShareStop(socket, data.sessionId, data.userId)
//     );
    
//     socket.on("viewer-audio-enabled", (data) => 
//       handleViewerAudioEnabled(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-video-enabled", (data) => 
//       handleViewerVideoEnabled(socket, data.sessionId, data)
//     );

//     // Room and chat events
//     socket.on("join_room", (data) => joinRoomHandler(socket, data));
//     socket.on("chat_message", (data) => chatHandler(socket, data.sessionId, data.message));
//     socket.on("streamer_control", (data) => streamerControlHandler(socket, data));
    
//     // Participant management events
//     socket.on("get_participants", (data, cb) => 
//       getParticipantsHandler(socket, data.sessionId, cb)
//     );
    
//     socket.on("update_participant_status", (data) => 
//       updateParticipantStatusHandler(socket, data.sessionId, data.updates)
//     );
    
//     // Screen share events
//     socket.on("screen-share-request", (data) => 
//       handleScreenShareRequest(socket, data.sessionId)
//     );
    
//     // Producer control events
//     socket.on("producer-pause", (data) => 
//       producerPauseHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-resume", (data) => 
//       producerResumeHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-close", (data) => 
//       producerCloseHandler(socket, data.sessionId, data.producerId)
//     );
    
//     // Mediasoup events
//     socket.on("getRouterRtpCapabilities", (data, cb) => 
//       getRouterRtpCapabilitiesHandler(socket, data.sessionId, cb));
    
//     socket.on("createWebRtcTransport", (data, cb) => 
//       createWebRtcTransportHandler(socket, data.sessionId, cb));
    
//     socket.on("transport-connect", (data, cb) =>
//       transportConnectHandler(socket, data.sessionId, data.transportId, data.dtlsParameters, cb)
//     );
    
//     socket.on("transport-produce", (data, cb) =>
//       transportProduceHandler(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, data.appData, cb)
//     );
    
//     // Screen share specific event (for streamer)
//     socket.on("transport-produce-screen", (data, cb) =>
//       handleScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//     );

//     // Viewer audio events
//     socket.on("viewer-audio-request", (data) => 
//       handleViewerAudioRequest(socket, data.sessionId)
//     );

//     socket.on("viewer-video-request", (data) => 
//       handleViewerVideoRequest(socket, data.sessionId)
//     );

//     socket.on("transport-produce-viewer-audio", (data, cb) =>
//       handleViewerAudioProduce(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     socket.on("transport-produce-viewer-video", (data, cb) =>
//       handleViewerVideoProduce(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     // Add this to your socket event handlers
//     socket.on("transport-produce-viewer-screen-audio", (data, cb) =>
//       handleViewerScreenShareAudio(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     socket.on("viewer-audio-mute", (data) => 
//       handleViewerAudioMute(socket, data.sessionId, data.targetSocketId)
//     );
    
//     socket.on("viewer-video-mute", (data) => 
//       handleViewerVideoMute(socket, data.sessionId, data.targetSocketId)
//     );
    
//     // Viewer screen share events
//     socket.on("transport-produce-viewer-screen", (data, cb) =>
//       handleViewerScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//     );

//     socket.on("screen-share-stop", (data) => 
//       handleViewerScreenShareStop(socket, data.sessionId)
//     );
        
//     socket.on("consume", (data, cb) =>
//       consumeHandler(socket, data.sessionId, data.transportId, data.producerId, data.rtpCapabilities, cb)
//     );
    
//     socket.on("consumer-resume", (data, cb) =>
//       consumerResumeHandler(socket, data.sessionId, data.consumerId, cb)
//     );
    
//     socket.on("getProducers", (data, cb) =>
//       getProducersHandler(socket, data.sessionId, cb)
//     );
    
//     socket.on("getProducerInfo", (data, cb) =>
//       getProducerInfoHandler(socket, data.sessionId, data.producerId, cb)
//     );
    
//     socket.on("consumer-ready", (data, cb) =>
//       consumerReadyHandler(socket, data.sessionId, data.consumerId, cb)
//     );

//     // Whiteboard events
//     socket.on("whiteboard_draw", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "draw", data.drawData, data.patch)
//     );
    
//     socket.on("whiteboard_erase", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "erase", data.eraseData, data.patch)
//     );
    
//     socket.on("whiteboard_undo", (data) => 
//       whiteboardUndoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_redo", (data) => 
//       whiteboardRedoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_save", (data) => 
//       whiteboardSaveCanvasHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_cursor", (data) => 
//       cursorUpdateHandler(socket, data.sessionId, data.position)
//     );
    
//     socket.on("whiteboard_state_request", (data) => 
//       whiteboardStateRequestHandler(socket, data.sessionId)
//     );

//     // WebRTC events
//     socket.on("offer", (data) => 
//       offerHandler(socket, data.sessionId, data.targetSocketId, data.sdp)
//     );
    
//     socket.on("answer", (data) => 
//       answerHandler(socket, data.sessionId, data.sdp)
//     );
    
//     socket.on("ice-candidate", (data) => 
//       iceCandidateHandler(socket, data.sessionId, data.targetSocketId, data.candidate)
//     );

//     socket.on("disconnect", () => cleanupSocketFromRoom(socket));
//   });

//   console.log("✅ Socket.io setup complete with screen share permission system");
//   return io;
// };

// // ====== MISSING HANDLER IMPLEMENTATIONS ======

// const handleViewerAudioMuted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio muted:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasAudio: false }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-audio-muted-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer audio muted error:", error);
//   }
// };

// const handleViewerVideoMuted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer video muted:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasVideo = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasVideo: false }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-video-muted-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer video muted error:", error);
//   }
// };

// const handleViewerAudioStarted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio started:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = true;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasAudio: true }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-audio-started-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer",
//       socketId: socket.id
//     });
//   } catch (error) {
//     console.error("Viewer audio started error:", error);
//   }
// };

// const handleViewerVideoStarted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer video started:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasVideo = true;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasVideo: true }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-video-started-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer",
//       socketId: socket.id
//     });
//   } catch (error) {
//     console.error("Viewer video started error:", error);
//   }
// };

// const handleScreenShareStartedByViewer = async (socket, sessionId, data) => {
//   try {
//     console.log("Screen share started by viewer:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.isScreenSharing = true;
//       // Forward to all other participants in the room
//       socket.to(sessionId).emit("screen-share-started-by-viewer", data);
//     }
//   } catch (error) {
//     console.error("Screen share started by viewer error:", error);
//   }
// };

// const handleViewerAudioEnabled = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio enabled:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = true;
//       // Forward to all other participants in the room
//       socket.to(sessionId).emit("viewer-audio-enabled", data);
//     }
//   } catch (error) {
//     console.error("Viewer audio enabled error:", error);
//   }
// };

// const handleViewerVideoEnabled = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer video enabled:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasVideo = true;
//       // Forward to all other participants in the room
//       socket.to(sessionId).emit("viewer-video-enabled", data);
//     }
//   } catch (error) {
//     console.error("Viewer video enabled error:", error);
//   }
// };

// // Export functions as named exports
// export { getIO };






















// import { Server } from "socket.io";
// import { createMediasoupWorker, getIceServersFromEnv, safeEmit } from "./socketUtils/index.js";
// import { roomState } from "./socketState/roomState.js";
// import * as handlers from "./socketHandlers/index.js";

// // ======= Global Variables =======
// let io;
// let mediasoupWorker;

// // ======= Utility Functions =======
// const getIO = () => {
//   if (!io) throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
//   return io;
// };

// // ======= Setup Socket.io =======
// export const setupIntegratedSocket = async (server) => {
//   console.log("Setting up integrated socket");

//   try {
//     mediasoupWorker = await createMediasoupWorker();
//   } catch (error) {
//     console.error("Failed to initialize Mediasoup:", error);
//     throw error;
//   }

//   const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5174";
//   io = new Server(server, {
//     cors: {
//       origin: corsOrigin,
//       methods: ["GET", "POST"],
//       credentials: true,
//     },
//   });

//   console.log(`Socket.io configured with CORS origin: ${corsOrigin} for ${process.env.NODE_ENV} environment`);

//   io.on("connection", (socket) => {
//     console.log("New client connected:", socket.id);

//     // Room and chat events
//     socket.on("join_room", (data) => handlers.joinRoomHandler(socket, data, io, roomState, mediasoupWorker));
//     socket.on("chat_message", (data) => handlers.chatHandler(socket, data.sessionId, data.message, io, roomState));
//     socket.on("streamer_control", (data) => handlers.streamerControlHandler(socket, data, io, roomState));
    
//     // Producer control events
//     socket.on("producer-pause", (data) =>
//       handlers.producerPauseHandler(socket, data.sessionId, data.producerId, roomState)
//     );
//     socket.on("producer-resume", (data) =>
//       handlers.producerResumeHandler(socket, data.sessionId, data.producerId, roomState)
//     );
//     socket.on("producer-close", (data) =>
//       handlers.producerCloseHandler(socket, data.sessionId, data.producerId, roomState)
//     );
    
//     // Mediasoup events
//     socket.on("getRouterRtpCapabilities", (data, cb) =>
//       handlers.getRouterRtpCapabilitiesHandler(socket, data.sessionId, cb, roomState));
    
//     socket.on("createWebRtcTransport", (data, cb) =>
//       handlers.createWebRtcTransportHandler(socket, data.sessionId, cb, roomState));
    
//     socket.on("transport-connect", (data, cb) =>
//       handlers.transportConnectHandler(socket, data.sessionId, data.transportId, data.dtlsParameters, cb, roomState)
//     );
    
//     socket.on("transport-produce", (data, cb) =>
//       handlers.transportProduceHandler(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, data.appData, cb, roomState)
//     );
    
//     // Screen share specific event
//     socket.on("transport-produce-screen", (data, cb) =>
//       handlers.handleScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb, roomState)
//     );
    
//     socket.on("consume", (data, cb) =>
//       handlers.consumeHandler(socket, data.sessionId, data.transportId, data.producerId, data.rtpCapabilities, cb, roomState)
//     );
    
//     socket.on("consumer-resume", (data, cb) =>
//       handlers.consumerResumeHandler(socket, data.sessionId, data.consumerId, cb, roomState)
//     );
    
//     socket.on("getProducers", (data, cb) =>
//       handlers.getProducersHandler(socket, data.sessionId, cb, roomState)
//     );
    
//     socket.on("getProducerInfo", (data, cb) =>
//       handlers.getProducerInfoHandler(socket, data.sessionId, data.producerId, cb, roomState)
//     );
    
//     socket.on("consumer-ready", (data, cb) =>
//       handlers.consumerReadyHandler(socket, data.sessionId, data.consumerId, cb, roomState)
//     );

//     // Whiteboard events
//     socket.on("whiteboard_draw", (data) =>
//       handlers.whiteboardEventHandler(socket, data.sessionId, "draw", data.drawData, data.patch, io, roomState)
//     );
    
//     socket.on("whiteboard_erase", (data) =>
//       handlers.whiteboardEventHandler(socket, data.sessionId, "erase", data.eraseData, data.patch, io, roomState)
//     );
    
//     socket.on("whiteboard_undo", (data) =>
//       handlers.whiteboardUndoHandler(socket, data.sessionId, io, roomState)
//     );
    
//     socket.on("whiteboard_redo", (data) =>
//       handlers.whiteboardRedoHandler(socket, data.sessionId, io, roomState)
//     );
    
//     socket.on("whiteboard_save", (data) =>
//       handlers.whiteboardSaveCanvasHandler(socket, data.sessionId, roomState)
//     );
    
//     socket.on("whiteboard_cursor", (data) =>
//       handlers.cursorUpdateHandler(socket, data.sessionId, data.position, io, roomState)
//     );
    
//     socket.on("whiteboard_state_request", (data) =>
//       handlers.whiteboardStateRequestHandler(socket, data.sessionId, roomState)
//     );

//     // WebRTC events
//     socket.on("offer", (data) =>
//       handlers.offerHandler(socket, data.sessionId, data.targetSocketId, data.sdp, io, roomState)
//     );
    
//     socket.on("answer", (data) =>
//       handlers.answerHandler(socket, data.sessionId, data.sdp, io, roomState)
//     );
    
//     socket.on("ice-candidate", (data) =>
//       handlers.iceCandidateHandler(socket, data.sessionId, data.targetSocketId, data.candidate, io, roomState)
//     );

//     socket.on("transport-produce-screen", (data, cb) =>
//       handlers.handleScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb, roomState)
//     );

//     socket.on("disconnect", () => handlers.cleanupSocketFromRoom(socket, io, roomState));
//   });

//   console.log("✅ Socket.io setup complete with enhanced producer control and screen sharing support");
//   return io;
// };

// // Export functions as named exports
// export { getIO };




// working code stremer or viewer live strem with stremter to viewer all feature are worked;
// // from audio viewer and streamer
// import { Server } from "socket.io";
// import jwt from "jsonwebtoken";
// import mediasoup from "mediasoup";
// import liveSession from "../model/liveSessions/liveeSession.model.js";
// import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
// import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
// import { ROLE_MAP } from "../constant/role.js";
// import authenticationModel from "../../app/model/Authentication/authentication.model.js";

// // ======= Global Variables =======
// let io;
// let mediasoupWorker;
// const roomState = new Map();

// // ======= Utility Functions =======
// const getIO = () => {
//   if (!io) throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
//   return io;
// };

// const safeEmit = (toSocketId, event, payload) => {
//   try {
//     const s = io.sockets.sockets.get(toSocketId);
//     if (s) {
//       s.emit(event, payload);
//       console.log(`Emitted ${event} to socket: ${toSocketId}`);
//     } else {
//       console.log(`Socket not found: ${toSocketId}`);
//     }
//   } catch (err) {
//     console.error("safeEmit error:", err);
//   }
// };

// const getIceServersFromEnv = () => {
//   const isProduction = process.env.NODE_ENV === "production";

//   const servers = [];
//   const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
//     .split(",")
//     .map(s => s.trim())
//     .filter(Boolean);
//   stunUrls.forEach(url => { if (url) servers.push({ urls: url }); });

//   if (isProduction) {
//     const turnUrls = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//     const turnUsername = process.env.TURN_USERNAME;
//     const turnPassword = process.env.TURN_PASSWORD;

//     turnUrls.forEach(url => {
//       if (url && turnUsername && turnPassword) {
//         servers.push({
//           urls: url,
//           username: turnUsername,
//           credential: turnPassword
//         });
//       }
//     });
//   }
//   if (servers.length === 0) {
//     servers.push({ urls: "stun:stun.l.google.com:19302" });
//     servers.push({ urls: "stun:global.stun.twilio.com:3478" });
//   }

//   return servers;
// };

// const createMediasoupWorker = async () => {
//   try {
//     const minPort = parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000;
//     const maxPort = parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999;
//     const logLevel = process.env.MEDIASOUP_LOG_LEVEL || "warn";

//     mediasoupWorker = await mediasoup.createWorker({
//       logLevel,
//       rtcMinPort: minPort,
//       rtcMaxPort: maxPort,
//     });

//     console.log(`Mediasoup Worker Created (Ports: ${minPort}-${maxPort}) for ${process.env.NODE_ENV} environment`);

//     mediasoupWorker.on("died", () => {
//       console.error("Mediasoup worker died, restarting in 2 seconds...");
//       setTimeout(() => createMediasoupWorker().catch(console.error), 2000);
//     });

//     return mediasoupWorker;
//   } catch (error) {
//     console.error("Failed to create Mediasoup worker:", error);
//     throw error;
//   }
// };

// const flushCanvasOps = async (sessionId) => {
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
  
//   if (state.flushTimer) {
//     clearTimeout(state.flushTimer);
//     state.flushTimer = null;
//   }

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
// };

// const scheduleFlush = (sessionId, op) => {
//   console.log(`Scheduling flush for session: ${sessionId}, operation type: ${op?.type}`);
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
  
//   state.flushTimer = setTimeout(() => {
//     flushCanvasOps(sessionId).catch(err => {
//       console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
//     });
//   }, 2000);
  
//   console.log(`Flush scheduled for session: ${sessionId}`);
// };

// export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
//   console.log(`Initializing whiteboard RTC for session: ${sessionId}, whiteboard: ${whiteboardId}, createdBy: ${createdBy}`);
  
//   if (!roomState.has(sessionId)) {
//     roomState.set(sessionId, {
//       whiteboardId,
//       createdBy,
//       streamerSocketId: null,
//       viewers: new Set(),
//       sockets: new Map(),
//       participants: new Map(),
//       pendingScreenShareRequests: new Map(),
//       activeScreenShares: new Map(),
//       pendingOps: [],
//       flushTimer: null,
//       router: null,
//       transports: new Map(),
//       producers: new Map(),
//       consumers: new Map(),
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

// // ======= Producer Control Functions =======
// const pauseAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Pausing all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.pause();
//         console.log(`Producer ${producerId} paused`);
//         safeEmit(socketId, "producer-paused", { producerId });
//       } catch (error) {
//         console.error("Error pausing producer:", error);
//       }
//     }
//   }
// };

// const resumeAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Resuming all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.resume();
//         console.log(`Producer ${producerId} resumed`);
//         safeEmit(socketId, "producer-resumed", { producerId });
//       } catch (error) {
//         console.error("Error resuming producer:", error);
//       }
//     }
//   }
// };

// const producerPauseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-pause for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.pause();
//       socket.emit("producer-paused", { producerId });
//       console.log(`Producer ${producerId} paused`);
//     }
//   } catch (error) {
//     console.error("producer-pause error:", error);
//   }
// };

// const producerResumeHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-resume for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.resume();
//       socket.emit("producer-resumed", { producerId });
//       console.log(`Producer ${producerId} resumed`);
//     }
//   } catch (error) {
//     console.error("producer-resume error:", error);
//   }
// };

// const producerCloseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-close for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer) {
//       producer.close();
//       state.producers.delete(producerId);
//       console.log(`Producer ${producerId} closed and removed`);
//       socket.emit("producer-closed", { producerId });
//     }
//   } catch (error) {
//     console.error("producer-close error:", error);
//   }
// };

// // ======= Screen Share Functions =======
// const handleScreenShareRequest = async (socket, sessionId) => {
//   try {
//     console.log("Screen share request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     if (state.activeScreenShares.has(meta.userId)) {
//       socket.emit("screen-share-error", { message: "You already have an active screen share" });
//       return;
//     }

//     const user = await authenticationModel.findById(meta.userId).select("name");
    
//     state.pendingScreenShareRequests.set(meta.userId, {
//       userId: meta.userId,
//       socketId: socket.id,
//       userName: user?.name || "Viewer",
//       requestedAt: new Date()
//     });

//     safeEmit(state.streamerSocketId, "screen-share-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: user?.name || "Viewer"
//     });

//     socket.emit("screen-share-request-sent");
//   } catch (error) {
//     console.error("Screen share request error:", error);
//     socket.emit("screen-share-error", { message: "Failed to send screen share request" });
//   }
// };

// const handleScreenShareResponse = async (socket, sessionId, requesterIdentifier, allow) => {
//   try {
//     console.log("Screen share response from streamer:", allow, "for:", requesterIdentifier);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find the request by socketId or userId
//     let request;
    
//     // First try to find by socketId (shorter ID)
//     if (requesterIdentifier && requesterIdentifier.length < 24) {
//       for (const [userId, req] of state.pendingScreenShareRequests) {
//         if (req.socketId === requesterIdentifier) {
//           request = req;
//           break;
//         }
//       }
//     } 
//     // If not found, try by userId
//     if (!request) {
//       request = state.pendingScreenShareRequests.get(requesterIdentifier);
//     }

//     if (!request) {
//       console.log("No pending screen share request found for:", requesterIdentifier);
//       return;
//     }

//     state.pendingScreenShareRequests.delete(request.userId);

//     safeEmit(request.socketId, "screen-share-response", {
//       allowed: allow,
//       message: allow ? "You can now share your screen" : "Streamer denied your screen share request"
//     });

//     if (allow) {
//       // Add to active screen shares
//       state.activeScreenShares.set(request.userId, {
//         userId: request.userId,
//         socketId: request.socketId,
//         userName: request.userName,
//         startedAt: new Date()
//       });
      
//       // Update participant status
//       const participant = state.participants.get(request.userId);
//       if (participant) {
//         participant.isScreenSharing = true;
//         io.to(sessionId).emit("participant_updated", {
//           userId: request.userId,
//           updates: { isScreenSharing: true }
//         });
//       }
      
//       // Notify all participants that screen share is starting
//       io.to(sessionId).emit("screen-share-started-by-viewer", {
//         userId: request.userId,
//         userName: request.userName,
//         socketId: request.socketId
//       });
//     }
//   } catch (error) {
//     console.error("Screen share response error:", error);
//   }
// };
// const handleViewerScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return callback({ error: "Unauthorized" });

//     if (!state.activeScreenShares.has(meta.userId)) {
//       return callback({ error: "No screen share permission" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-screen',
//         userId: meta.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // Notify all participants about the new screen share producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen'
//     });

//     callback({ id: producer.id });

//     producer.on("transportclose", () => {
//       console.log("Viewer screen share producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     producer.on("trackended", () => {
//       console.log("Viewer screen share track ended:", producer.id);
//       handleViewerScreenShareStop(socket, sessionId, meta.userId);
//     });

//   } catch (error) {
//     console.error("Viewer screen share start error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerScreenShareStop = async (socket, sessionId, userId = null) => {
//   try {
//     console.log("Viewer screen share stop from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const targetUserId = userId || socket.data?.userId;
//     if (!targetUserId) return;

//     state.activeScreenShares.delete(targetUserId);

//     const participant = state.participants.get(targetUserId);
//     if (participant) {
//       participant.isScreenSharing = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: targetUserId,
//         updates: { isScreenSharing: false }
//       });
//     }

//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.userId === targetUserId && producer.appData?.source === 'viewer-screen') {
//         try {
//           producer.close();
//           state.producers.delete(producerId);
//           console.log(`Screen share producer ${producerId} closed`);
//         } catch (e) {
//           console.warn("Error closing screen share producer:", e);
//         }
//       }
//     }

//     io.to(sessionId).emit("screen-share-stopped-by-viewer", {
//       userId: targetUserId
//     });

//     console.log(`Screen share stopped for user: ${targetUserId}`);
//   } catch (error) {
//     console.error("Viewer screen share stop error:", error);
//   }
// };

// const handleStreamerStopScreenShare = async (socket, sessionId, targetUserId) => {
//   try {
//     console.log("Streamer stopping screen share for user:", targetUserId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const targetSocket = state.participants.get(targetUserId)?.socketId;
//     if (!targetSocket) return;

//     safeEmit(targetSocket, "screen-share-force-stop", {
//       message: "Streamer stopped your screen share"
//     });

//     await handleViewerScreenShareStop(null, sessionId, targetUserId);

//   } catch (error) {
//     console.error("Streamer stop screen share error:", error);
//   }
// };

// // ======= Participant Management Functions =======
// const getParticipantsHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getParticipants for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback([]);
    
//     const participants = Array.from(state.participants.values());
//     callback(participants);
//   } catch (error) {
//     console.error("getParticipants error:", error);
//     callback([]);
//   }
// };

// const updateParticipantStatusHandler = async (socket, sessionId, updates) => {
//   try {
//     console.log("updateParticipantStatus for session:", sessionId, "updates:", updates);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       Object.assign(participant, updates);
      
//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates
//       });
//     }
//   } catch (error) {
//     console.error("updateParticipantStatus error:", error);
//   }
// };

// const cleanupSocketFromRoom = async (socket) => {
//   console.log(`Cleanup requested for socket: ${socket.id}`);
//   try {
//     const sid = socket.data?.sessionId;
//     if (!sid) {
//       console.log(`No session ID found for socket: ${socket.id}`);
//       return;
//     }
    
//     const state = roomState.get(sid);
//     if (!state) {
//       console.log(`No state found for session: ${sid}`);
//       return;
//     }

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.log(`No metadata found for socket: ${socket.id}`);
//       return;
//     }

//     if (state.pendingScreenShareRequests.has(meta.userId)) {
//       state.pendingScreenShareRequests.delete(meta.userId);
//     }

//     if (state.activeScreenShares.has(meta.userId)) {
//       await handleViewerScreenShareStop(socket, sid, meta.userId);
//     }

//     for (const [consumerId, consumer] of state.consumers) {
//       try {
//         if (consumer?.appData?.socketId === socket.id) {
//           consumer.close();
//           state.consumers.delete(consumerId);
//           console.log(`Consumer ${consumerId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Consumer cleanup error:", e);
//       }
//     }

//     for (const [transportId, transport] of state.transports) {
//       try {
//         if (transport?.appData?.socketId === socket.id) {
//           transport.close();
//           state.transports.delete(transportId);
//           console.log(`Transport ${transportId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Transport cleanup error:", e);
//       }
//     }

//     for (const [producerId, producer] of state.producers) {
//       try {
//         if (producer?.appData?.socketId === socket.id) {
//           if (meta.role === ROLE_MAP.STREAMER) {
//             await producer.pause();
//             console.log(`Producer ${producerId} paused during cleanup (streamer)`);
//           } else {
//             producer.close();
//             state.producers.delete(producerId);
//             console.log(`Producer ${producerId} closed and removed (viewer)`);
//           }
//         }
//       } catch (e) {
//         console.warn("Producer cleanup error:", e);
//       }
//     }

//     if (meta.userId) {
//       state.participants.delete(meta.userId);
      
//       io.to(sid).emit("participant_left", {
//         userId: meta.userId,
//         socketId: socket.id
//       });
//     }

//     if (state.whiteboardId) {
//       console.log(`Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`);
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb) {
//         const participant = wb.participants.find(p => p.user.toString() === meta.userId);
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//         }
//         await wb.save();
//         console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
//       }
//     }

//     if (meta.role !== ROLE_MAP.STREAMER) {
//       try {
//         const participant = await liveSessionParticipant.findOne({ 
//           $or: [
//             { sessionId: sid, userId: meta.userId },
//             { socketId: socket.id }
//           ]
//         });
        
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//           participant.isActiveDevice = false;
//           await participant.save();
//           console.log(`Participant ${meta.userId} marked as LEFT`);
//         }
//       } catch (e) {
//         console.error("cleanup update error:", e?.message || e);
//       }

//       state.viewers.delete(socket.id);
//       io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
//       console.log(`Viewer ${socket.id} left room ${sid}`);
//     } else {
//       console.log(`Streamer ${socket.id} left room ${sid}`);
      
//       if (state.streamerSocketId === socket.id) {
//         state.streamerSocketId = null;
//         console.log(`Cleared streamerSocketId for session: ${sid}`);
//       }

//       const session = await liveSession.findOne({ sessionId: sid });
//       if (session) {
//         session.status = "PAUSED";
//         await session.save();
//         console.log(`Session ${sid} paused due to streamer leaving`);
//       }

//       io.to(sid).emit("session_paused_or_ended_by_streamer");
//     }

//     state.sockets.delete(socket.id);
//     socket.leave(sid);
//     console.log(`Socket ${socket.id} removed from room state for session: ${sid}`);

//     if (state.sockets.size === 0) {
//       if (state.pendingOps && state.pendingOps.length > 0) {
//         await flushCanvasOps(sid).catch(err => {
//           console.error(`Error flushing canvas ops during cleanup for session ${sid}:`, err);
//         });
//       }

//       if (state.flushTimer) clearTimeout(state.flushTimer);
      
//       if (state.router) {
//         try {
//           state.router.close();
//           console.log(`Mediasoup router closed for session: ${sid}`);
//         } catch (e) {
//           console.warn("Error closing router:", e);
//         }
//         state.router = null;
//       }
      
//       roomState.delete(sid);
//       console.log(`Room state cleaned up for session: ${sid}`);
//     }
//   } catch (e) {
//     console.error("cleanupSocketFromRoom error:", e?.message || e);
//   }
// };

// const handleScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'screen'
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Screen share producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     socket.to(sessionId).emit("screen-share-started", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
    
//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
//   } catch (error) {
//     console.error("Screen share start error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerAudioProduce = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer audio produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-mic',
//         userId: socket.data.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // Notify all participants about the new audio producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'viewer-mic'
//     });

//     callback({ id: producer.id });

//     const meta = state.sockets.get(socket.id);
//     if (meta) {
//       const participant = state.participants.get(meta.userId);
//       if (participant) {
//         participant.hasAudio = true;
//         io.to(sessionId).emit("participant_updated", {
//           userId: meta.userId,
//           updates: { hasAudio: true }
//         });
//       }
//     }

//     producer.on("transportclose", () => {
//       console.log("Viewer audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer audio produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerAudioRequest = async (socket, sessionId) => {
//   try {
//     console.log("Viewer audio permission request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const user = await authenticationModel.findById(meta.userId).select("name");
    
//     safeEmit(state.streamerSocketId, "viewer-audio-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: user?.name || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer audio request error:", error);
//   }
// };

// // const handleViewerAudioResponse = async (socket, sessionId, requesterSocketId, allow) => {
// //   try {
// //     console.log("Viewer audio response from streamer:", allow);
// //     const state = roomState.get(sessionId);
// //     if (!state) return;

// //     safeEmit(requesterSocketId, "viewer-audio-response", {
// //       allowed: allow,
// //       message: allow ? "You can now speak" : "Streamer denied your audio request"
// //     });

// //     if (allow) {
// //       const viewerMeta = state.sockets.get(requesterSocketId);
// //       if (viewerMeta) {
// //         const participant = state.participants.get(viewerMeta.userId);
// //         if (participant) {
// //           participant.hasAudio = true;
// //           io.to(sessionId).emit("participant_updated", {
// //             userId: viewerMeta.userId,
// //             updates: { hasAudio: true }
// //           });
// //         }
// //       }
// //     }
// //   } catch (error) {
// //     console.error("Viewer audio response error:", error);
// //   }
// // };
// const handleViewerAudioResponse = async (socket, sessionId, requesterIdentifier, allow) => {
//   try {
//     console.log("Viewer audio response from streamer:", allow, "for:", requesterIdentifier);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find socketId - handle both socketId and userId input
//     let requesterSocketId = requesterIdentifier;
    
//     // If it looks like a userId (ObjectId format), find the socketId
//     if (requesterIdentifier && requesterIdentifier.length === 24 && /^[0-9a-fA-F]+$/.test(requesterIdentifier)) {
//       for (const [sockId, meta] of state.sockets) {
//         if (meta.userId === requesterIdentifier) {
//           requesterSocketId = sockId;
//           break;
//         }
//       }
//     }

//     if (!requesterSocketId) {
//       console.log("Could not find socketId for requester:", requesterIdentifier);
//       return;
//     }

//     safeEmit(requesterSocketId, "viewer-audio-response", {
//       allowed: allow,
//       message: allow ? "You can now speak" : "Streamer denied your audio request"
//     });

//     if (allow) {
//       const viewerMeta = state.sockets.get(requesterSocketId);
//       if (viewerMeta) {
//         const participant = state.participants.get(viewerMeta.userId);
//         if (participant) {
//           participant.hasAudio = true;
//           io.to(sessionId).emit("participant_updated", {
//             userId: viewerMeta.userId,
//             updates: { hasAudio: true }
//           });
          
//           // Emit global notification
//           io.to(sessionId).emit("viewer-audio-enabled", {
//             userId: viewerMeta.userId,
//             socketId: requesterSocketId,
//             userName: viewerMeta.userName
//           });
//         }
//       }
//     }
//   } catch (error) {
//     console.error("Viewer audio response error:", error);
//   }
// };
// const handleViewerAudioMute = async (socket, sessionId, targetSocketId) => {
//   try {
//     console.log("Muting viewer audio:", targetSocketId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.socketId === targetSocketId && 
//           producer.kind === "audio" && 
//           producer.appData?.source === 'viewer-mic') {
//         await producer.pause();
//         console.log(`Viewer audio producer ${producerId} muted`);
        
//         const viewerMeta = state.sockets.get(targetSocketId);
//         if (viewerMeta) {
//           const participant = state.participants.get(viewerMeta.userId);
//           if (participant) {
//             participant.hasAudio = false;
//             io.to(sessionId).emit("participant_updated", {
//               userId: viewerMeta.userId,
//               updates: { hasAudio: false }
//             });
//           }
//         }
        
//         safeEmit(targetSocketId, "viewer-audio-muted", {
//           producerId: producer.id,
//           mutedBy: socket.data.userId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Viewer audio mute error:", error);
//   }
// };

// const joinRoomHandler = async (socket, data) => {
//   const { token, sessionId, roomCode } = data;
//   console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);
  
//   try {
//     if (!token || (!sessionId && !roomCode)) {
//       return socket.emit("error_message", "Missing token or sessionId/roomCode");
//     }

//     let decoded;
//     try {
//       decoded = jwt.verify(token, process.env.SECRET_KEY);
//       console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
//     } catch (err) {
//       return socket.emit("error_message", "Invalid token");
//     }
    
//     const userId = decoded.userId;
//     const userRole = decoded.role;

//     let session;
//     if (sessionId) {
//       session = await liveSession.findOne({ sessionId });
//     } else {
//       session = await liveSession.findOne({ roomCode });
//     }

//     if (!session) return socket.emit("error_message", "Session not found");
//     if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
//       return socket.emit("error_message", `Session is ${session.status}`);
//     }

//     if (session.isPrivate) {
//       const allowed = Array.isArray(session.allowedUsers) && 
//         session.allowedUsers.some(u => u.toString() === userId);
//       if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
//     }

//     const sid = session.sessionId;
//     if (!roomState.has(sid)) {
//       roomState.set(sid, {
//         whiteboardId: session.whiteboardId || null,
//         createdBy: session.streamerId ? session.streamerId.toString() : null,
//         streamerSocketId: null,
//         viewers: new Set(),
//         sockets: new Map(),
//         participants: new Map(),
//         pendingScreenShareRequests: new Map(),
//         activeScreenShares: new Map(),
//         pendingOps: [],
//         flushTimer: null,
//         router: null,
//         transports: new Map(),
//         producers: new Map(),
//         consumers: new Map(),
//       });
//       console.log(`New room state created for session: ${sid}`);
//     }
    
//     const state = roomState.get(sid);

//     const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
//     const activeCount = await liveSessionParticipant.countDocuments({ 
//       sessionId: session._id, 
//       status: { $ne: "LEFT" } 
//     });
    
//     if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
//       return socket.emit("error_message", "Max participants limit reached");
//     }

//     let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
//     if (participant && participant.isBanned) {
//       return socket.emit("error_message", "You are banned from this session");
//     }

//     if (userRole === ROLE_MAP.STREAMER) {
//       if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
//         console.log(`Streamer reconnecting from ${state.streamerSocketId} to ${socket.id}`);
//         if (state.sockets.has(state.streamerSocketId)) {
//           state.sockets.delete(state.streamerSocketId);
//           state.viewers.delete(state.streamerSocketId);
//         }
//       }
//       state.streamerSocketId = socket.id;
//       console.log(`Streamer socket ID updated to: ${socket.id}`);
//     }

//     if (!participant) {
//       participant = await liveSessionParticipant.create({
//         sessionId: session._id,
//         userId,
//         socketId: socket.id,
//         status: "JOINED",
//         isActiveDevice: true,
//         joinedAt: new Date(),
//       });
//       session.totalJoins = (session.totalJoins || 0) + 1;
//       await session.save();
//       console.log(`New participant created, total joins: ${session.totalJoins}`);
//     } else {
//       participant.socketId = socket.id;
//       participant.status = "JOINED";
//       participant.isActiveDevice = true;
//       participant.joinedAt = new Date();
//       participant.leftAt = null;
//       await participant.save();
//     }

//     const user = await authenticationModel.findById(userId).select("name");
    
//     state.participants.set(userId, {
//       userId,
//       socketId: socket.id,
//       name: user?.name || "Unknown",
//       role: userRole,
//       joinedAt: new Date(),
//       isSpeaking: false,
//       hasAudio: false,
//       isScreenSharing: false,
//     });

//     if (userRole === ROLE_MAP.STREAMER && !state.router) {
//       console.log("Creating Mediasoup router for session:", sid);
//       const mediaCodecs = [
//         {
//           kind: "audio",
//           mimeType: "audio/opus",
//           clockRate: 48000,
//           channels: 2,
//         },
//         {
//           kind: "video",
//           mimeType: "video/VP8",
//           clockRate: 90000,
//           parameters: {
//             "x-google-start-bitrate": process.env.NODE_ENV === "production" ? 500000 : 1000000,
//           },
//         },
//       ];

//       state.router = await mediasoupWorker.createRouter({ mediaCodecs });
//       console.log("Mediasoup router created for session:", sid);
//     }

//     state.sockets.set(socket.id, { userId, role: userRole });
//     socket.data = { sessionId: sid, userId, role: userRole };
//     socket.join(sid);
//     console.log(`Socket ${socket.id} joined room ${sid}`);

//     const iceServers = getIceServersFromEnv();
//     socket.emit("ice_servers", iceServers);

//     io.to(sid).emit("participant_joined", {
//       userId,
//       name: user?.name || "Unknown",
//       role: userRole,
//       socketId: socket.id,
//       joinedAt: new Date(),
//       isSpeaking: false,
//       hasAudio: false,
//       isScreenSharing: false,
//     });

//     const currentParticipants = Array.from(state.participants.values());
//     socket.emit("participants_list", currentParticipants);

//     if (userRole === ROLE_MAP.STREAMER) {
//       socket.emit("joined_room", {
//         as: "STREAMER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys()),
//         pendingScreenShareRequests: Array.from(state.pendingScreenShareRequests.values()),
//         activeScreenShares: Array.from(state.activeScreenShares.values())
//       });
//       console.log(`Streamer ${socket.id} joined room ${sid}`);
//     } else {
//       state.viewers.add(socket.id);
//       socket.emit("joined_room", {
//         as: "VIEWER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         whiteboardId: state.whiteboardId,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys())
//       });
//       console.log(`Viewer ${socket.id} joined room ${sid}`);
      
//       if (state.streamerSocketId) {
//         safeEmit(state.streamerSocketId, "viewer_ready", { 
//           viewerSocketId: socket.id, 
//           viewerUserId: userId 
//         });
//       }
//     }

//     if (state.whiteboardId) {
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
//         wb.participants.push({ 
//           user: userId, 
//           role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", 
//           joinedAt: new Date() 
//         });
//         await wb.save();
//         console.log(`User added to whiteboard: ${state.whiteboardId}`);
//       }
//     }

//     const currentParticipantsCount = state.viewers.size + (state.streamerSocketId ? 1 : 0);
//     if ((session.peakParticipants || 0) < currentParticipantsCount) {
//       session.peakParticipants = currentParticipantsCount;
//       await session.save();
//       console.log(`New peak participants: ${currentParticipantsCount}`);
//     }
//   } catch (err) {
//     console.error("join_room error:", err);
//     socket.emit("error_message", "Invalid token/session");
//     throw err;
//   }
// };

// const chatHandler = async (socket, sessionId, message) => {
//   console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}`);
  
//   try {
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const sender = await authenticationModel.findById(meta.userId).select("name");
    
//     io.to(sessionId).emit("chat_message", {
//       userId: meta.userId,
//       name: sender?.name || "Unknown",
//       message,
//       socketId: socket.id,
//       at: new Date(),
//     });
    
//     console.log(`Chat message broadcast to session: ${sessionId}`);
//   } catch (err) {
//     console.error("chat_message error:", err);
//     throw err;
//   }
// };

// const streamerControlHandler = async (socket, data) => {
//   const { sessionId, status, emitEvent } = data;
//   console.log(`Streamer control request for session: ${sessionId}, status: ${status}`);
  
//   try {
//     const session = await liveSession.findOne({ sessionId });
//     if (!session) return;

//     if (status === "PAUSED") {
//       await pauseAllProducers(sessionId, socket.id);
//     } else if (status === "ACTIVE") {
//       await resumeAllProducers(sessionId, socket.id);
//     }

//     session.status = status;
//     if (status === "ACTIVE" && emitEvent === "streamer_started") {
//       session.actualStartTime = new Date();
//     }

//     await session.save();
//     io.to(sessionId).emit(emitEvent, { sessionId });
//     console.log(`Session ${sessionId} ${status.toLowerCase()} by streamer`);
//   } catch (err) {
//     console.error("streamer_control error:", err);
//     throw err;
//   }
// };

// const getRouterRtpCapabilitiesHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getRouterRtpCapabilities for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });
//     callback({ rtpCapabilities: state.router.rtpCapabilities });
//   } catch (error) {
//     console.error("getRouterRtpCapabilities error:", error);
//     callback({ error: error.message });
//   }
// };

// const createWebRtcTransportHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("createWebRtcTransport for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });

//     const transport = await state.router.createWebRtcTransport({
//       listenIps: [
//         {
//           ip: "0.0.0.0",
//           announcedIp: process.env.SERVER_IP || "127.0.0.1",
//         },
//       ],
//       enableUdp: true,
//       enableTcp: true,
//       preferUdp: true,
//       initialAvailableOutgoingBitrate: process.env.NODE_ENV === "production" ? 500000 : 1000000,
//     });

//     transport.on("dtlsstatechange", (dtlsState) => {
//       if (dtlsState === "closed") transport.close();
//     });

//     transport.appData = { socketId: socket.id };
//     state.transports.set(transport.id, transport);

//     callback({
//       params: {
//         id: transport.id,
//         iceParameters: transport.iceParameters,
//         iceCandidates: transport.iceCandidates,
//         dtlsParameters: transport.dtlsParameters,
//       },
//     });
//   } catch (error) {
//     console.error("createWebRtcTransport error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportConnectHandler = async (socket, sessionId, transportId, dtlsParameters, callback) => {
//   try {
//     console.log("transport-connect for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     await transport.connect({ dtlsParameters });
//     callback({ success: true });
//   } catch (error) {
//     console.error("transport-connect error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportProduceHandler = async (socket, sessionId, transportId, kind, rtpParameters, appData, callback) => {
//   try {
//     console.log("transport-produce for transport:", transportId, "kind:", kind, "source:", appData?.source);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: appData?.source || 'camera'
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("transport-produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumeHandler = async (socket, sessionId, transportId, producerId, rtpCapabilities, callback) => {
//   try {
//     console.log("consume for producer:", producerId, "transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) {
//       console.log("❌ Router not found for session:", sessionId);
//       return callback({ error: "Router not found" });
//     }

//     const producer = state.producers.get(producerId);
//     if (!producer) {
//       console.log("❌ Producer not found:", producerId);
//       return callback({ error: "Producer not found" });
//     }

//     if (!state.router.canConsume({ producerId, rtpCapabilities })) {
//       console.log("❌ Cannot consume - router.canConsume returned false");
//       return callback({ error: "Cannot consume" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) {
//       console.log("❌ Transport not found:", transportId);
//       return callback({ error: "Transport not found" });
//     }

//     const consumer = await transport.consume({
//       producerId,
//       rtpCapabilities,
//       paused: true,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//       },
//     });

//     state.consumers.set(consumer.id, consumer);
//     console.log("✅ Consumer created:", consumer.id);

//     callback({
//       params: {
//         id: consumer.id,
//         producerId,
//         kind: consumer.kind,
//         rtpParameters: consumer.rtpParameters,
//       },
//     });
//   } catch (error) {
//     console.error("consume error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumerResumeHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-resume for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     await consumer.resume();
//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-resume error:", error);
//     callback({ error: error.message });
//   }
// };

// const getProducersHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getProducers for session:", sessionId);
//     const state = roomState.get(sessionId);
//     callback(state ? Array.from(state.producers.keys()) : []);
//   } catch (error) {
//     console.error("getProducers error:", error);
//     callback([]);
//   }
// };
// const getProducerInfoHandler = async (socket, sessionId, producerId, callback) => {
//   try {
//     console.log("getProducerInfo for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback(null);

//     const producer = state.producers.get(producerId);
//     if (!producer) return callback(null);

//     callback({
//       id: producer.id,
//       kind: producer.kind,
//       userId: socket.data?.userId,
//       socketId: producer.appData?.socketId,
//       source: producer.appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("getProducerInfo error:", error);
//     callback(null);
//   }
// };

// const consumerReadyHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-ready for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-ready error:", error);
//     callback({ error: error.message });
//   }
// };

// const offerHandler = (socket, sessionId, targetSocketId, sdp) => {
//   console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || state.streamerSocketId !== socket.id) return;
//   safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
// };

// const answerHandler = (socket, sessionId, sdp) => {
//   console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta || meta.role === ROLE_MAP.STREAMER) return;

//   safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
// };

// const iceCandidateHandler = (socket, sessionId, targetSocketId, candidate) => {
//   console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;
//   safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
// };

// const whiteboardEventHandler = (socket, sessionId, type, data, patch) => {
//   console.log(`Whiteboard ${type} from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit(`whiteboard_${type}`, { 
//     userId: meta.userId, 
//     [`${type}Data`]: data 
//   });
  
//   scheduleFlush(sessionId, { type, payload: data, patch, at: new Date() });
// };

// const whiteboardUndoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const undoStack = wb.undoStack || [];
//   if (undoStack.length === 0) return;

//   const last = undoStack.pop();
//   wb.undoStack = undoStack.slice(-500);
//   wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_undo_applied", { last });
//   console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardRedoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const redoStack = wb.redoStack || [];
//   if (redoStack.length === 0) return;

//   const last = redoStack.pop();
//   wb.redoStack = redoStack.slice(-500);
//   wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_redo_applied", { last });
//   console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardSaveCanvasHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
//   await flushCanvasOps(sessionId).catch(err => {
//     console.error(`Error saving canvas for session ${sessionId}:`, err);
//   });
//   socket.emit("whiteboard_saved");
//   console.log(`Whiteboard saved for session: ${sessionId}`);
// };

// const cursorUpdateHandler = (socket, sessionId, position) => {
//   console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
// };

// const whiteboardStateRequestHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   socket.emit("whiteboard_state_sync", {
//     canvasData: wb.canvasData,
//     participants: wb.participants,
//     versionHistory: wb.versionHistory,
//   });
  
//   console.log(`Whiteboard state sent to socket: ${socket.id}`);
// };

// export const setupIntegratedSocket = async (server) => {
//   console.log("Setting up integrated socket");

//   try {
//     mediasoupWorker = await createMediasoupWorker();
//   } catch (error) {
//     console.error("Failed to initialize Mediasoup:", error);
//     throw error;
//   }

//   const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5174";
//   io = new Server(server, {
//     cors: {
//       origin: corsOrigin,
//       methods: ["GET", "POST"],
//       credentials: true,
//     },
//   });

//   console.log(`Socket.io configured with CORS origin: ${corsOrigin} for ${process.env.NODE_ENV} environment`);

//   io.on("connection", (socket) => {
//     console.log("New client connected:", socket.id);

//     // ====== NEW EVENT HANDLERS ADDED ======
//     // These events will forward messages to all clients in the room
//     socket.on("new-producer", (data) => {
//       console.log("New producer event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("new-producer", data);
//     });
    
//     socket.on("viewer-audio-enabled", (data) => {
//       console.log("Viewer audio enabled event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("viewer-audio-enabled", data);
//     });
    
//     socket.on("screen-share-started-by-viewer", (data) => {
//       console.log("Screen share started by viewer event received, forwarding to room:", data.sessionId);
//       socket.to(data.sessionId).emit("screen-share-started-by-viewer", data);
//     });
//     // ====== END OF NEW EVENT HANDLERS ======

//     // ====== PERMISSION AND MEDIA EVENT HANDLERS ======
//     socket.on("viewer-audio-response", (data) => 
//       handleViewerAudioResponse(socket, data.sessionId, data.requesterSocketId, data.allow)
//     );
    
//     socket.on("screen-share-response", (data) => 
//       handleScreenShareResponse(socket, data.sessionId, data.requesterUserId, data.allow)
//     );
    
//     socket.on("screen-share-force-stop", (data) => 
//       handleStreamerStopScreenShare(socket, data.sessionId, data.targetUserId)
//     );
    
//     socket.on("viewer-audio-muted", (data) => 
//       handleViewerAudioMuted(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-audio-started", (data) => 
//       handleViewerAudioStarted(socket, data.sessionId, data)
//     );
    
//     socket.on("screen-share-started-by-viewer", (data) => 
//       handleScreenShareStartedByViewer(socket, data.sessionId, data)
//     );
    
//   socket.on("screen-share-stopped-by-viewer", (data) => 
//       handleViewerScreenShareStop(socket, data.sessionId, data.userId)
//     );
//     socket.on("viewer-audio-enabled", (data) => 
//       handleViewerAudioEnabled(socket, data.sessionId, data)
//     );

//     // Room and chat events
//     socket.on("join_room", (data) => joinRoomHandler(socket, data));
//     socket.on("chat_message", (data) => chatHandler(socket, data.sessionId, data.message));
//     socket.on("streamer_control", (data) => streamerControlHandler(socket, data));
    
//     // Participant management events
//     socket.on("get_participants", (data, cb) => 
//       getParticipantsHandler(socket, data.sessionId, cb)
//     );
    
//     socket.on("update_participant_status", (data) => 
//       updateParticipantStatusHandler(socket, data.sessionId, data.updates)
//     );
    
//     // Screen share events
//     socket.on("screen-share-request", (data) => 
//       handleScreenShareRequest(socket, data.sessionId)
//     );
    
//     // Producer control events
//     socket.on("producer-pause", (data) => 
//       producerPauseHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-resume", (data) => 
//       producerResumeHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-close", (data) => 
//       producerCloseHandler(socket, data.sessionId, data.producerId)
//     );
    
//     // Mediasoup events
//     socket.on("getRouterRtpCapabilities", (data, cb) => 
//       getRouterRtpCapabilitiesHandler(socket, data.sessionId, cb));
    
//     socket.on("createWebRtcTransport", (data, cb) => 
//       createWebRtcTransportHandler(socket, data.sessionId, cb));
    
//     socket.on("transport-connect", (data, cb) =>
//       transportConnectHandler(socket, data.sessionId, data.transportId, data.dtlsParameters, cb)
//     );
    
//     socket.on("transport-produce", (data, cb) =>
//       transportProduceHandler(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, data.appData, cb)
//     );
    
//     // Screen share specific event (for streamer)
//     socket.on("transport-produce-screen", (data, cb) =>
//       handleScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//     );

//     // Viewer audio events
//     socket.on("viewer-audio-request", (data) => 
//       handleViewerAudioRequest(socket, data.sessionId)
//     );

//     socket.on("transport-produce-viewer-audio", (data, cb) =>
//       handleViewerAudioProduce(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     socket.on("viewer-audio-mute", (data) => 
//       handleViewerAudioMute(socket, data.sessionId, data.targetSocketId)
//     );
    
//     // Viewer screen share events
//     socket.on("transport-produce-viewer-screen", (data, cb) =>
//       handleViewerScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//     );

//     socket.on("screen-share-stop", (data) => 
//       handleViewerScreenShareStop(socket, data.sessionId)
//     );
        
//     socket.on("consume", (data, cb) =>
//       consumeHandler(socket, data.sessionId, data.transportId, data.producerId, data.rtpCapabilities, cb)
//     );
    
//     socket.on("consumer-resume", (data, cb) =>
//       consumerResumeHandler(socket, data.sessionId, data.consumerId, cb)
//     );
    
//     socket.on("getProducers", (data, cb) =>
//       getProducersHandler(socket, data.sessionId, cb)
//     );
    
//     socket.on("getProducerInfo", (data, cb) =>
//       getProducerInfoHandler(socket, data.sessionId, data.producerId, cb)
//     );
    
//     socket.on("consumer-ready", (data, cb) =>
//       consumerReadyHandler(socket, data.sessionId, data.consumerId, cb)
//     );

//     // Whiteboard events
//     socket.on("whiteboard_draw", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "draw", data.drawData, data.patch)
//     );
    
//     socket.on("whiteboard_erase", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "erase", data.eraseData, data.patch)
//     );
    
//     socket.on("whiteboard_undo", (data) => 
//       whiteboardUndoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_redo", (data) => 
//       whiteboardRedoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_save", (data) => 
//       whiteboardSaveCanvasHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_cursor", (data) => 
//       cursorUpdateHandler(socket, data.sessionId, data.position)
//     );
    
//     socket.on("whiteboard_state_request", (data) => 
//       whiteboardStateRequestHandler(socket, data.sessionId)
//     );

//     // WebRTC events
//     socket.on("offer", (data) => 
//       offerHandler(socket, data.sessionId, data.targetSocketId, data.sdp)
//     );
    
//     socket.on("answer", (data) => 
//       answerHandler(socket, data.sessionId, data.sdp)
//     );
    
//     socket.on("ice-candidate", (data) => 
//       iceCandidateHandler(socket, data.sessionId, data.targetSocketId, data.candidate)
//     );

//     socket.on("disconnect", () => cleanupSocketFromRoom(socket));
//   });

//   console.log("✅ Socket.io setup complete with screen share permission system");
//   return io;
// };


// const handleViewerAudioMuted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio muted:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasAudio: false }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-audio-muted-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer"
//     });
//   } catch (error) {
//     console.error("Viewer audio muted error:", error);
//   }
// };

// const handleViewerAudioStarted = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio started:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = true;
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasAudio: true }
//       });
//     }

//     // Notify all participants
//     io.to(sessionId).emit("viewer-audio-started-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer",
//       socketId: socket.id
//     });
//   } catch (error) {
//     console.error("Viewer audio started error:", error);
//   }
// };
// const handleScreenShareStartedByViewer = async (socket, sessionId, data) => {
//   try {
//     console.log("Screen share started by viewer:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.isScreenSharing = true;
//       // Forward to all other participants in the room
//       socket.to(sessionId).emit("screen-share-started-by-viewer", data);
//     }
//   } catch (error) {
//     console.error("Screen share started by viewer error:", error);
//   }
// };

// const handleViewerAudioEnabled = async (socket, sessionId, data) => {
//   try {
//     console.log("Viewer audio enabled:", data);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = true;
//       // Forward to all other participants in the room
//       socket.to(sessionId).emit("viewer-audio-enabled", data);
//     }
//   } catch (error) {
//     console.error("Viewer audio enabled error:", error);
//   }
// };

// // Export functions as named exports
// export { getIO };





























// running code 156 to 1542
// // from audio viewer and streamer
// import { Server } from "socket.io";
// import jwt from "jsonwebtoken";
// import mediasoup from "mediasoup";
// import liveSession from "../model/liveSessions/liveeSession.model.js";
// import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
// import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
// import { ROLE_MAP } from "../constant/role.js";
// import authenticationModel from "../../app/model/Authentication/authentication.model.js";

// // ======= Global Variables =======
// let io;
// let mediasoupWorker;
// const roomState = new Map();

// // ======= Utility Functions =======
// const getIO = () => {
//   if (!io) throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
//   return io;
// };

// const safeEmit = (toSocketId, event, payload) => {
//   try {
//     const s = io.sockets.sockets.get(toSocketId);
//     if (s) {
//       s.emit(event, payload);
//       console.log(`Emitted ${event} to socket: ${toSocketId}`);
//     } else {
//       console.log(`Socket not found: ${toSocketId}`);
//     }
//   } catch (err) {
//     console.error("safeEmit error:", err);
//   }
// };

// const getIceServersFromEnv = () => {
//   const isProduction = process.env.NODE_ENV === "production";

//   const servers = [];
//   const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
//     .split(",")
//     .map(s => s.trim())
//     .filter(Boolean);
//   stunUrls.forEach(url => { if (url) servers.push({ urls: url }); });

//   if (isProduction) {
//     const turnUrls = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//     const turnUsername = process.env.TURN_USERNAME;
//     const turnPassword = process.env.TURN_PASSWORD;

//     turnUrls.forEach(url => {
//       if (url && turnUsername && turnPassword) {
//         servers.push({
//           urls: url,
//           username: turnUsername,
//           credential: turnPassword
//         });
//       }
//     });
//   }
//   if (servers.length === 0) {
//     servers.push({ urls: "stun:stun.l.google.com:19302" });
//     servers.push({ urls: "stun:global.stun.twilio.com:3478" });
//   }

//   return servers;
// };

// const createMediasoupWorker = async () => {
//   try {
//     const minPort = parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000;
//     const maxPort = parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999;
//     const logLevel = process.env.MEDIASOUP_LOG_LEVEL || "warn";

//     mediasoupWorker = await mediasoup.createWorker({
//       logLevel,
//       rtcMinPort: minPort,
//       rtcMaxPort: maxPort,
//     });

//     console.log(`Mediasoup Worker Created (Ports: ${minPort}-${maxPort}) for ${process.env.NODE_ENV} environment`);

//     mediasoupWorker.on("died", () => {
//       console.error("Mediasoup worker died, restarting in 2 seconds...");
//       setTimeout(() => createMediasoupWorker().catch(console.error), 2000);
//     });

//     return mediasoupWorker;
//   } catch (error) {
//     console.error("Failed to create Mediasoup worker:", error);
//     throw error;
//   }
// };

// const flushCanvasOps = async (sessionId) => {
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
  
//   if (state.flushTimer) {
//     clearTimeout(state.flushTimer);
//     state.flushTimer = null;
//   }

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
// };

// const scheduleFlush = (sessionId, op) => {
//   console.log(`Scheduling flush for session: ${sessionId}, operation type: ${op?.type}`);
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
  
//   state.flushTimer = setTimeout(() => {
//     flushCanvasOps(sessionId).catch(err => {
//       console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
//     });
//   }, 2000);
  
//   console.log(`Flush scheduled for session: ${sessionId}`);
// };

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
//       router: null,
//       transports: new Map(),
//       producers: new Map(),
//       consumers: new Map(),
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

// // ======= Producer Control Functions =======
// const pauseAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Pausing all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.pause();
//         console.log(`Producer ${producerId} paused`);
//         safeEmit(socketId, "producer-paused", { producerId });
//       } catch (error) {
//         console.error("Error pausing producer:", error);
//       }
//     }
//   }
// };

// const resumeAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Resuming all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.resume();
//         console.log(`Producer ${producerId} resumed`);
//         safeEmit(socketId, "producer-resumed", { producerId });
//       } catch (error) {
//         console.error("Error resuming producer:", error);
//       }
//     }
//   }
// };

// const producerPauseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-pause for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.pause();
//       socket.emit("producer-paused", { producerId });
//       console.log(`Producer ${producerId} paused`);
//     }
//   } catch (error) {
//     console.error("producer-pause error:", error);
//   }
// };

// const producerResumeHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-resume for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.resume();
//       socket.emit("producer-resumed", { producerId });
//       console.log(`Producer ${producerId} resumed`);
//     }
//   } catch (error) {
//     console.error("producer-resume error:", error);
//   }
// };

// const producerCloseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-close for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer) {
//       producer.close();
//       state.producers.delete(producerId);
//       console.log(`Producer ${producerId} closed and removed`);
//       socket.emit("producer-closed", { producerId });
//     }
//   } catch (error) {
//     console.error("producer-close error:", error);
//   }
// };

// const cleanupSocketFromRoom = async (socket) => {
//   console.log(`Cleanup requested for socket: ${socket.id}`);
//   try {
//     const sid = socket.data?.sessionId;
//     if (!sid) {
//       console.log(`No session ID found for socket: ${socket.id}`);
//       return;
//     }
    
//     const state = roomState.get(sid);
//     if (!state) {
//       console.log(`No state found for session: ${sid}`);
//       return;
//     }

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.log(`No metadata found for socket: ${socket.id}`);
//       return;
//     }

//     // Cleanup Mediasoup resources
//     for (const [consumerId, consumer] of state.consumers) {
//       try {
//         if (consumer?.appData?.socketId === socket.id) {
//           consumer.close();
//           state.consumers.delete(consumerId);
//           console.log(`Consumer ${consumerId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Consumer cleanup error:", e);
//       }
//     }

//     for (const [transportId, transport] of state.transports) {
//       try {
//         if (transport?.appData?.socketId === socket.id) {
//           transport.close();
//           state.transports.delete(transportId);
//           console.log(`Transport ${transportId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Transport cleanup error:", e);
//       }
//     }

//     // Handle producers based on role
//     for (const [producerId, producer] of state.producers) {
//       try {
//         if (producer?.appData?.socketId === socket.id) {
//           if (meta.role === ROLE_MAP.STREAMER) {
//             await producer.pause();
//             console.log(`Producer ${producerId} paused during cleanup (streamer)`);
//           } else {
//             producer.close();
//             state.producers.delete(producerId);
//             console.log(`Producer ${producerId} closed and removed (viewer)`);
//           }
//         }
//       } catch (e) {
//         console.warn("Producer cleanup error:", e);
//       }
//     }

//     // Whiteboard soft leave
//     if (state.whiteboardId) {
//       console.log(`Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`);
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb) {
//         const participant = wb.participants.find(p => p.user.toString() === meta.userId);
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//         }
//         await wb.save();
//         console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
//       }
//     }

//     // Update participant record
//     if (meta.role !== ROLE_MAP.STREAMER) {
//       try {
//         const participant = await liveSessionParticipant.findOne({ 
//           $or: [
//             { sessionId: sid, userId: meta.userId },
//             { socketId: socket.id }
//           ]
//         });
        
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//           participant.isActiveDevice = false;
//           await participant.save();
//           console.log(`Participant ${meta.userId} marked as LEFT`);
//         }
//       } catch (e) {
//         console.error("cleanup update error:", e?.message || e);
//       }

//       state.viewers.delete(socket.id);
//       io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
//       console.log(`Viewer ${socket.id} left room ${sid}`);
//     } else {
//       console.log(`Streamer ${socket.id} left room ${sid}`);
      
//       if (state.streamerSocketId === socket.id) {
//         state.streamerSocketId = null;
//         console.log(`Cleared streamerSocketId for session: ${sid}`);
//       }

//       const session = await liveSession.findOne({ sessionId: sid });
//       if (session) {
//         session.status = "PAUSED";
//         await session.save();
//         console.log(`Session ${sid} paused due to streamer leaving`);
//       }

//       io.to(sid).emit("session_paused_or_ended_by_streamer");
//     }

//     state.sockets.delete(socket.id);
//     socket.leave(sid);
//     console.log(`Socket ${socket.id} removed from room state for session: ${sid}`);

//     // Clean up empty room state
//     if (state.sockets.size === 0) {
//       if (state.pendingOps && state.pendingOps.length > 0) {
//         await flushCanvasOps(sid).catch(err => {
//           console.error(`Error flushing canvas ops during cleanup for session ${sid}:`, err);
//         });
//       }

//       if (state.flushTimer) clearTimeout(state.flushTimer);
      
//       if (state.router) {
//         try {
//           state.router.close();
//           console.log(`Mediasoup router closed for session: ${sid}`);
//         } catch (e) {
//           console.warn("Error closing router:", e);
//         }
//         state.router = null;
//       }
      
//       roomState.delete(sid);
//       console.log(`Room state cleaned up for session: ${sid}`);
//     }
//   } catch (e) {
//     console.error("cleanupSocketFromRoom error:", e?.message || e);
//   }
// };

// const handleScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'screen'  // This identifies it as screen share
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Screen share producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     // Emit a specific event for screen share
//     socket.to(sessionId).emit("screen-share-started", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
    
//     // Also emit the regular new-producer event for compatibility
//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
//   } catch (error) {
//     console.error("Screen share start error:", error);
//     callback({ error: error.message });
//   }
// };

// // Add this function to handle viewer audio production
// const handleViewerAudioProduce = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer audio produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-mic',
//         userId: socket.data.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Viewer audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     // Notify streamer about new viewer audio
//     if (state.streamerSocketId) {
//       safeEmit(state.streamerSocketId, "viewer-audio-started", {
//         producerId: producer.id,
//         userId: socket.data.userId,
//         socketId: socket.id
//       });
//     }

//     // Notify all participants about new viewer audio
//     io.to(sessionId).emit("viewer-audio-enabled", {
//       userId: socket.data.userId,
//       socketId: socket.id
//     });
//   } catch (error) {
//     console.error("Viewer audio produce error:", error);
//     callback({ error: error.message });
//   }
// };

// // Add this function to handle viewer audio permission requests
// const handleViewerAudioRequest = async (socket, sessionId) => {
//   try {
//     console.log("Viewer audio permission request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     // Get user info for the request
//     const user = await authenticationModel.findById(meta.userId).select("name");
//     const requesterName = user?.name || "Viewer";

//     // Forward the request to the streamer with viewer info
//     safeEmit(state.streamerSocketId, "viewer-audio-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: requesterName
//     });
//   } catch (error) {
//     console.error("Viewer audio request error:", error);
//   }
// };

// // Add this function to handle streamer's response to audio requests
// const handleViewerAudioResponse = async (socket, sessionId, requesterSocketId, allow) => {
//   try {
//     console.log("Viewer audio response from streamer:", allow);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Notify the viewer about the streamer's decision
//     safeEmit(requesterSocketId, "viewer-audio-response", {
//       allowed: allow,
//       message: allow ? "You can now speak" : "Streamer denied your audio request"
//     });

//     // If allowed, notify all participants about the enabled audio
//     if (allow) {
//       const viewerMeta = state.sockets.get(requesterSocketId);
//       io.to(sessionId).emit("viewer-audio-enabled", {
//         userId: viewerMeta?.userId,
//         socketId: requesterSocketId
//       });
//     }
//   } catch (error) {
//     console.error("Viewer audio response error:", error);
//   }
// };

// // Add this function to handle muting viewers
// const handleViewerAudioMute = async (socket, sessionId, targetSocketId) => {
//   try {
//     console.log("Muting viewer audio:", targetSocketId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find and pause the viewer's audio producer
//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.socketId === targetSocketId && 
//           producer.kind === "audio" && 
//           producer.appData?.source === 'viewer-mic') {
//         await producer.pause();
//         console.log(`Viewer audio producer ${producerId} muted`);
        
//         // Notify the viewer
//         safeEmit(targetSocketId, "viewer-audio-muted", {
//           producerId: producer.id,
//           mutedBy: socket.data.userId
//         });
        
//         // Notify other participants
//         const viewerMeta = state.sockets.get(targetSocketId);
//         io.to(sessionId).emit("viewer-audio-muted", {
//           userId: viewerMeta?.userId,
//           socketId: targetSocketId,
//           mutedBy: socket.data.userId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Viewer audio mute error:", error);
//   }
// };

// const joinRoomHandler = async (socket, data) => {
//   const { token, sessionId, roomCode } = data;
//   console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);
  
//   try {
//     if (!token || (!sessionId && !roomCode)) {
//       return socket.emit("error_message", "Missing token or sessionId/roomCode");
//     }

//     let decoded;
//     try {
//       decoded = jwt.verify(token, process.env.SECRET_KEY);
//       console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
//     } catch (err) {
//       return socket.emit("error_message", "Invalid token");
//     }
    
//     const userId = decoded.userId;
//     const userRole = decoded.role;

//     let session;
//     if (sessionId) {
//       session = await liveSession.findOne({ sessionId });
//     } else {
//       session = await liveSession.findOne({ roomCode });
//     }

//     if (!session) return socket.emit("error_message", "Session not found");
//     if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
//       return socket.emit("error_message", `Session is ${session.status}`);
//     }

//     if (session.isPrivate) {
//       const allowed = Array.isArray(session.allowedUsers) && 
//         session.allowedUsers.some(u => u.toString() === userId);
//       if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
//     }

//     const sid = session.sessionId;
//     if (!roomState.has(sid)) {
//       roomState.set(sid, {
//         whiteboardId: session.whiteboardId || null,
//         createdBy: session.streamerId ? session.streamerId.toString() : null,
//         streamerSocketId: null,
//         viewers: new Set(),
//         sockets: new Map(),
//         pendingOps: [],
//         flushTimer: null,
//         router: null,
//         transports: new Map(),
//         producers: new Map(),
//         consumers: new Map(),
//       });
//       console.log(`New room state created for session: ${sid}`);
//     }
    
//     const state = roomState.get(sid);

//     const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
//     const activeCount = await liveSessionParticipant.countDocuments({ 
//       sessionId: session._id, 
//       status: { $ne: "LEFT" } 
//     });
    
//     if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
//       return socket.emit("error_message", "Max participants limit reached");
//     }

//     let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
//     if (participant && participant.isBanned) {
//       return socket.emit("error_message", "You are banned from this session");
//     }

//     if (userRole === ROLE_MAP.STREAMER) {
//       if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
//         console.log(`Streamer reconnecting from ${state.streamerSocketId} to ${socket.id}`);
//         if (state.sockets.has(state.streamerSocketId)) {
//           state.sockets.delete(state.streamerSocketId);
//           state.viewers.delete(state.streamerSocketId);
//         }
//       }
//       state.streamerSocketId = socket.id;
//       console.log(`Streamer socket ID updated to: ${socket.id}`);
//     }

//     if (!participant) {
//       participant = await liveSessionParticipant.create({
//         sessionId: session._id,
//         userId,
//         socketId: socket.id,
//         status: "JOINED",
//         isActiveDevice: true,
//         joinedAt: new Date(),
//       });
//       session.totalJoins = (session.totalJoins || 0) + 1;
//       await session.save();
//       console.log(`New participant created, total joins: ${session.totalJoins}`);
//     } else {
//       participant.socketId = socket.id;
//       participant.status = "JOINED";
//       participant.isActiveDevice = true;
//       participant.joinedAt = new Date();
//       participant.leftAt = null;
//       await participant.save();
//     }

//     if (userRole === ROLE_MAP.STREAMER && !state.router) {
//       console.log("Creating Mediasoup router for session:", sid);
//       const mediaCodecs = [
//         {
//           kind: "audio",
//           mimeType: "audio/opus",
//           clockRate: 48000,
//           channels: 2,
//         },
//         {
//           kind: "video",
//           mimeType: "video/VP8",
//           clockRate: 90000,
//           parameters: {
//             "x-google-start-bitrate": process.env.NODE_ENV === "production" ? 500000 : 1000000,
//           },
//         },
//       ];

//       state.router = await mediasoupWorker.createRouter({ mediaCodecs });
//       console.log("Mediasoup router created for session:", sid);
//     }

//     state.sockets.set(socket.id, { userId, role: userRole });
//     socket.data = { sessionId: sid, userId, role: userRole };
//     socket.join(sid);
//     console.log(`Socket ${socket.id} joined room ${sid}`);

//     const iceServers = getIceServersFromEnv();
//     socket.emit("ice_servers", iceServers);

//     if (userRole === ROLE_MAP.STREAMER) {
//       socket.emit("joined_room", {
//         as: "STREAMER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys())
//       });
//       console.log(`Streamer ${socket.id} joined room ${sid}`);
//     } else {
//       state.viewers.add(socket.id);
//       socket.emit("joined_room", {
//         as: "VIEWER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         whiteboardId: state.whiteboardId,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys())
//       });
//       console.log(`Viewer ${socket.id} joined room ${sid}`);
      
//       if (state.streamerSocketId) {
//         safeEmit(state.streamerSocketId, "viewer_ready", { 
//           viewerSocketId: socket.id, 
//           viewerUserId: userId 
//         });
//       }
//     }

//     if (state.whiteboardId) {
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
//         wb.participants.push({ 
//           user: userId, 
//           role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", 
//           joinedAt: new Date() 
//         });
//         await wb.save();
//         console.log(`User added to whiteboard: ${state.whiteboardId}`);
//       }
//     }

//     const currentParticipants = state.viewers.size + (state.streamerSocketId ? 1 : 0);
//     if ((session.peakParticipants || 0) < currentParticipants) {
//       session.peakParticipants = currentParticipants;
//       await session.save();
//       console.log(`New peak participants: ${currentParticipants}`);
//     }
//   } catch (err) {
//     console.error("join_room error:", err);
//     socket.emit("error_message", "Invalid token/session");
//     throw err;
//   }
// };

// const chatHandler = async (socket, sessionId, message) => {
//   console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}`);
  
//   try {
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const sender = await authenticationModel.findById(meta.userId).select("name");
    
//     io.to(sessionId).emit("chat_message", {
//       userId: meta.userId,
//       name: sender?.name || "Unknown",
//       message,
//       socketId: socket.id,
//       at: new Date(),
//     });
    
//     console.log(`Chat message broadcast to session: ${sessionId}`);
//   } catch (err) {
//     console.error("chat_message error:", err);
//     throw err;
//   }
// };

// const streamerControlHandler = async (socket, data) => {
//   const { sessionId, status, emitEvent } = data;
//   console.log(`Streamer control request for session: ${sessionId}, status: ${status}`);
  
//   try {
//     const session = await liveSession.findOne({ sessionId });
//     if (!session) return;

//     if (status === "PAUSED") {
//       await pauseAllProducers(sessionId, socket.id);
//     } else if (status === "ACTIVE") {
//       await resumeAllProducers(sessionId, socket.id);
//     }

//     session.status = status;
//     if (status === "ACTIVE" && emitEvent === "streamer_started") {
//       session.actualStartTime = new Date();
//     }

//     await session.save();
//     io.to(sessionId).emit(emitEvent, { sessionId });
//     console.log(`Session ${sessionId} ${status.toLowerCase()} by streamer`);
//   } catch (err) {
//     console.error("streamer_control error:", err);
//     throw err;
//   }
// };

// const getRouterRtpCapabilitiesHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getRouterRtpCapabilities for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });
//     callback({ rtpCapabilities: state.router.rtpCapabilities });
//   } catch (error) {
//     console.error("getRouterRtpCapabilities error:", error);
//     callback({ error: error.message });
//   }
// };

// const createWebRtcTransportHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("createWebRtcTransport for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });

//     const transport = await state.router.createWebRtcTransport({
//       listenIps: [
//         {
//           ip: "0.0.0.0",
//           announcedIp: process.env.SERVER_IP || "127.0.0.1",
//         },
//       ],
//       enableUdp: true,
//       enableTcp: true,
//       preferUdp: true,
//       initialAvailableOutgoingBitrate: process.env.NODE_ENV === "production" ? 500000 : 1000000,
//     });

//     transport.on("dtlsstatechange", (dtlsState) => {
//       if (dtlsState === "closed") transport.close();
//     });

//     transport.appData = { socketId: socket.id };
//     state.transports.set(transport.id, transport);

//     callback({
//       params: {
//         id: transport.id,
//         iceParameters: transport.iceParameters,
//         iceCandidates: transport.iceCandidates,
//         dtlsParameters: transport.dtlsParameters,
//       },
//     });
//   } catch (error) {
//     console.error("createWebRtcTransport error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportConnectHandler = async (socket, sessionId, transportId, dtlsParameters, callback) => {
//   try {
//     console.log("transport-connect for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     await transport.connect({ dtlsParameters });
//     callback({ success: true });
//   } catch (error) {
//     console.error("transport-connect error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportProduceHandler = async (socket, sessionId, transportId, kind, rtpParameters, appData, callback) => {
//   try {
//     console.log("transport-produce for transport:", transportId, "kind:", kind, "source:", appData?.source);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: appData?.source || 'camera'
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("transport-produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumeHandler = async (socket, sessionId, transportId, producerId, rtpCapabilities, callback) => {
//   try {
//     console.log("consume for producer:", producerId, "transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) {
//       console.log("❌ Router not found for session:", sessionId);
//       return callback({ error: "Router not found" });
//     }

//     const producer = state.producers.get(producerId);
//     if (!producer) {
//       console.log("❌ Producer not found:", producerId);
//       return callback({ error: "Producer not found" });
//     }

//     if (!state.router.canConsume({ producerId, rtpCapabilities })) {
//       console.log("❌ Cannot consume - router.canConsume returned false");
//       return callback({ error: "Cannot consume" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) {
//       console.log("❌ Transport not found:", transportId);
//       return callback({ error: "Transport not found" });
//     }

//     const consumer = await transport.consume({
//       producerId,
//       rtpCapabilities,
//       paused: true,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//       },
//     });

//     state.consumers.set(consumer.id, consumer);
//     console.log("✅ Consumer created:", consumer.id);

//     callback({
//       params: {
//         id: consumer.id,
//         producerId,
//         kind: consumer.kind,
//         rtpParameters: consumer.rtpParameters,
//       },
//     });
//   } catch (error) {
//     console.error("consume error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumerResumeHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-resume for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     await consumer.resume();
//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-resume error:", error);
//     callback({ error: error.message });
//   }
// };

// const getProducersHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getProducers for session:", sessionId);
//     const state = roomState.get(sessionId);
//     callback(state ? Array.from(state.producers.keys()) : []);
//   } catch (error) {
//     console.error("getProducers error:", error);
//     callback([]);
//   }
// };

// const getProducerInfoHandler = async (socket, sessionId, producerId, callback) => {
//   try {
//     console.log("getProducerInfo for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback(null);

//     const producer = state.producers.get(producerId);
//     if (!producer) return callback(null);

//     callback({
//       id: producer.id,
//       kind: producer.kind,
//       userId: socket.data?.userId,
//       socketId: producer.appData?.socketId,
//       source: producer.appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("getProducerInfo error:", error);
//     callback(null);
//   }
// };

// const consumerReadyHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-ready for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-ready error:", error);
//     callback({ error: error.message });
//   }
// };

// const offerHandler = (socket, sessionId, targetSocketId, sdp) => {
//   console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || state.streamerSocketId !== socket.id) return;
//   safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
// };

// const answerHandler = (socket, sessionId, sdp) => {
//   console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta || meta.role === ROLE_MAP.STREAMER) return;

//   safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
// };

// const iceCandidateHandler = (socket, sessionId, targetSocketId, candidate) => {
//   console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;
//   safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
// };

// const whiteboardEventHandler = (socket, sessionId, type, data, patch) => {
//   console.log(`Whiteboard ${type} from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit(`whiteboard_${type}`, { 
//     userId: meta.userId, 
//     [`${type}Data`]: data 
//   });
  
//   scheduleFlush(sessionId, { type, payload: data, patch, at: new Date() });
// };

// const whiteboardUndoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const undoStack = wb.undoStack || [];
//   if (undoStack.length === 0) return;

//   const last = undoStack.pop();
//   wb.undoStack = undoStack.slice(-500);
//   wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_undo_applied", { last });
//   console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardRedoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const redoStack = wb.redoStack || [];
//   if (redoStack.length === 0) return;

//   const last = redoStack.pop();
//   wb.redoStack = redoStack.slice(-500);
//   wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_redo_applied", { last });
//   console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardSaveCanvasHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
//   await flushCanvasOps(sessionId).catch(err => {
//     console.error(`Error saving canvas for session ${sessionId}:`, err);
//   });
//   socket.emit("whiteboard_saved");
//   console.log(`Whiteboard saved for session: ${sessionId}`);
// };

// const cursorUpdateHandler = (socket, sessionId, position) => {
//   console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
// };

// const whiteboardStateRequestHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   socket.emit("whiteboard_state_sync", {
//     canvasData: wb.canvasData,
//     participants: wb.participants,
//     versionHistory: wb.versionHistory,
//   });
  
//   console.log(`Whiteboard state sent to socket: ${socket.id}`);
// };

// // ======= Setup Socket.io =======
// export const setupIntegratedSocket = async (server) => {
//   console.log("Setting up integrated socket");

//   try {
//     mediasoupWorker = await createMediasoupWorker();
//   } catch (error) {
//     console.error("Failed to initialize Mediasoup:", error);
//     throw error;
//   }

//   const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5174";
//   io = new Server(server, {
//     cors: {
//       origin: corsOrigin,
//       methods: ["GET", "POST"],
//       credentials: true,
//     },
//   });

//   console.log(`Socket.io configured with CORS origin: ${corsOrigin} for ${process.env.NODE_ENV} environment`);

//   io.on("connection", (socket) => {
//     console.log("New client connected:", socket.id);

//     // Room and chat events
//     socket.on("join_room", (data) => joinRoomHandler(socket, data));
//     socket.on("chat_message", (data) => chatHandler(socket, data.sessionId, data.message));
//     socket.on("streamer_control", (data) => streamerControlHandler(socket, data));
    
//     // Producer control events
//     socket.on("producer-pause", (data) => 
//       producerPauseHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-resume", (data) => 
//       producerResumeHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-close", (data) => 
//       producerCloseHandler(socket, data.sessionId, data.producerId)
//     );
    
//     // Mediasoup events
//     socket.on("getRouterRtpCapabilities", (data, cb) => 
//       getRouterRtpCapabilitiesHandler(socket, data.sessionId, cb));
    
//     socket.on("createWebRtcTransport", (data, cb) => 
//       createWebRtcTransportHandler(socket, data.sessionId, cb));
    
//     socket.on("transport-connect", (data, cb) =>
//       transportConnectHandler(socket, data.sessionId, data.transportId, data.dtlsParameters, cb)
//     );
    
//     socket.on("transport-produce", (data, cb) =>
//       transportProduceHandler(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, data.appData, cb)
//     );
    
//     // Screen share specific event
//     socket.on("transport-produce-screen", (data, cb) =>
//       handleScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//     );

//     // Viewer requests to speak
//     socket.on("viewer-audio-request", (data) => 
//       handleViewerAudioRequest(socket, data.sessionId)
//     );

//     // Streamer responds to audio request
//     socket.on("viewer-audio-response", (data) => 
//       handleViewerAudioResponse(socket, data.sessionId, data.requesterSocketId, data.allow)
//     );

//     // Viewer produces audio (after permission granted)
//     socket.on("transport-produce-viewer-audio", (data, cb) =>
//       handleViewerAudioProduce(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     // Mute a viewer's audio
//     socket.on("viewer-audio-mute", (data) => 
//       handleViewerAudioMute(socket, data.sessionId, data.targetSocketId)
//     );
        
//     socket.on("consume", (data, cb) =>
//       consumeHandler(socket, data.sessionId, data.transportId, data.producerId, data.rtpCapabilities, cb)
//     );
    
//     socket.on("consumer-resume", (data, cb) =>
//       consumerResumeHandler(socket, data.sessionId, data.consumerId, cb)
//     );
    
//     socket.on("getProducers", (data, cb) =>
//       getProducersHandler(socket, data.sessionId, cb)
//     );
    
//     socket.on("getProducerInfo", (data, cb) =>
//       getProducerInfoHandler(socket, data.sessionId, data.producerId, cb)
//     );
    
//     socket.on("consumer-ready", (data, cb) =>
//       consumerReadyHandler(socket, data.sessionId, data.consumerId, cb)
//     );

//     // Whiteboard events
//     socket.on("whiteboard_draw", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "draw", data.drawData, data.patch)
//     );
    
//     socket.on("whiteboard_erase", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "erase", data.eraseData, data.patch)
//     );
    
//     socket.on("whiteboard_undo", (data) => 
//       whiteboardUndoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_redo", (data) => 
//       whiteboardRedoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_save", (data) => 
//       whiteboardSaveCanvasHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_cursor", (data) => 
//       cursorUpdateHandler(socket, data.sessionId, data.position)
//     );
    
//     socket.on("whiteboard_state_request", (data) => 
//       whiteboardStateRequestHandler(socket, data.sessionId)
//     );

//     // WebRTC events
//     socket.on("offer", (data) => 
//       offerHandler(socket, data.sessionId, data.targetSocketId, data.sdp)
//     );
    
//     socket.on("answer", (data) => 
//       answerHandler(socket, data.sessionId, data.sdp)
//     );
    
//     socket.on("ice-candidate", (data) => 
//       iceCandidateHandler(socket, data.sessionId, data.targetSocketId, data.candidate)
//     );

//     socket.on("disconnect", () => cleanupSocketFromRoom(socket));
//   });

//   console.log("✅ Socket.io setup complete with enhanced producer control and screen sharing support");
//   return io;
// };

// // Export functions as named exports
// export { getIO };

























// import { Server } from "socket.io";
// import jwt from "jsonwebtoken";
// import mediasoup from "mediasoup";
// import liveSession from "../model/liveSessions/liveeSession.model.js";
// import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
// import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
// import { ROLE_MAP } from "../constant/role.js";
// import authenticationModel from "../../app/model/Authentication/authentication.model.js";

// // ======= Global Variables =======
// let io;
// let mediasoupWorker;
// const roomState = new Map();

// // ======= Utility Functions =======
// const getIO = () => {
//   if (!io) throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
//   return io;
// };

// const safeEmit = (toSocketId, event, payload) => {
//   try {
//     const s = io.sockets.sockets.get(toSocketId);
//     if (s) {
//       s.emit(event, payload);
//       console.log(`Emitted ${event} to socket: ${toSocketId}`);
//     } else {
//       console.log(`Socket not found: ${toSocketId}`);
//     }
//   } catch (err) {
//     console.error("safeEmit error:", err);
//   }
// };

// const getIceServersFromEnv = () => {
//   const isProduction = process.env.NODE_ENV === "production";

//   const servers = [];
//   const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
//     .split(",")
//     .map(s => s.trim())
//     .filter(Boolean);
//   stunUrls.forEach(url => { if (url) servers.push({ urls: url }); });

//   if (isProduction) {
//     const turnUrls = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//     const turnUsername = process.env.TURN_USERNAME;
//     const turnPassword = process.env.TURN_PASSWORD;

//     turnUrls.forEach(url => {
//       if (url && turnUsername && turnPassword) {
//         servers.push({
//           urls: url,
//           username: turnUsername,
//           credential: turnPassword
//         });
//       }
//     });
//   }
//   if (servers.length === 0) {
//     servers.push({ urls: "stun:stun.l.google.com:19302" });
//     servers.push({ urls: "stun:global.stun.twilio.com:3478" });
//   }

//   return servers;
// };


// const createMediasoupWorker = async () => {
//   try {
//     const minPort = parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000;
//     const maxPort = parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999;
//     const logLevel = process.env.MEDIASOUP_LOG_LEVEL || "warn";

//     mediasoupWorker = await mediasoup.createWorker({
//       logLevel,
//       rtcMinPort: minPort,
//       rtcMaxPort: maxPort,
//     });

//     console.log(`Mediasoup Worker Created (Ports: ${minPort}-${maxPort}) for ${process.env.NODE_ENV} environment`);

//     mediasoupWorker.on("died", () => {
//       console.error("Mediasoup worker died, restarting in 2 seconds...");
//       setTimeout(() => createMediasoupWorker().catch(console.error), 2000);
//     });

//     return mediasoupWorker;
//   } catch (error) {
//     console.error("Failed to create Mediasoup worker:", error);
//     throw error;
//   }
// };

// const flushCanvasOps = async (sessionId) => {
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
  
//   if (state.flushTimer) {
//     clearTimeout(state.flushTimer);
//     state.flushTimer = null;
//   }

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
// };

// const scheduleFlush = (sessionId, op) => {
//   console.log(`Scheduling flush for session: ${sessionId}, operation type: ${op?.type}`);
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
  
//   state.flushTimer = setTimeout(() => {
//     flushCanvasOps(sessionId).catch(err => {
//       console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
//     });
//   }, 2000);
  
//   console.log(`Flush scheduled for session: ${sessionId}`);
// };

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
//       router: null,
//       transports: new Map(),
//       producers: new Map(),
//       consumers: new Map(),
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

// // ======= Producer Control Functions =======
// const pauseAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Pausing all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.pause();
//         console.log(`Producer ${producerId} paused`);
//         safeEmit(socketId, "producer-paused", { producerId });
//       } catch (error) {
//         console.error("Error pausing producer:", error);
//       }
//     }
//   }
// };

// const resumeAllProducers = async (sessionId, socketId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   console.log(`Resuming all producers for socket: ${socketId} in session: ${sessionId}`);
  
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.socketId === socketId) {
//       try {
//         await producer.resume();
//         console.log(`Producer ${producerId} resumed`);
//         safeEmit(socketId, "producer-resumed", { producerId });
//       } catch (error) {
//         console.error("Error resuming producer:", error);
//       }
//     }
//   }
// };

// const producerPauseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-pause for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.pause();
//       socket.emit("producer-paused", { producerId });
//       console.log(`Producer ${producerId} paused`);
//     }
//   } catch (error) {
//     console.error("producer-pause error:", error);
//   }
// };

// const producerResumeHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-resume for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer && producer.appData?.socketId === socket.id) {
//       await producer.resume();
//       socket.emit("producer-resumed", { producerId });
//       console.log(`Producer ${producerId} resumed`);
//     }
//   } catch (error) {
//     console.error("producer-resume error:", error);
//   }
// };

// const producerCloseHandler = async (socket, sessionId, producerId) => {
//   try {
//     console.log("producer-close for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer) {
//       producer.close();
//       state.producers.delete(producerId);
//       console.log(`Producer ${producerId} closed and removed`);
//       socket.emit("producer-closed", { producerId });
//     }
//   } catch (error) {
//     console.error("producer-close error:", error);
//   }
// };

// const cleanupSocketFromRoom = async (socket) => {
//   console.log(`Cleanup requested for socket: ${socket.id}`);
//   try {
//     const sid = socket.data?.sessionId;
//     if (!sid) {
//       console.log(`No session ID found for socket: ${socket.id}`);
//       return;
//     }
    
//     const state = roomState.get(sid);
//     if (!state) {
//       console.log(`No state found for session: ${sid}`);
//       return;
//     }

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.log(`No metadata found for socket: ${socket.id}`);
//       return;
//     }

//     // Cleanup Mediasoup resources
//     for (const [consumerId, consumer] of state.consumers) {
//       try {
//         if (consumer?.appData?.socketId === socket.id) {
//           consumer.close();
//           state.consumers.delete(consumerId);
//           console.log(`Consumer ${consumerId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Consumer cleanup error:", e);
//       }
//     }

//     for (const [transportId, transport] of state.transports) {
//       try {
//         if (transport?.appData?.socketId === socket.id) {
//           transport.close();
//           state.transports.delete(transportId);
//           console.log(`Transport ${transportId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Transport cleanup error:", e);
//       }
//     }

//     // Handle producers based on role
//     for (const [producerId, producer] of state.producers) {
//       try {
//         if (producer?.appData?.socketId === socket.id) {
//           if (meta.role === ROLE_MAP.STREAMER) {
//             await producer.pause();
//             console.log(`Producer ${producerId} paused during cleanup (streamer)`);
//           } else {
//             producer.close();
//             state.producers.delete(producerId);
//             console.log(`Producer ${producerId} closed and removed (viewer)`);
//           }
//         }
//       } catch (e) {
//         console.warn("Producer cleanup error:", e);
//       }
//     }

//     // Whiteboard soft leave
//     if (state.whiteboardId) {
//       console.log(`Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`);
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb) {
//         const participant = wb.participants.find(p => p.user.toString() === meta.userId);
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//         }
//         await wb.save();
//         console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
//       }
//     }

//     // Update participant record
//     if (meta.role !== ROLE_MAP.STREAMER) {
//       try {
//         const participant = await liveSessionParticipant.findOne({ 
//           $or: [
//             { sessionId: sid, userId: meta.userId },
//             { socketId: socket.id }
//           ]
//         });
        
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//           participant.isActiveDevice = false;
//           await participant.save();
//           console.log(`Participant ${meta.userId} marked as LEFT`);
//         }
//       } catch (e) {
//         console.error("cleanup update error:", e?.message || e);
//       }

//       state.viewers.delete(socket.id);
//       io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
//       console.log(`Viewer ${socket.id} left room ${sid}`);
//     } else {
//       console.log(`Streamer ${socket.id} left room ${sid}`);
      
//       if (state.streamerSocketId === socket.id) {
//         state.streamerSocketId = null;
//         console.log(`Cleared streamerSocketId for session: ${sid}`);
//       }

//       const session = await liveSession.findOne({ sessionId: sid });
//       if (session) {
//         session.status = "PAUSED";
//         await session.save();
//         console.log(`Session ${sid} paused due to streamer leaving`);
//       }

//       io.to(sid).emit("session_paused_or_ended_by_streamer");
//     }

//     state.sockets.delete(socket.id);
//     socket.leave(sid);
//     console.log(`Socket ${socket.id} removed from room state for session: ${sid}`);

//     // Clean up empty room state
//     if (state.sockets.size === 0) {
//       if (state.pendingOps && state.pendingOps.length > 0) {
//         await flushCanvasOps(sid).catch(err => {
//           console.error(`Error flushing canvas ops during cleanup for session ${sid}:`, err);
//         });
//       }

//       if (state.flushTimer) clearTimeout(state.flushTimer);
      
//       if (state.router) {
//         try {
//           state.router.close();
//           console.log(`Mediasoup router closed for session: ${sid}`);
//         } catch (e) {
//           console.warn("Error closing router:", e);
//         }
//         state.router = null;
//       }
      
//       roomState.delete(sid);
//       console.log(`Room state cleaned up for session: ${sid}`);
//     }
//   } catch (e) {
//     console.error("cleanupSocketFromRoom error:", e?.message || e);
//   }
// };

// const handleScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'screen'  // This identifies it as screen share
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Screen share producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     // Emit a specific event for screen share
//     socket.to(sessionId).emit("screen-share-started", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
    
//     // Also emit the regular new-producer event for compatibility
//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen'
//     });
//   } catch (error) {
//     console.error("Screen share start error:", error);
//     callback({ error: error.message });
//   }
// };

// // Add this function to handle viewer audio production
// const handleViewerAudioProduce = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer audio produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-mic',
//         userId: socket.data.userId
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Viewer audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     // Notify streamer about new viewer audio
//     if (state.streamerSocketId) {
//       safeEmit(state.streamerSocketId, "viewer-audio-started", {
//         producerId: producer.id,
//         userId: socket.data.userId,
//         socketId: socket.id
//       });
//     }
//   } catch (error) {
//     console.error("Viewer audio produce error:", error);
//     callback({ error: error.message });
//   }
// };

// // Add this function to handle viewer audio permission requests
// const handleViewerAudioRequest = async (socket, sessionId) => {
//   try {
//     console.log("Viewer audio permission request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state || !state.streamerSocketId) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     // Forward the request to the streamer with viewer info
//     safeEmit(state.streamerSocketId, "viewer-audio-request", {
//       requestedUserId: meta.userId,
//       requesterSocketId: socket.id,
//       requesterName: "Viewer Name" // You should fetch the actual name from your database
//     });
//   } catch (error) {
//     console.error("Viewer audio request error:", error);
//   }
// };

// // Add this function to handle streamer's response to audio requests
// const handleViewerAudioResponse = async (socket, sessionId, requesterSocketId, allow) => {
//   try {
//     console.log("Viewer audio response from streamer:", allow);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Notify the viewer about the streamer's decision
//     safeEmit(requesterSocketId, "viewer-audio-response", {
//       allowed: allow,
//       message: allow ? "You can now speak" : "Streamer denied your audio request"
//     });

//     // If allowed, notify all participants about the enabled audio
//     if (allow) {
//       const viewerMeta = state.sockets.get(requesterSocketId);
//       io.to(sessionId).emit("viewer-audio-enabled", {
//         userId: viewerMeta?.userId,
//         socketId: requesterSocketId
//       });
//     }
//   } catch (error) {
//     console.error("Viewer audio response error:", error);
//   }
// };

// // Add this function to handle muting viewers
// const handleViewerAudioMute = async (socket, sessionId, targetSocketId) => {
//   try {
//     console.log("Muting viewer audio:", targetSocketId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Find and pause the viewer's audio producer
//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.socketId === targetSocketId && 
//           producer.kind === "audio" && 
//           producer.appData?.source === 'viewer-mic') {
//         await producer.pause();
//         console.log(`Viewer audio producer ${producerId} muted`);
        
//         // Notify the viewer
//         safeEmit(targetSocketId, "viewer-audio-muted", {
//           producerId: producer.id,
//           mutedBy: socket.data.userId
//         });
        
//         // Notify other participants
//         const viewerMeta = state.sockets.get(targetSocketId);
//         io.to(sessionId).emit("viewer-audio-muted", {
//           userId: viewerMeta?.userId,
//           socketId: targetSocketId,
//           mutedBy: socket.data.userId
//         });
        
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Viewer audio mute error:", error);
//   }
// };

// const joinRoomHandler = async (socket, data) => {
//   const { token, sessionId, roomCode } = data;
//   console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);
  
//   try {
//     if (!token || (!sessionId && !roomCode)) {
//       return socket.emit("error_message", "Missing token or sessionId/roomCode");
//     }

//     let decoded;
//     try {
//       decoded = jwt.verify(token, process.env.SECRET_KEY);
//       console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
//     } catch (err) {
//       return socket.emit("error_message", "Invalid token");
//     }
    
//     const userId = decoded.userId;
//     const userRole = decoded.role;

//     let session;
//     if (sessionId) {
//       session = await liveSession.findOne({ sessionId });
//     } else {
//       session = await liveSession.findOne({ roomCode });
//     }

//     if (!session) return socket.emit("error_message", "Session not found");
//     if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
//       return socket.emit("error_message", `Session is ${session.status}`);
//     }

//     if (session.isPrivate) {
//       const allowed = Array.isArray(session.allowedUsers) && 
//         session.allowedUsers.some(u => u.toString() === userId);
//       if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
//     }

//     const sid = session.sessionId;
//     if (!roomState.has(sid)) {
//       roomState.set(sid, {
//         whiteboardId: session.whiteboardId || null,
//         createdBy: session.streamerId ? session.streamerId.toString() : null,
//         streamerSocketId: null,
//         viewers: new Set(),
//         sockets: new Map(),
//         pendingOps: [],
//         flushTimer: null,
//         router: null,
//         transports: new Map(),
//         producers: new Map(),
//         consumers: new Map(),
//       });
//       console.log(`New room state created for session: ${sid}`);
//     }
    
//     const state = roomState.get(sid);

//     const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
//     const activeCount = await liveSessionParticipant.countDocuments({ 
//       sessionId: session._id, 
//       status: { $ne: "LEFT" } 
//     });
    
//     if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
//       return socket.emit("error_message", "Max participants limit reached");
//     }

//     let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
//     if (participant && participant.isBanned) {
//       return socket.emit("error_message", "You are banned from this session");
//     }

//     if (userRole === ROLE_MAP.STREAMER) {
//       if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
//         console.log(`Streamer reconnecting from ${state.streamerSocketId} to ${socket.id}`);
//         if (state.sockets.has(state.streamerSocketId)) {
//           state.sockets.delete(state.streamerSocketId);
//           state.viewers.delete(state.streamerSocketId);
//         }
//       }
//       state.streamerSocketId = socket.id;
//       console.log(`Streamer socket ID updated to: ${socket.id}`);
//     }

//     if (!participant) {
//       participant = await liveSessionParticipant.create({
//         sessionId: session._id,
//         userId,
//         socketId: socket.id,
//         status: "JOINED",
//         isActiveDevice: true,
//         joinedAt: new Date(),
//       });
//       session.totalJoins = (session.totalJoins || 0) + 1;
//       await session.save();
//       console.log(`New participant created, total joins: ${session.totalJoins}`);
//     } else {
//       participant.socketId = socket.id;
//       participant.status = "JOINED";
//       participant.isActiveDevice = true;
//       participant.joinedAt = new Date();
//       participant.leftAt = null;
//       await participant.save();
//     }

//     if (userRole === ROLE_MAP.STREAMER && !state.router) {
//       console.log("Creating Mediasoup router for session:", sid);
//       const mediaCodecs = [
//         {
//           kind: "audio",
//           mimeType: "audio/opus",
//           clockRate: 48000,
//           channels: 2,
//         },
//         {
//           kind: "video",
//           mimeType: "video/VP8",
//           clockRate: 90000,
//           parameters: {
//             "x-google-start-bitrate": process.env.NODE_ENV === "production" ? 500000 : 1000000,
//           },
//         },
//       ];

//       state.router = await mediasoupWorker.createRouter({ mediaCodecs });
//       console.log("Mediasoup router created for session:", sid);
//     }

//     state.sockets.set(socket.id, { userId, role: userRole });
//     socket.data = { sessionId: sid, userId, role: userRole };
//     socket.join(sid);
//     console.log(`Socket ${socket.id} joined room ${sid}`);

//     const iceServers = getIceServersFromEnv();
//     socket.emit("ice_servers", iceServers);

//     if (userRole === ROLE_MAP.STREAMER) {
//       socket.emit("joined_room", {
//         as: "STREAMER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys())
//       });
//       console.log(`Streamer ${socket.id} joined room ${sid}`);
//     } else {
//       state.viewers.add(socket.id);
//       socket.emit("joined_room", {
//         as: "VIEWER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         whiteboardId: state.whiteboardId,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers,
//         activeProducers: Array.from(state.producers.keys())
//       });
//       console.log(`Viewer ${socket.id} joined room ${sid}`);
      
//       if (state.streamerSocketId) {
//         safeEmit(state.streamerSocketId, "viewer_ready", { 
//           viewerSocketId: socket.id, 
//           viewerUserId: userId 
//         });
//       }
//     }

//     if (state.whiteboardId) {
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
//         wb.participants.push({ 
//           user: userId, 
//           role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", 
//           joinedAt: new Date() 
//         });
//         await wb.save();
//         console.log(`User added to whiteboard: ${state.whiteboardId}`);
//       }
//     }

//     const currentParticipants = state.viewers.size + (state.streamerSocketId ? 1 : 0);
//     if ((session.peakParticipants || 0) < currentParticipants) {
//       session.peakParticipants = currentParticipants;
//       await session.save();
//       console.log(`New peak participants: ${currentParticipants}`);
//     }
//   } catch (err) {
//     console.error("join_room error:", err);
//     socket.emit("error_message", "Invalid token/session");
//     throw err;
//   }
// };

// const chatHandler = async (socket, sessionId, message) => {
//   console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}`);
  
//   try {
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const sender = await authenticationModel.findById(meta.userId).select("name");
    
//     io.to(sessionId).emit("chat_message", {
//       userId: meta.userId,
//       name: sender?.name || "Unknown",
//       message,
//       socketId: socket.id,
//       at: new Date(),
//     });
    
//     console.log(`Chat message broadcast to session: ${sessionId}`);
//   } catch (err) {
//     console.error("chat_message error:", err);
//     throw err;
//   }
// };

// const streamerControlHandler = async (socket, data) => {
//   const { sessionId, status, emitEvent } = data;
//   console.log(`Streamer control request for session: ${sessionId}, status: ${status}`);
  
//   try {
//     const session = await liveSession.findOne({ sessionId });
//     if (!session) return;

//     if (status === "PAUSED") {
//       await pauseAllProducers(sessionId, socket.id);
//     } else if (status === "ACTIVE") {
//       await resumeAllProducers(sessionId, socket.id);
//     }

//     session.status = status;
//     if (status === "ACTIVE" && emitEvent === "streamer_started") {
//       session.actualStartTime = new Date();
//     }

//     await session.save();
//     io.to(sessionId).emit(emitEvent, { sessionId });
//     console.log(`Session ${sessionId} ${status.toLowerCase()} by streamer`);
//   } catch (err) {
//     console.error("streamer_control error:", err);
//     throw err;
//   }
// };

// const getRouterRtpCapabilitiesHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getRouterRtpCapabilities for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });
//     callback({ rtpCapabilities: state.router.rtpCapabilities });
//   } catch (error) {
//     console.error("getRouterRtpCapabilities error:", error);
//     callback({ error: error.message });
//   }
// };

// const createWebRtcTransportHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("createWebRtcTransport for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });

//     const transport = await state.router.createWebRtcTransport({
//       listenIps: [
//         {
//           ip: "0.0.0.0",
//           announcedIp: process.env.SERVER_IP || "127.0.0.1",
//         },
//       ],
//       enableUdp: true,
//       enableTcp: true,
//       preferUdp: true,
//       initialAvailableOutgoingBitrate: process.env.NODE_ENV === "production" ? 500000 : 1000000,
//     });

//     transport.on("dtlsstatechange", (dtlsState) => {
//       if (dtlsState === "closed") transport.close();
//     });

//     transport.appData = { socketId: socket.id };
//     state.transports.set(transport.id, transport);

//     callback({
//       params: {
//         id: transport.id,
//         iceParameters: transport.iceParameters,
//         iceCandidates: transport.iceCandidates,
//         dtlsParameters: transport.dtlsParameters,
//       },
//     });
//   } catch (error) {
//     console.error("createWebRtcTransport error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportConnectHandler = async (socket, sessionId, transportId, dtlsParameters, callback) => {
//   try {
//     console.log("transport-connect for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     await transport.connect({ dtlsParameters });
//     callback({ success: true });
//   } catch (error) {
//     console.error("transport-connect error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportProduceHandler = async (socket, sessionId, transportId, kind, rtpParameters, appData, callback) => {
//   try {
//     console.log("transport-produce for transport:", transportId, "kind:", kind, "source:", appData?.source);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: appData?.source || 'camera'
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("transport-produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumeHandler = async (socket, sessionId, transportId, producerId, rtpCapabilities, callback) => {
//   try {
//     console.log("consume for producer:", producerId, "transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) {
//       console.log("❌ Router not found for session:", sessionId);
//       return callback({ error: "Router not found" });
//     }

//     const producer = state.producers.get(producerId);
//     if (!producer) {
//       console.log("❌ Producer not found:", producerId);
//       return callback({ error: "Producer not found" });
//     }

//     if (!state.router.canConsume({ producerId, rtpCapabilities })) {
//       console.log("❌ Cannot consume - router.canConsume returned false");
//       return callback({ error: "Cannot consume" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) {
//       console.log("❌ Transport not found:", transportId);
//       return callback({ error: "Transport not found" });
//     }

//     const consumer = await transport.consume({
//       producerId,
//       rtpCapabilities,
//       paused: true,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//       },
//     });

//     state.consumers.set(consumer.id, consumer);
//     console.log("✅ Consumer created:", consumer.id);

//     callback({
//       params: {
//         id: consumer.id,
//         producerId,
//         kind: consumer.kind,
//         rtpParameters: consumer.rtpParameters,
//       },
//     });
//   } catch (error) {
//     console.error("consume error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumerResumeHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-resume for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     await consumer.resume();
//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-resume error:", error);
//     callback({ error: error.message });
//   }
// };

// const getProducersHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getProducers for session:", sessionId);
//     const state = roomState.get(sessionId);
//     callback(state ? Array.from(state.producers.keys()) : []);
//   } catch (error) {
//     console.error("getProducers error:", error);
//     callback([]);
//   }
// };

// const getProducerInfoHandler = async (socket, sessionId, producerId, callback) => {
//   try {
//     console.log("getProducerInfo for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback(null);

//     const producer = state.producers.get(producerId);
//     if (!producer) return callback(null);

//     callback({
//       id: producer.id,
//       kind: producer.kind,
//       userId: socket.data?.userId,
//       socketId: producer.appData?.socketId,
//       source: producer.appData?.source || 'camera'
//     });
//   } catch (error) {
//     console.error("getProducerInfo error:", error);
//     callback(null);
//   }
// };

// const consumerReadyHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-ready for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-ready error:", error);
//     callback({ error: error.message });
//   }
// };

// const offerHandler = (socket, sessionId, targetSocketId, sdp) => {
//   console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || state.streamerSocketId !== socket.id) return;
//   safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
// };

// const answerHandler = (socket, sessionId, sdp) => {
//   console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta || meta.role === ROLE_MAP.STREAMER) return;

//   safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
// };

// const iceCandidateHandler = (socket, sessionId, targetSocketId, candidate) => {
//   console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;
//   safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
// };

// const whiteboardEventHandler = (socket, sessionId, type, data, patch) => {
//   console.log(`Whiteboard ${type} from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit(`whiteboard_${type}`, { 
//     userId: meta.userId, 
//     [`${type}Data`]: data 
//   });
  
//   scheduleFlush(sessionId, { type, payload: data, patch, at: new Date() });
// };

// const whiteboardUndoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const undoStack = wb.undoStack || [];
//   if (undoStack.length === 0) return;

//   const last = undoStack.pop();
//   wb.undoStack = undoStack.slice(-500);
//   wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_undo_applied", { last });
//   console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardRedoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const redoStack = wb.redoStack || [];
//   if (redoStack.length === 0) return;

//   const last = redoStack.pop();
//   wb.redoStack = redoStack.slice(-500);
//   wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_redo_applied", { last });
//   console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardSaveCanvasHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
//   await flushCanvasOps(sessionId).catch(err => {
//     console.error(`Error saving canvas for session ${sessionId}:`, err);
//   });
//   socket.emit("whiteboard_saved");
//   console.log(`Whiteboard saved for session: ${sessionId}`);
// };

// const cursorUpdateHandler = (socket, sessionId, position) => {
//   console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
// };

// const whiteboardStateRequestHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   socket.emit("whiteboard_state_sync", {
//     canvasData: wb.canvasData,
//     participants: wb.participants,
//     versionHistory: wb.versionHistory,
//   });
  
//   console.log(`Whiteboard state sent to socket: ${socket.id}`);
// };

// // ======= Setup Socket.io =======
// export const setupIntegratedSocket = async (server) => {
//   console.log("Setting up integrated socket");

//   try {
//     mediasoupWorker = await createMediasoupWorker();
//   } catch (error) {
//     console.error("Failed to initialize Mediasoup:", error);
//     throw error;
//   }

//   const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5174";
//   io = new Server(server, {
//     cors: {
//       origin: corsOrigin,
//       methods: ["GET", "POST"],
//       credentials: true,
//     },
//   });

//   console.log(`Socket.io configured with CORS origin: ${corsOrigin} for ${process.env.NODE_ENV} environment`);

//   io.on("connection", (socket) => {
//     console.log("New client connected:", socket.id);

//     // Room and chat events
//     socket.on("join_room", (data) => joinRoomHandler(socket, data));
//     socket.on("chat_message", (data) => chatHandler(socket, data.sessionId, data.message));
//     socket.on("streamer_control", (data) => streamerControlHandler(socket, data));
    
//     // Producer control events
//     socket.on("producer-pause", (data) => 
//       producerPauseHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-resume", (data) => 
//       producerResumeHandler(socket, data.sessionId, data.producerId)
//     );
//     socket.on("producer-close", (data) => 
//       producerCloseHandler(socket, data.sessionId, data.producerId)
//     );
    
//     // Mediasoup events
//     socket.on("getRouterRtpCapabilities", (data, cb) => 
//       getRouterRtpCapabilitiesHandler(socket, data.sessionId, cb));
    
//     socket.on("createWebRtcTransport", (data, cb) => 
//       createWebRtcTransportHandler(socket, data.sessionId, cb));
    
//     socket.on("transport-connect", (data, cb) =>
//       transportConnectHandler(socket, data.sessionId, data.transportId, data.dtlsParameters, cb)
//     );
    
//     socket.on("transport-produce", (data, cb) =>
//       transportProduceHandler(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, data.appData, cb)
//     );
    
//     // Screen share specific event
//     socket.on("transport-produce-screen", (data, cb) =>
//       handleScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//     );

//     // Viewer requests to speak
//     socket.on("viewer-audio-request", (data) => 
//       handleViewerAudioRequest(socket, data.sessionId, data.requestedUserId)
//     );

//     // Streamer responds to audio request
//     socket.on("viewer-audio-response", (data) => 
//       handleViewerAudioResponse(socket, data.sessionId, data.requesterSocketId, data.allow)
//     );

//     // Viewer produces audio (after permission granted)
//     socket.on("transport-produce-viewer-audio", (data, cb) =>
//       handleViewerAudioProduce(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
//     );

//     // Mute a viewer's audio
//     socket.on("viewer-audio-mute", (data) => 
//       handleViewerAudioMute(socket, data.sessionId, data.targetSocketId)
//     );
        
//     socket.on("consume", (data, cb) =>
//       consumeHandler(socket, data.sessionId, data.transportId, data.producerId, data.rtpCapabilities, cb)
//     );
    
//     socket.on("consumer-resume", (data, cb) =>
//       consumerResumeHandler(socket, data.sessionId, data.consumerId, cb)
//     );
    
//     socket.on("getProducers", (data, cb) =>
//       getProducersHandler(socket, data.sessionId, cb)
//     );
    
//     socket.on("getProducerInfo", (data, cb) =>
//       getProducerInfoHandler(socket, data.sessionId, data.producerId, cb)
//     );
    
//     socket.on("consumer-ready", (data, cb) =>
//       consumerReadyHandler(socket, data.sessionId, data.consumerId, cb)
//     );

//     // Whiteboard events
//     socket.on("whiteboard_draw", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "draw", data.drawData, data.patch)
//     );
    
//     socket.on("whiteboard_erase", (data) => 
//       whiteboardEventHandler(socket, data.sessionId, "erase", data.eraseData, data.patch)
//     );
    
//     socket.on("whiteboard_undo", (data) => 
//       whiteboardUndoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_redo", (data) => 
//       whiteboardRedoHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_save", (data) => 
//       whiteboardSaveCanvasHandler(socket, data.sessionId)
//     );
    
//     socket.on("whiteboard_cursor", (data) => 
//       cursorUpdateHandler(socket, data.sessionId, data.position)
//     );
    
//     socket.on("whiteboard_state_request", (data) => 
//       whiteboardStateRequestHandler(socket, data.sessionId)
//     );

//     // WebRTC events
//     socket.on("offer", (data) => 
//       offerHandler(socket, data.sessionId, data.targetSocketId, data.sdp)
//     );
    
//     socket.on("answer", (data) => 
//       answerHandler(socket, data.sessionId, data.sdp)
//     );
    
//     socket.on("ice-candidate", (data) => 
//       iceCandidateHandler(socket, data.sessionId, data.targetSocketId, data.candidate)
//     );

//     socket.on("transport-produce-screen", (data, cb) =>
//       handleScreenShareStart(socket, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
// );

//     socket.on("disconnect", () => cleanupSocketFromRoom(socket));
//   });

//   console.log("✅ Socket.io setup complete with enhanced producer control and screen sharing support");
//   return io;
// };

// // Export functions as named exports
// export { getIO };































// // app/services/socket.integrated.js
// import { Server } from "socket.io";
// import jwt from "jsonwebtoken";
// import mediasoup from "mediasoup";
// import liveSession from "../model/liveSessions/liveeSession.model.js";
// import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
// import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
// import { ROLE_MAP } from "../constant/role.js";
// import authenticationModel from "../../app/model/Authentication/authentication.model.js";

// // ======= Global Variables =======
// let io;
// let mediasoupWorker;
// const roomState = new Map(); // sessionId -> { router, transports, producers, consumers, sockets, viewers, ... }

// // ======= Utility Functions =======
// const getIO = () => {
//   if (!io) throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
//   return io;
// };

// const safeEmit = (toSocketId, event, payload) => {
//   try {
//     const s = io.sockets.sockets.get(toSocketId);
//     if (s) {
//       s.emit(event, payload);
//       console.log(`Emitted ${event} to socket: ${toSocketId}`);
//     } else {
//       console.log(`Socket not found: ${toSocketId}`);
//     }
//   } catch (err) {
//     console.error("safeEmit error:", err);
//   }
// };

// const getIceServersFromEnv = () => {
//   const isProduction = process.env.NODE_ENV === "production";
//   console.log(`Getting ICE servers for ${isProduction ? "production" : "development"} environment`);

//   const servers = [];
//   const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
//     .split(",")
//     .map(s => s.trim())
//     .filter(Boolean);

//   stunUrls.forEach(url => {
//     if (url) servers.push({ urls: url });
//   });

//   if (isProduction) {
//     const turnUrls = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//     const turnUsername = process.env.TURN_USERNAME;
//     const turnPassword = process.env.TURN_PASSWORD;

//     turnUrls.forEach(url => {
//       if (url && turnUsername && turnPassword) {
//         servers.push({
//           urls: url,
//           username: turnUsername,
//           credential: turnPassword
//         });
//       }
//     });
//   }

//   if (servers.length === 0) {
//     servers.push({ urls: "stun:stun.l.google.com:19302" });
//     servers.push({ urls: "stun:global.stun.twilio.com:3478" });
//   }

//   console.log(`Found ${servers.length} ICE servers`);
//   return servers;
// };

// // ======= Mediasoup Worker =======
// const createMediasoupWorker = async () => {
//   try {
//     const minPort = parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000;
//     const maxPort = parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999;
//     const logLevel = process.env.MEDIASOUP_LOG_LEVEL || "warn";

//     mediasoupWorker = await mediasoup.createWorker({
//       logLevel,
//       rtcMinPort: minPort,
//       rtcMaxPort: maxPort,
//     });

//     console.log(`Mediasoup Worker Created (Ports: ${minPort}-${maxPort}) for ${process.env.NODE_ENV} environment`);

//     mediasoupWorker.on("died", () => {
//       console.error("Mediasoup worker died, restarting in 2 seconds...");
//       setTimeout(() => createMediasoupWorker().catch(console.error), 2000);
//     });

//     return mediasoupWorker;
//   } catch (error) {
//     console.error("Failed to create Mediasoup worker:", error);
//     throw error;
//   }
// };

// // ======= Whiteboard batching helpers =======
// const flushCanvasOps = async (sessionId) => {
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

//   if (state.flushTimer) {
//     clearTimeout(state.flushTimer);
//     state.flushTimer = null;
//   }

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
// };

// const scheduleFlush = (sessionId, op) => {
//   // pushes op and schedule flush after 2s if not already scheduled
//   const state = roomState.get(sessionId);
//   if (!state) return;
//   if (!state.pendingOps) state.pendingOps = [];
//   state.pendingOps.push(op);

//   if (state.flushTimer) return;
//   state.flushTimer = setTimeout(() => {
//     flushCanvasOps(sessionId).catch(err => {
//       console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
//     });
//   }, 2000);
// };

// // ======= Room init helper =======
// export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
//   if (!roomState.has(sessionId)) {
//     roomState.set(sessionId, {
//       whiteboardId,
//       createdBy,
//       streamerSocketId: null,
//       viewers: new Set(),
//       sockets: new Map(),    // socketId -> { userId, role }
//       pendingOps: [],
//       flushTimer: null,
//       router: null,
//       transports: new Map(), // transportId -> transport
//       producers: new Map(),  // producerId -> producer
//       consumers: new Map(),  // consumerId -> consumer
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

// // ======= Cleanup logic (on disconnect) =======
// const cleanupSocketFromRoom = async (socket) => {
//   console.log(`Cleanup requested for socket: ${socket.id}`);
//   try {
//     const sid = socket.data?.sessionId;
//     if (!sid) {
//       console.log(`No session ID found for socket: ${socket.id}`);
//       return;
//     }

//     const state = roomState.get(sid);
//     if (!state) {
//       console.log(`No state found for session: ${sid}`);
//       return;
//     }

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.log(`No metadata found for socket: ${socket.id}`);
//       return;
//     }

//     // Close consumers created for this socket
//     for (const [consumerId, consumer] of state.consumers) {
//       try {
//         if (consumer?.appData?.socketId === socket.id) {
//           consumer.close();
//           state.consumers.delete(consumerId);
//           console.log(`Consumer ${consumerId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Consumer cleanup error:", e);
//       }
//     }

//     // Close transports created by this socket
//     for (const [transportId, transport] of state.transports) {
//       try {
//         if (transport?.appData?.socketId === socket.id) {
//           transport.close();
//           state.transports.delete(transportId);
//           console.log(`Transport ${transportId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Transport cleanup error:", e);
//       }
//     }

//     // Close producers created by this socket
//     for (const [producerId, producer] of state.producers) {
//       try {
//         if (producer?.appData?.socketId === socket.id) {
//           // notify others producer removed
//           io.to(sid).emit("producer_closed", { producerId, socketId: socket.id });
//           producer.close();
//           state.producers.delete(producerId);
//           console.log(`Producer ${producerId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Producer cleanup error:", e);
//       }
//     }

//     // Whiteboard soft leave
//     if (state.whiteboardId) {
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb) {
//         const participant = wb.participants.find(p => p.user.toString() === meta.userId);
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//         }
//         await wb.save();
//         console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
//       }
//     }

//     // Update participant record in DB
//     if (meta.role !== ROLE_MAP.STREAMER) {
//       try {
//         const participant = await liveSessionParticipant.findOne({
//           $or: [{ sessionId: sid, userId: meta.userId }, { socketId: socket.id }]
//         });

//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//           participant.isActiveDevice = false;
//           await participant.save();
//           console.log(`Participant ${meta.userId} marked as LEFT`);
//         }
//       } catch (e) {
//         console.error("cleanup update error:", e?.message || e);
//       }

//       state.viewers.delete(socket.id);
//       io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
//       console.log(`Viewer ${socket.id} left room ${sid}`);
//     } else {
//       // Streamer left - pause session
//       state.streamerSocketId = null;
//       console.log(`Streamer ${socket.id} left room ${sid}`);

//       if (state.router) {
//         try {
//           state.router.close();
//           console.log(`Mediasoup router closed for session: ${sid}`);
//         } catch (e) {
//           console.warn("Error closing router:", e);
//         }
//         state.router = null;
//       }

//       const session = await liveSession.findOne({ sessionId: sid });
//       if (session) {
//         session.status = "PAUSED";
//         await session.save();
//         console.log(`Session ${sid} paused due to streamer leaving`);
//       }

//       io.to(sid).emit("session_paused_or_ended_by_streamer");
//     }

//     state.sockets.delete(socket.id);
//     socket.leave(sid);
//     console.log(`Socket ${socket.id} removed from room state for session: ${sid}`);

//     // Clean up room if empty
//     if (state.sockets.size === 0) {
//       if (state.pendingOps && state.pendingOps.length > 0) {
//         await flushCanvasOps(sid).catch(err => {
//           console.error(`Error flushing canvas ops during cleanup for session ${sid}:`, err);
//         });
//       }

//       if (state.flushTimer) clearTimeout(state.flushTimer);
//       roomState.delete(sid);
//       console.log(`Room state cleaned up for session: ${sid}`);
//     }
//   } catch (e) {
//     console.error("cleanupSocketFromRoom error:", e?.message || e);
//   }
// };

// // ======= Handlers =======

// /**
//  * joinRoomHandler
//  * data: { token, sessionId, roomCode }
//  */
// const joinRoomHandler = async (socket, data) => {
//   const { token, sessionId, roomCode } = data || {};
//   console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);

//   try {
//     if (!token || (!sessionId && !roomCode)) {
//       return socket.emit("error_message", "Missing token or sessionId/roomCode");
//     }

//     let decoded;
//     try {
//       decoded = jwt.verify(token, process.env.SECRET_KEY);
//       console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
//     } catch (err) {
//       return socket.emit("error_message", "Invalid token");
//     }

//     const userId = decoded.userId;
//     const userRole = decoded.role;

//     let session;
//     if (sessionId) {
//       session = await liveSession.findOne({ sessionId });
//     } else {
//       session = await liveSession.findOne({ roomCode });
//     }

//     if (!session) return socket.emit("error_message", "Session not found");
//     if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
//       return socket.emit("error_message", `Session is ${session.status}`);
//     }

//     if (session.isPrivate) {
//       const allowed = Array.isArray(session.allowedUsers) &&
//         session.allowedUsers.some(u => u.toString() === userId);
//       if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
//     }

//     // Use session.sessionId as key
//     const sid = session.sessionId;
//     if (!roomState.has(sid)) {
//       roomState.set(sid, {
//         whiteboardId: session.whiteboardId || null,
//         createdBy: session.streamerId ? session.streamerId.toString() : null,
//         streamerSocketId: null,
//         viewers: new Set(),
//         sockets: new Map(),
//         pendingOps: [],
//         flushTimer: null,
//         router: null,
//         transports: new Map(),
//         producers: new Map(),
//         consumers: new Map(),
//       });
//       console.log(`New room state created for session: ${sid}`);
//     }

//     const state = roomState.get(sid);

//     // Max participants check
//     const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
//     const activeCount = await liveSessionParticipant.countDocuments({
//       sessionId: session._id,
//       status: { $ne: "LEFT" }
//     });

//     if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
//       return socket.emit("error_message", "Max participants limit reached");
//     }

//     // Check if banned
//     let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
//     if (participant && participant.isBanned) {
//       return socket.emit("error_message", "You are banned from this session");
//     }

//     if (!participant) {
//       participant = await liveSessionParticipant.create({
//         sessionId: session._id,
//         userId,
//         socketId: socket.id,
//         status: "JOINED",
//         isActiveDevice: true,
//         joinedAt: new Date(),
//       });
//       session.totalJoins = (session.totalJoins || 0) + 1;
//       await session.save();
//       console.log(`New participant created, total joins: ${session.totalJoins}`);
//     } else {
//       participant.socketId = socket.id;
//       participant.status = "JOINED";
//       participant.isActiveDevice = true;
//       participant.joinedAt = new Date();
//       participant.leftAt = null;
//       await participant.save();
//     }

//     // Create Mediasoup Router if streamer and not exists
//     if (userRole === ROLE_MAP.STREAMER && !state.router) {
//       console.log("Creating Mediasoup router for session:", sid);
//       const mediaCodecs = [
//         {
//           kind: "audio",
//           mimeType: "audio/opus",
//           clockRate: 48000,
//           channels: 2,
//         },
//         {
//           kind: "video",
//           mimeType: "video/VP8",
//           clockRate: 90000,
//           parameters: {
//             "x-google-start-bitrate": process.env.NODE_ENV === "production" ? 500000 : 1000000,
//           },
//         },
//       ];

//       state.router = await mediasoupWorker.createRouter({ mediaCodecs });
//       console.log("Mediasoup router created for session:", sid);
//     }

//     // Save socket meta & join room
//     state.sockets.set(socket.id, { userId, role: userRole });
//     socket.data = { sessionId: sid, userId, role: userRole };
//     socket.join(sid);
//     console.log(`Socket ${socket.id} joined room ${sid}`);

//     // Send ICE servers to client upon joining
//     const iceServers = getIceServersFromEnv();
//     socket.emit("ice_servers", iceServers);

//     if (userRole === ROLE_MAP.STREAMER) {
//       if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
//         return socket.emit("error_message", "Streamer already connected");
//       }

//       state.streamerSocketId = socket.id;
//       socket.emit("joined_room", {
//         as: "STREAMER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers
//       });
//       console.log(`Streamer ${socket.id} joined room ${sid}`);
//     } else {
//       state.viewers.add(socket.id);
//       socket.emit("joined_room", {
//         as: "VIEWER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         whiteboardId: state.whiteboardId,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers
//       });
//       console.log(`Viewer ${socket.id} joined room ${sid}`);

//       // Notify streamer that a viewer arrived (useful for UI)
//       if (state.streamerSocketId) {
//         safeEmit(state.streamerSocketId, "viewer_ready", {
//           viewerSocketId: socket.id,
//           viewerUserId: userId
//         });
//       }
//     }

//     // Add to whiteboard participants if applicable
//     if (state.whiteboardId) {
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
//         wb.participants.push({
//           user: userId,
//           role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer",
//           joinedAt: new Date()
//         });
//         await wb.save();
//         console.log(`User added to whiteboard: ${state.whiteboardId}`);
//       }
//     }

//     // update peak participants
//     const currentParticipants = state.viewers.size + (state.streamerSocketId ? 1 : 0);
//     if ((session.peakParticipants || 0) < currentParticipants) {
//       session.peakParticipants = currentParticipants;
//       await session.save();
//       console.log(`New peak participants: ${currentParticipants}`);
//     }
//   } catch (err) {
//     console.error("join_room error:", err);
//     socket.emit("error_message", "Invalid token/session");
//     throw err;
//   }
// };

// // ===== Chat =====
// const chatHandler = async (socket, sessionId, message) => {
//   console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}`);

//   try {
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     // (Optimization) - store user name at join time to avoid db call each message.
//     const sender = await authenticationModel.findById(meta.userId).select("name");

//     io.to(sessionId).emit("chat_message", {
//       userId: meta.userId,
//       name: sender?.name || "Unknown",
//       message,
//       socketId: socket.id,
//       at: new Date(),
//     });

//     console.log(`Chat message broadcast to session: ${sessionId}`);
//   } catch (err) {
//     console.error("chat_message error:", err);
//     throw err;
//   }
// };

// // ===== Streamer control (pause/start) =====
// const streamerControlHandler = async (sessionId, status, emitEvent) => {
//   console.log(`Streamer control request for session: ${sessionId}, status: ${status}`);

//   try {
//     const session = await liveSession.findOne({ sessionId });
//     if (!session) return;

//     session.status = status;
//     if (status === "ACTIVE" && emitEvent === "streamer_started") {
//       session.actualStartTime = new Date();
//     }

//     await session.save();
//     io.to(sessionId).emit(emitEvent, { sessionId });
//     console.log(`Session ${sessionId} ${status.toLowerCase()} by streamer`);
//   } catch (err) {
//     console.error("streamer_control error:", err);
//     throw err;
//   }
// };

// // ===== Mediasoup / WebRTC handlers =====

// const getRouterRtpCapabilitiesHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getRouterRtpCapabilities for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });
//     callback({ rtpCapabilities: state.router.rtpCapabilities });
//   } catch (error) {
//     console.error("getRouterRtpCapabilities error:", error);
//     callback({ error: error.message });
//   }
// };

// const createWebRtcTransportHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("createWebRtcTransport for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });

//     const transport = await state.router.createWebRtcTransport({
//       listenIps: [
//         {
//           ip: "0.0.0.0",
//           announcedIp: process.env.SERVER_IP || "127.0.0.1",
//         },
//       ],
//       enableUdp: true,
//       enableTcp: true,
//       preferUdp: true,
//       initialAvailableOutgoingBitrate: process.env.NODE_ENV === "production" ? 500000 : 1000000,
//     });

//     transport.on("dtlsstatechange", (dtlsState) => {
//       if (dtlsState === "closed") transport.close();
//     });

//     transport.appData = { socketId: socket.id };
//     state.transports.set(transport.id, transport);

//     callback({
//       params: {
//         id: transport.id,
//         iceParameters: transport.iceParameters,
//         iceCandidates: transport.iceCandidates,
//         dtlsParameters: transport.dtlsParameters,
//       },
//     });
//   } catch (error) {
//     console.error("createWebRtcTransport error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportConnectHandler = async (socket, sessionId, transportId, dtlsParameters, callback) => {
//   try {
//     console.log("transport-connect for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     await transport.connect({ dtlsParameters });
//     callback({ success: true });
//   } catch (error) {
//     console.error("transport-connect error:", error);
//     callback({ error: error.message });
//   }
// };

// /**
//  * transportProduceHandler
//  * - called by streamer or viewer to produce audio/video
//  * - after producing, server stores producer and NOTIFIES others via "new_producer"
//  */
// const transportProduceHandler = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("transport-produce for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // cleanup on transport close
//     producer.on("transportclose", () => {
//       console.log("Producer transport closed:", producer.id);
//       try { producer.close(); } catch (e) {}
//       state.producers.delete(producer.id);
//       io.to(sessionId).emit("producer_closed", { producerId: producer.id, socketId: socket.id });
//     });

//     // cleanup on producer close
//     producer.on("close", () => {
//       state.producers.delete(producer.id);
//       io.to(sessionId).emit("producer_closed", { producerId: producer.id, socketId: socket.id });
//     });

//     callback({ id: producer.id });

//     // IMPORTANT: notify everybody (except producer) that a new producer is available
//     // This is the event consumers (streamer or viewers) listen to and then call `consume`.
//     socket.to(sessionId).emit("new_producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data?.userId,
//       socketId: socket.id
//     });

//     console.log(`Producer created: ${producer.id} (kind=${producer.kind}) for session: ${sessionId}`);
//   } catch (error) {
//     console.error("transport-produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumeHandler = async (socket, sessionId, transportId, producerId, rtpCapabilities, callback) => {
//   try {
//     console.log("consume for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });

//     const producer = state.producers.get(producerId);
//     if (!producer) return callback({ error: "Producer not found" });

//     if (!state.router.canConsume({ producerId, rtpCapabilities })) {
//       return callback({ error: "Cannot consume" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const consumer = await transport.consume({
//       producerId,
//       rtpCapabilities,
//       paused: true, // pause initially; client will call consumerResume after setup
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//       },
//     });

//     state.consumers.set(consumer.id, consumer);

//     consumer.on("transportclose", () => {
//       console.log("Consumer transport closed:", consumer.id);
//       try { consumer.close(); } catch (e) {}
//       state.consumers.delete(consumer.id);
//     });

//     consumer.on("producerclose", () => {
//       // if producer closed, notify client
//       try { consumer.close(); } catch (e) {}
//       state.consumers.delete(consumer.id);
//       socket.emit("consumer_closed", { consumerId: consumer.id, producerId });
//     });

//     callback({
//       params: {
//         id: consumer.id,
//         producerId,
//         kind: consumer.kind,
//         rtpParameters: consumer.rtpParameters,
//       },
//     });
//   } catch (error) {
//     console.error("consume error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumerResumeHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-resume for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     await consumer.resume();
//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-resume error:", error);
//     callback({ error: error.message });
//   }
// };

// const getProducersHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getProducers for session:", sessionId);
//     const state = roomState.get(sessionId);
//     callback(state ? Array.from(state.producers.keys()) : []);
//   } catch (error) {
//     console.error("getProducers error:", error);
//     callback([]);
//   }
// };

// const getProducerInfoHandler = async (socket, sessionId, producerId, callback) => {
//   try {
//     console.log("getProducerInfo for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback(null);

//     const producer = state.producers.get(producerId);
//     if (!producer) return callback(null);

//     callback({
//       id: producer.id,
//       kind: producer.kind,
//       userId: producer.appData?.userId || null,
//       socketId: producer.appData?.socketId || null
//     });
//   } catch (error) {
//     console.error("getProducerInfo error:", error);
//     callback(null);
//   }
// };

// const consumerReadyHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-ready for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-ready error:", error);
//     callback({ error: error.message });
//   }
// };

// // ===== Signalling fallback (offer/answer/candidates) =====
// const offerHandler = (socket, sessionId, targetSocketId, sdp) => {
//   console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
// };

// const answerHandler = (socket, sessionId, sdp) => {
//   console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   // send answer to streamer (fallback usage)
//   if (state.streamerSocketId) {
//     safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
//   }
// };

// const iceCandidateHandler = (socket, sessionId, targetSocketId, candidate) => {
//   console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
// };

// // ===== Whiteboard handlers (already implemented, hooked below) =====
// const whiteboardEventHandler = (socket, sessionId, type, data, patch) => {
//   console.log(`Whiteboard ${type} from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit(`whiteboard_${type}`, {
//     userId: meta.userId,
//     [`${type}Data`]: data
//   });

//   scheduleFlush(sessionId, { type, payload: data, patch, at: new Date() });
// };

// const whiteboardUndoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const undoStack = wb.undoStack || [];
//   if (undoStack.length === 0) return;

//   const last = undoStack.pop();
//   wb.undoStack = undoStack.slice(-500);
//   wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();

//   await wb.save();
//   io.to(sessionId).emit("whiteboard_undo_applied", { last });
//   console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardRedoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const redoStack = wb.redoStack || [];
//   if (redoStack.length === 0) return;

//   const last = redoStack.pop();
//   wb.redoStack = redoStack.slice(-500);
//   wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();

//   await wb.save();
//   io.to(sessionId).emit("whiteboard_redo_applied", { last });
//   console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardSaveCanvasHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
//   await flushCanvasOps(sessionId).catch(err => {
//     console.error(`Error saving canvas for session ${sessionId}:`, err);
//   });
//   socket.emit("whiteboard_saved");
//   console.log(`Whiteboard saved for session: ${sessionId}`);
// };

// const cursorUpdateHandler = (socket, sessionId, position) => {
//   console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
// };

// const whiteboardStateRequestHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   socket.emit("whiteboard_state_sync", {
//     canvasData: wb.canvasData,
//     participants: wb.participants,
//     versionHistory: wb.versionHistory,
//   });

//   console.log(`Whiteboard state sent to socket: ${socket.id}`);
// };

// // ======= Setup Socket.io and bind events =======
// export const setupIntegratedSocket = async (server) => {
//   console.log("Setting up integrated socket");

//   try {
//     mediasoupWorker = await createMediasoupWorker();
//   } catch (error) {
//     console.error("Failed to initialize Mediasoup:", error);
//     throw error;
//   }

//   const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5174";
//   io = new Server(server, {
//     cors: {
//       origin: corsOrigin,
//       methods: ["GET", "POST"],
//       credentials: true,
//     },
//   });

//   console.log(`Socket.io configured with CORS origin: ${corsOrigin} for ${process.env.NODE_ENV} environment`);

//   io.on("connection", (socket) => {
//     console.log("New client connected:", socket.id);

//     // Join / Session
//     socket.on("join_room", (data) => joinRoomHandler(socket, data));

//     // Chat
//     socket.on("chat_message", ({ sessionId, message }) => chatHandler(socket, sessionId, message));

//     // Streamer controls
//     socket.on("streamer_control", ({ sessionId, status, emitEvent }) => streamerControlHandler(sessionId, status, emitEvent));

//     // Mediasoup / WebRTC
//     socket.on("getRouterRtpCapabilities", (sessionId, cb) => getRouterRtpCapabilitiesHandler(socket, sessionId, cb));
//     socket.on("createWebRtcTransport", (sessionId, cb) => createWebRtcTransportHandler(socket, sessionId, cb));
//     socket.on("transport-connect", ({ sessionId, transportId, dtlsParameters }, cb) =>
//       transportConnectHandler(socket, sessionId, transportId, dtlsParameters, cb)
//     );
//     socket.on("transport-produce", ({ sessionId, transportId, kind, rtpParameters }, cb) =>
//       transportProduceHandler(socket, sessionId, transportId, kind, rtpParameters, cb)
//     );
//     socket.on("consume", ({ sessionId, transportId, producerId, rtpCapabilities }, cb) =>
//       consumeHandler(socket, sessionId, transportId, producerId, rtpCapabilities, cb)
//     );
//     socket.on("consumer-resume", ({ sessionId, consumerId }, cb) =>
//       consumerResumeHandler(socket, sessionId, consumerId, cb)
//     );
//     socket.on("getProducers", (sessionId, cb) => getProducersHandler(socket, sessionId, cb));
//     socket.on("getProducerInfo", ({ sessionId, producerId }, cb) => getProducerInfoHandler(socket, sessionId, producerId, cb));
//     socket.on("consumer-ready", ({ sessionId, consumerId }, cb) => consumerReadyHandler(socket, sessionId, consumerId, cb));

//     // Signaling fallback
//     socket.on("offer", ({ sessionId, targetSocketId, sdp }) => offerHandler(socket, sessionId, targetSocketId, sdp));
//     socket.on("answer", ({ sessionId, sdp }) => answerHandler(socket, sessionId, sdp));
//     socket.on("ice-candidate", ({ sessionId, targetSocketId, candidate }) => iceCandidateHandler(socket, sessionId, targetSocketId, candidate));

//     // Whiteboard events
//     socket.on("whiteboard_event", ({ sessionId, type, data, patch }) => whiteboardEventHandler(socket, sessionId, type, data, patch));
//     socket.on("whiteboard_undo", ({ sessionId }) => whiteboardUndoHandler(socket, sessionId));
//     socket.on("whiteboard_redo", ({ sessionId }) => whiteboardRedoHandler(socket, sessionId));
//     socket.on("whiteboard_save", ({ sessionId }) => whiteboardSaveCanvasHandler(socket, sessionId));
//     socket.on("cursor_update", ({ sessionId, position }) => cursorUpdateHandler(socket, sessionId, position));
//     socket.on("whiteboard_state_request", ({ sessionId }) => whiteboardStateRequestHandler(socket, sessionId));

//     // Standard housekeeping
//     socket.on("disconnect", () => cleanupSocketFromRoom(socket));
//   });

//   console.log("✅ Socket.io setup complete");
//   return io;
// };

// // Export functions as named exports
// export { getIO };













// import { Server } from "socket.io";
// import jwt from "jsonwebtoken";
// import mediasoup from "mediasoup";
// import liveSession from "../model/liveSessions/liveeSession.model.js";
// import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
// import whiteboardModel from "../model/whiteBoards/whiteBoard.model.js";
// import { ROLE_MAP } from "../constant/role.js";
// import authenticationModel from "../../app/model/Authentication/authentication.model.js";

// // ======= Global Variables =======
// let io;
// let mediasoupWorker;
// const roomState = new Map();

// // ======= Utility Functions =======
// const getIO = () => {
//   if (!io) throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
//   return io;
// };

// const safeEmit = (toSocketId, event, payload, callback) => {
//   try {
//     const s = io.sockets.sockets.get(toSocketId);
//     if (s) {
//       s.emit(event, payload, callback);
//       console.log(`✅ Emitted ${event} to socket: ${toSocketId}`);
//     } else {
//       console.log(`⚠️ Socket not found: ${toSocketId}`);
//     }
//   } catch (err) {
//     console.error("❌ safeEmit error:", err);
//   }
// };


// const getIceServersFromEnv = () => {
//   const isProduction = process.env.NODE_ENV === "production";
//   console.log(`Getting ICE servers for ${isProduction ? "production" : "development"} environment`);

//   const servers = [];

//   // STUN
//   const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
//     .split(",")
//     .map(s => s.trim())
//     .filter(Boolean);

//   stunUrls.forEach(url => servers.push({ urls: url }));

//   // TURN (only in production)
//   if (isProduction) {
//     const turnUrls = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//     const { TURN_USERNAME: username, TURN_PASSWORD: credential } = process.env;

//     turnUrls.forEach(url => {
//       if (url && username && credential) {
//         servers.push({ urls: url, username, credential });
//       }
//     });
//   }

//   if (servers.length === 0) {
//     servers.push({ urls: "stun:stun.l.google.com:19302" });
//     servers.push({ urls: "stun:global.stun.twilio.com:3478" });
//   }

//   console.log(`Found ${servers.length} ICE servers`);
//   return servers;
// };

// const createMediasoupWorker = async () => {
//   try {
//     const minPort = parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000;
//     const maxPort = parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999;
//     const logLevel = process.env.MEDIASOUP_LOG_LEVEL || "warn";

//     mediasoupWorker = await mediasoup.createWorker({
//       logLevel,
//       rtcMinPort: minPort,
//       rtcMaxPort: maxPort,
//     });

//     console.log(`🎯 Mediasoup Worker Created (Ports: ${minPort}-${maxPort}) for ${process.env.NODE_ENV} environment`);

//     mediasoupWorker.on("died", () => {
//       console.error("❌ Mediasoup worker died, restarting in 2 seconds...");
//       setTimeout(() => createMediasoupWorker().catch(console.error), 2000);
//     });

//     return mediasoupWorker;
//   } catch (error) {
//     console.error("Failed to create Mediasoup worker:", error);
//     throw error;
//   }
// };


// const flushCanvasOps = async (sessionId) => {
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
  
//   if (state.flushTimer) {
//     clearTimeout(state.flushTimer);
//     state.flushTimer = null;
//   }

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
// };

// const scheduleFlush = (sessionId, op) => {
//   console.log(`Scheduling flush for session: ${sessionId}, operation type: ${op?.type}`);
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
  
//   state.flushTimer = setTimeout(() => {
//     flushCanvasOps(sessionId).catch(err => {
//       console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
//     });
//   }, 2000);
  
//   console.log(`Flush scheduled for session: ${sessionId}`);
// };

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
//       router: null,
//       transports: new Map(),
//       producers: new Map(),
//       consumers: new Map(),
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

// const cleanupSocketFromRoom = async (socket) => {
//   console.log(`Cleanup requested for socket: ${socket.id}`);
//   try {
//     const sid = socket.data?.sessionId;
//     if (!sid) {
//       console.log(`No session ID found for socket: ${socket.id}`);
//       return;
//     }
    
//     const state = roomState.get(sid);
//     if (!state) {
//       console.log(`No state found for session: ${sid}`);
//       return;
//     }

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.log(`No metadata found for socket: ${socket.id}`);
//       return;
//     }

//     // Cleanup Mediasoup resources
//     for (const [consumerId, consumer] of state.consumers) {
//       try {
//         if (consumer?.appData?.socketId === socket.id) {
//           consumer.close();
//           state.consumers.delete(consumerId);
//           console.log(`Consumer ${consumerId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Consumer cleanup error:", e);
//       }
//     }

//     for (const [transportId, transport] of state.transports) {
//       try {
//         if (transport?.appData?.socketId === socket.id) {
//           transport.close();
//           state.transports.delete(transportId);
//           console.log(`Transport ${transportId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Transport cleanup error:", e);
//       }
//     }

//     for (const [producerId, producer] of state.producers) {
//       try {
//         if (producer?.appData?.socketId === socket.id) {
//           producer.close();
//           state.producers.delete(producerId);
//           console.log(`Producer ${producerId} cleaned up for socket: ${socket.id}`);
//         }
//       } catch (e) {
//         console.warn("Producer cleanup error:", e);
//       }
//     }

//     // Whiteboard soft leave
//     if (state.whiteboardId) {
//       console.log(`Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`);
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb) {
//         const participant = wb.participants.find(p => p.user.toString() === meta.userId);
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//         }
//         await wb.save();
//         console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
//       }
//     }

//     // Update participant record
//     if (meta.role !== ROLE_MAP.STREAMER) {
//       try {
//         const participant = await liveSessionParticipant.findOne({ 
//           $or: [
//             { sessionId: sid, userId: meta.userId },
//             { socketId: socket.id }
//           ]
//         });
        
//         if (participant) {
//           participant.status = "LEFT";
//           participant.leftAt = new Date();
//           participant.isActiveDevice = false;
//           await participant.save();
//           console.log(`Participant ${meta.userId} marked as LEFT`);
//         }
//       } catch (e) {
//         console.error("cleanup update error:", e?.message || e);
//       }

//       state.viewers.delete(socket.id);
//       io.to(sid).emit("user_left", { userId: meta.userId, socketId: socket.id });
//       console.log(`Viewer ${socket.id} left room ${sid}`);
//     } else {
//       // Streamer left - pause session
//       state.streamerSocketId = null;
//       console.log(`Streamer ${socket.id} left room ${sid}`);

//       // Cleanup Mediasoup router when streamer leaves
//       if (state.router) {
//         try {
//           state.router.close();
//           console.log(`Mediasoup router closed for session: ${sid}`);
//         } catch (e) {
//           console.warn("Error closing router:", e);
//         }
//         state.router = null;
//       }

//       const session = await liveSession.findOne({ sessionId: sid });
//       if (session) {
//         session.status = "PAUSED";
//         await session.save();
//         console.log(`Session ${sid} paused due to streamer leaving`);
//       }

//       io.to(sid).emit("session_paused_or_ended_by_streamer");
//     }

//     state.sockets.delete(socket.id);
//     socket.leave(sid);
//     console.log(`Socket ${socket.id} removed from room state for session: ${sid}`);

//     // Clean up empty room state
//     if (state.sockets.size === 0) {
//       if (state.pendingOps && state.pendingOps.length > 0) {
//         await flushCanvasOps(sid).catch(err => {
//           console.error(`Error flushing canvas ops during cleanup for session ${sid}:`, err);
//         });
//       }

//       if (state.flushTimer) clearTimeout(state.flushTimer);
//       roomState.delete(sid);
//       console.log(`Room state cleaned up for session: ${sid}`);
//     }
//   } catch (e) {
//     console.error("cleanupSocketFromRoom error:", e?.message || e);
//   }
// };

// // ======= Handler Functions =======
// const joinRoomHandler = async (socket, data) => {
//   const { token, sessionId, roomCode } = data;
//   console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);
  
//   try {
//     if (!token || (!sessionId && !roomCode)) {
//       return socket.emit("error_message", "Missing token or sessionId/roomCode");
//     }

//     let decoded;
//     try {
//       decoded = jwt.verify(token, process.env.SECRET_KEY);
//       console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
//     } catch (err) {
//       return socket.emit("error_message", "Invalid token");
//     }
    
//     const userId = decoded.userId;
//     const userRole = decoded.role;

//     let session;
//     if (sessionId) {
//       session = await liveSession.findOne({ sessionId });
//     } else {
//       session = await liveSession.findOne({ roomCode });
//     }

//     if (!session) return socket.emit("error_message", "Session not found");
//     if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
//       return socket.emit("error_message", `Session is ${session.status}`);
//     }

//     if (session.isPrivate) {
//       const allowed = Array.isArray(session.allowedUsers) && 
//         session.allowedUsers.some(u => u.toString() === userId);
//       if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
//     }

//     // Use sessionId as key
//     const sid = session.sessionId;
//     if (!roomState.has(sid)) {
//       roomState.set(sid, {
//         whiteboardId: session.whiteboardId || null,
//         createdBy: session.streamerId ? session.streamerId.toString() : null,
//         streamerSocketId: null,
//         viewers: new Set(),
//         sockets: new Map(),
//         pendingOps: [],
//         flushTimer: null,
//         router: null,
//         transports: new Map(),
//         producers: new Map(),
//         consumers: new Map(),
//       });
//       console.log(`New room state created for session: ${sid}`);
//     }
    
//     const state = roomState.get(sid);

//     // Max participants check
//     const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
//     const activeCount = await liveSessionParticipant.countDocuments({ 
//       sessionId: session._id, 
//       status: { $ne: "LEFT" } 
//     });
    
//     if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
//       return socket.emit("error_message", "Max participants limit reached");
//     }

//     // Check if banned
//     let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
//     if (participant && participant.isBanned) {
//       return socket.emit("error_message", "You are banned from this session");
//     }

//     if (!participant) {
//       participant = await liveSessionParticipant.create({
//         sessionId: session._id,
//         userId,
//         socketId: socket.id,
//         status: "JOINED",
//         isActiveDevice: true,
//         joinedAt: new Date(),
//       });
//       session.totalJoins = (session.totalJoins || 0) + 1;
//       await session.save();
//       console.log(`New participant created, total joins: ${session.totalJoins}`);
//     } else {
//       participant.socketId = socket.id;
//       participant.status = "JOINED";
//       participant.isActiveDevice = true;
//       participant.joinedAt = new Date();
//       participant.leftAt = null;
//       await participant.save();
//     }

//     // Create Mediasoup Router if streamer and not exists
//     if (userRole === ROLE_MAP.STREAMER && !state.router) {
//       console.log("Creating Mediasoup router for session:", sid);
//       const mediaCodecs = [
//         {
//           kind: "audio",
//           mimeType: "audio/opus",
//           clockRate: 48000,
//           channels: 2,
//         },
//         {
//           kind: "video",
//           mimeType: "video/VP8",
//           clockRate: 90000,
//           parameters: {
//             "x-google-start-bitrate": process.env.NODE_ENV === "production" ? 500000 : 1000000,
//           },
//         },
//       ];

//       state.router = await mediasoupWorker.createRouter({ mediaCodecs });
//       console.log("Mediasoup router created for session:", sid);
//     }

//     // Join room
//     state.sockets.set(socket.id, { userId, role: userRole });
//     socket.data = { sessionId: sid, userId, role: userRole };
//     socket.join(sid);
//     console.log(`Socket ${socket.id} joined room ${sid}`);

//     // Send ICE servers to client upon joining
//     const iceServers = getIceServersFromEnv();
//     socket.emit("ice_servers", iceServers);

//     if (userRole === ROLE_MAP.STREAMER) {
//       if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
//         return socket.emit("error_message", "Streamer already connected");
//       }
      
//       state.streamerSocketId = socket.id;
//       socket.emit("joined_room", {
//         as: "STREAMER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers
//       });
//       console.log(`Streamer ${socket.id} joined room ${sid}`);
//     } else {
//       state.viewers.add(socket.id);
//       socket.emit("joined_room", {
//         as: "VIEWER",
//         sessionId: sid,
//         roomCode: session.roomCode,
//         whiteboardId: state.whiteboardId,
//         hasMediasoup: !!state.router,
//         environment: process.env.NODE_ENV,
//         iceServers: iceServers
//       });
//       console.log(`Viewer ${socket.id} joined room ${sid}`);
      
//       if (state.streamerSocketId) {
//         safeEmit(state.streamerSocketId, "viewer_ready", { 
//           viewerSocketId: socket.id, 
//           viewerUserId: userId 
//         });
//       }
//     }

//     if (state.whiteboardId) {
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
//         wb.participants.push({ 
//           user: userId, 
//           role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", 
//           joinedAt: new Date() 
//         });
//         await wb.save();
//         console.log(`User added to whiteboard: ${state.whiteboardId}`);
//       }
//     }

//     const currentParticipants = state.viewers.size + (state.streamerSocketId ? 1 : 0);
//     if ((session.peakParticipants || 0) < currentParticipants) {
//       session.peakParticipants = currentParticipants;
//       await session.save();
//       console.log(`New peak participants: ${currentParticipants}`);
//     }
//   } catch (err) {
//     console.error("join_room error:", err);
//     socket.emit("error_message", "Invalid token/session");
//     throw err;
//   }
// };

// const chatHandler = async (socket, sessionId, message) => {
//   console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}`);
  
//   try {
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const sender = await authenticationModel.findById(meta.userId).select("name");
    
//     io.to(sessionId).emit("chat_message", {
//       userId: meta.userId,
//       name: sender?.name || "Unknown",
//       message,
//       socketId: socket.id,
//       at: new Date(),
//     });
    
//     console.log(`Chat message broadcast to session: ${sessionId}`);
//   } catch (err) {
//     console.error("chat_message error:", err);
//     throw err;
//   }
// };

// const streamerControlHandler = async (sessionId, status, emitEvent) => {
//   console.log(`Streamer control request for session: ${sessionId}, status: ${status}`);
  
//   try {
//     const session = await liveSession.findOne({ sessionId });
//     if (!session) return;

//     session.status = status;
//     if (status === "ACTIVE" && emitEvent === "streamer_started") {
//       session.actualStartTime = new Date();
//     }

//     await session.save();
//     io.to(sessionId).emit(emitEvent, { sessionId });
//     console.log(`Session ${sessionId} ${status.toLowerCase()} by streamer`);
//   } catch (err) {
//     console.error("streamer_control error:", err);
//     throw err;
//   }
// };

// const getRouterRtpCapabilitiesHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getRouterRtpCapabilities for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });
//     callback({ rtpCapabilities: state.router.rtpCapabilities });
//   } catch (error) {
//     console.error("getRouterRtpCapabilities error:", error);
//     callback({ error: error.message });
//   }
// };

// const createWebRtcTransportHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("createWebRtcTransport for session:", sessionId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });

//     const transport = await state.router.createWebRtcTransport({
//       listenIps: [
//         {
//           ip: "0.0.0.0",
//           announcedIp: process.env.SERVER_IP || "127.0.0.1",
//         },
//       ],
//       enableUdp: true,
//       enableTcp: true,
//       preferUdp: true,
//       initialAvailableOutgoingBitrate: process.env.NODE_ENV === "production" ? 500000 : 1000000,
//     });

//     transport.on("dtlsstatechange", (dtlsState) => {
//       if (dtlsState === "closed") transport.close();
//     });

//     transport.appData = { socketId: socket.id };
//     state.transports.set(transport.id, transport);

//     callback({
//       params: {
//         id: transport.id,
//         iceParameters: transport.iceParameters,
//         iceCandidates: transport.iceCandidates,
//         dtlsParameters: transport.dtlsParameters,
//       },
//     });
//   } catch (error) {
//     console.error("createWebRtcTransport error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportConnectHandler = async (socket, sessionId, transportId, dtlsParameters, callback) => {
//   try {
//     console.log("transport-connect for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     await transport.connect({ dtlsParameters });
//     callback({ success: true });
//   } catch (error) {
//     console.error("transport-connect error:", error);
//     callback({ error: error.message });
//   }
// };

// const transportProduceHandler = async (socket, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("transport-produce for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//       },
//     });

//     state.producers.set(producer.id, producer);

//     producer.on("transportclose", () => {
//       console.log("Producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//     callback({ id: producer.id });

//     // Broadcast new producer to other participants
//     socket.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//     });
//   } catch (error) {
//     console.error("transport-produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumeHandler = async (socket, sessionId, transportId, producerId, rtpCapabilities, callback) => {
//   try {
//     console.log("consume for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return callback({ error: "Router not found" });

//     const producer = state.producers.get(producerId);
//     if (!producer) return callback({ error: "Producer not found" });

//     if (!state.router.canConsume({ producerId, rtpCapabilities })) {
//       return callback({ error: "Cannot consume" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const consumer = await transport.consume({
//       producerId,
//       rtpCapabilities,
//       paused: true,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//       },
//     });

//     state.consumers.set(consumer.id, consumer);

//     consumer.on("transportclose", () => {
//       console.log("Consumer transport closed:", consumer.id);
//       try {
//         consumer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.consumers.delete(consumer.id);
//     });

//     callback({
//       params: {
//         id: consumer.id,
//         producerId,
//         kind: consumer.kind,
//         rtpParameters: consumer.rtpParameters,
//       },
//     });
//   } catch (error) {
//     console.error("consume error:", error);
//     callback({ error: error.message });
//   }
// };

// const consumerResumeHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-resume for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     await consumer.resume();
//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-resume error:", error);
//     callback({ error: error.message });
//   }
// };

// const getProducersHandler = async (socket, sessionId, callback) => {
//   try {
//     console.log("getProducers for session:", sessionId);
//     const state = roomState.get(sessionId);
//     callback(state ? Array.from(state.producers.keys()) : []);
//   } catch (error) {
//     console.error("getProducers error:", error);
//     callback([]);
//   }
// };

// const getProducerInfoHandler = async (socket, sessionId, producerId, callback) => {
//   try {
//     console.log("getProducerInfo for producer:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback(null);

//     const producer = state.producers.get(producerId);
//     if (!producer) return callback(null);

//     callback({
//       id: producer.id,
//       kind: producer.kind,
//       userId: socket.data?.userId,
//       socketId: producer.appData?.socketId
//     });
//   } catch (error) {
//     console.error("getProducerInfo error:", error);
//     callback(null);
//   }
// };

// const consumerReadyHandler = async (socket, sessionId, consumerId, callback) => {
//   try {
//     console.log("consumer-ready for consumer:", consumerId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const consumer = state.consumers.get(consumerId);
//     if (!consumer) return callback({ error: "Consumer not found" });

//     callback({ success: true });
//   } catch (error) {
//     console.error("consumer-ready error:", error);
//     callback({ error: error.message });
//   }
// };

// const offerHandler = (socket, sessionId, targetSocketId, sdp) => {
//   console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || state.streamerSocketId !== socket.id) return;
//   safeEmit(targetSocketId, "offer", { from: socket.id, sdp });
// };

// const answerHandler = (socket, sessionId, sdp) => {
//   console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta || meta.role === ROLE_MAP.STREAMER) return;

//   safeEmit(state.streamerSocketId, "answer", { from: socket.id, sdp });
// };

// const iceCandidateHandler = (socket, sessionId, targetSocketId, candidate) => {
//   console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;
//   safeEmit(targetSocketId, "ice-candidate", { from: socket.id, candidate });
// };

// const whiteboardEventHandler = (socket, sessionId, type, data, patch) => {
//   console.log(`Whiteboard ${type} from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit(`whiteboard_${type}`, { 
//     userId: meta.userId, 
//     [`${type}Data`]: data 
//   });
  
//   scheduleFlush(sessionId, { type, payload: data, patch, at: new Date() });
// };

// const whiteboardUndoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const undoStack = wb.undoStack || [];
//   if (undoStack.length === 0) return;

//   const last = undoStack.pop();
//   wb.undoStack = undoStack.slice(-500);
//   wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_undo_applied", { last });
//   console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardRedoHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const redoStack = wb.redoStack || [];
//   if (redoStack.length === 0) return;

//   const last = redoStack.pop();
//   wb.redoStack = redoStack.slice(-500);
//   wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_redo_applied", { last });
//   console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
// };

// const whiteboardSaveCanvasHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
//   await flushCanvasOps(sessionId).catch(err => {
//     console.error(`Error saving canvas for session ${sessionId}:`, err);
//   });
//   socket.emit("whiteboard_saved");
//   console.log(`Whiteboard saved for session: ${sessionId}`);
// };

// const cursorUpdateHandler = (socket, sessionId, position) => {
//   console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
// };

// const whiteboardStateRequestHandler = async (socket, sessionId) => {
//   console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.get(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   socket.emit("whiteboard_state_sync", {
//     canvasData: wb.canvasData,
//     participants: wb.participants,
//     versionHistory: wb.versionHistory,
//   });
  
//   console.log(`Whiteboard state sent to socket: ${socket.id}`);
// };

// // ======= Setup Socket.io =======
// export const setupIntegratedSocket = async (server) => {
//   console.log("Setting up integrated socket");

//   try {
//     mediasoupWorker = await createMediasoupWorker();
//   } catch (error) {
//     console.error("Failed to initialize Mediasoup:", error);
//     throw error;
//   }

//   const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5174";
//   io = new Server(server, {
//     cors: {
//       origin: corsOrigin,
//       methods: ["GET", "POST"],
//       credentials: true,
//     },
//   });

//   console.log(`Socket.io configured with CORS origin: ${corsOrigin} for ${process.env.NODE_ENV} environment`);

// io.on("connection", (socket) => {
//   console.log("New client connected:", socket.id);

//   socket.on("join_room", (data) => joinRoomHandler(socket, data));
//   socket.on("chat_message", ({ sessionId, message }) => chatHandler(socket, sessionId, message));
//   socket.on("streamer_control", ({ sessionId, status, emitEvent }) => streamerControlHandler(sessionId, status, emitEvent));
//   socket.on("getRouterRtpCapabilities", (sessionId, cb) => getRouterRtpCapabilitiesHandler(socket, sessionId, cb));
//   socket.on("createWebRtcTransport", (sessionId, cb) => createWebRtcTransportHandler(socket, sessionId, cb));
//   socket.on("transport-connect", ({ sessionId, transportId, dtlsParameters }, cb) =>
//     transportConnectHandler(socket, sessionId, transportId, dtlsParameters, cb)
//   );
//   socket.on("transport-produce", ({ sessionId, transportId, kind, rtpParameters }, cb) =>
//     transportProduceHandler(socket, sessionId, transportId, kind, rtpParameters, cb)
//   );
//   socket.on("consume", ({ sessionId, transportId, producerId, rtpCapabilities }, cb) =>
//     consumeHandler(socket, sessionId, transportId, producerId, rtpCapabilities, cb)
//   );
//   socket.on("consumer-resume", ({ sessionId, consumerId }, cb) =>
//     consumerResumeHandler(socket, sessionId, consumerId, cb)
//   );

//   socket.on("disconnect", () => cleanupSocketFromRoom(socket));
// });


//   console.log("✅ Socket.io setup complete");
//   return io;
// };

// // Export functions as named exports
// export { getIO };


























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
