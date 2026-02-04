// services/socketUtils/general.utils.js
import { roomState } from "../socketState/roomState.js";
import liveSession from "../../model/liveSessions/liveeSession.model.js";
import liveSessionParticipant from "../../model/liveSessionParticipant/liveSessionParticipant.model.js";
import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";
import { ROLE_MAP } from "../../constant/role.js";
import { flushCanvasOps } from "./whiteboard.utils.js";

export const safeEmit = (io, toSocketId, event, payload) => {
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

 
export const getIceServersFromEnv = () => {
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

export const broadcastParticipantsList = (io, sessionId) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  const currentParticipants = Array.from(state.participants.values());
  io.to(sessionId).emit("participants_list_updated", {
    participants: currentParticipants
  });
};

export const cleanupSocketFromRoom = async (socket, io) => {
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

    // 🔥 SPEAKING & HAND RAISE STATUS RESET ADDED HERE
    if (meta.userId) {
      const participant = state.participants.get(meta.userId);
      if (participant) {
        // Notify that user stopped speaking
        if (participant.isSpeaking) {
          io.to(sid).emit("participant_speaking_status", {
            userId: meta.userId,
            isSpeaking: false,
            timestamp: new Date(),
            userName: participant.name
          });
        }

        // Notify that hand is down
        if (participant.isHandRaised) {
          io.to(sid).emit("hand_raise_status", {
            userId: meta.userId,
            isHandRaised: false,
            timestamp: new Date(),
            userName: participant.name
          });
        }
      }
    }

    if (state.pendingScreenShareRequests.has(meta.userId)) {
      state.pendingScreenShareRequests.delete(meta.userId);
    }

    if (state.activeScreenShares.has(meta.userId)) {
      await cleanupViewerScreenShare(socket, sid, meta.userId);
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

      const currentParticipants = Array.from(state.participants.values());
      // 🔴 Old event (keep for compatibility)
      io.to(sid).emit("participant_left", {
        participants: currentParticipants,
      });

      // 🟢 New event: full list
      broadcastParticipantsList(io, sid);
    }

    if (state.whiteboardId) {
      console.log(
        `Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`
      );
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

    if (meta.role !== ROLE_MAP.STREAMER) {
      try {
        const participant = await liveSessionParticipant.findOne({
          $or: [{ sessionId: sid, userId: meta.userId }, { socketId: socket.id }],
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

      io.to(sid).emit("user_left", { 
        userId: meta.userId, 
        socketId: socket.id,
        userName: meta.userName 
      });
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
        await flushCanvasOps(sid).catch((err) => {
          console.error(
            `Error flushing canvas ops during cleanup for session ${sid}:`,
            err
          );
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

const cleanupViewerScreenShare = async (socket, sessionId, userId = null) => {
  // This is a simplified version for cleanup purposes
  const state = roomState.get(sessionId);
  if (!state) return;

  const targetUserId = userId || socket.data?.userId;
  if (!targetUserId) return;

  state.activeScreenShares.delete(targetUserId);

  // Clean up screen share producers
  for (const [producerId, producer] of state.producers) {
    if (
      producer.appData?.userId === targetUserId &&
      (producer.appData?.source === "viewer-screen" ||
        producer.appData?.source === "viewer-screen-audio")
    ) {
      try {
        producer.close();
      } catch (e) {
        console.warn("Error closing screen share producer:", e);
      }
      state.producers.delete(producerId);
    }
  }
};

// Speaking detection helper functions
export const startSpeakingDetection = (io, sessionId, userId, isSpeaking) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  const participant = state.participants.get(userId);
  if (participant) {
    participant.isSpeaking = isSpeaking;
    
    // Notify all participants
    io.to(sessionId).emit("participant_speaking_status", {
      userId,
      isSpeaking,
      timestamp: new Date()
    });

    // Also update in participant list
    broadcastParticipantsList(io, sessionId);
  }
};

export const broadcastHandRaise = (io, sessionId, userId, isHandRaised) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  const participant = state.participants.get(userId);
  if (participant) {
    participant.isHandRaised = isHandRaised;
    participant.handRaisedAt = isHandRaised ? new Date() : null;
    
    // Notify all participants
    io.to(sessionId).emit("hand_raise_status", {
      userId,
      isHandRaised,
      timestamp: new Date(),
      userName: participant.name
    });

    // Update participant list
    broadcastParticipantsList(io, sessionId);
  }
};

export const resetAllHandRaised = (io, sessionId) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  let resetCount = 0;
  state.participants.forEach((participant) => {
    if (participant.isHandRaised) {
      participant.isHandRaised = false;
      participant.handRaisedAt = null;
      resetCount++;
    }
  });

  if (resetCount > 0) {
    io.to(sessionId).emit("all_hands_down", {
      timestamp: new Date()
    });
    broadcastParticipantsList(io, sessionId);
  }
};



// services/socketUtils/general.utils.js mein yeh function add karein

export const startPingPongMonitoring = (socket, io, sessionId) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  // Check if already monitoring
  if (socket.pingInterval) {
    clearInterval(socket.pingInterval);

  }

  console.log("ye streamer ka role dekhne ke liye",socket.data.role)

  // Viewer ki ping monitoring ke liye
  if (socket.data.role !== 'STREAMER') {
    socket.isAlive = true;
    
    // Ping interval (every 30 seconds)
    socket.pingInterval = setInterval(() => {
      if (!socket.isAlive) {
        // Viewer inactive hai, disconnect karo
        console.log(`❌ Viewer ${socket.id} inactive, disconnecting...`);
        cleanupInactiveViewer(socket, io, sessionId);
        return;
      }
      
      socket.isAlive = false;
      
      // Ping bhejo
      socket.emit('ping', { 
        timestamp: Date.now(),
        sessionId: sessionId
      });
      
      console.log(`📡 Ping sent to viewer ${socket.id} (session: ${sessionId})`);
    }, 30000); // 30 seconds

    // Store interval reference for cleanup
    socket.pingTimeout = setTimeout(() => {
      if (socket.pingInterval) {
        clearInterval(socket.pingInterval);
        socket.pingInterval = null;
      }
    }, 3600000); // 1 hour max
  }
};



export const handlePong = (socket) => {
  socket.isAlive = true;
  console.log(`✅ Pong received from viewer ${socket.id}`);
};

const cleanupInactiveViewer = async (socket, io, sessionId) => {
  console.log(`🧹 Cleaning up inactive viewer: ${socket.id}`);
  
  try {
    const state = roomState.get(sessionId);
    if (!state) return;

    // Clean up all producers for this viewer
    for (const [producerId, producer] of state.producers) {
      if (producer.appData?.socketId === socket.id) {
        try {
          producer.close();
        } catch (e) {
          console.warn("Error closing producer during cleanup:", e);
        }
        state.producers.delete(producerId);
        console.log(`Producer ${producerId} closed for inactive viewer`);
      }
    }

    // Clean up all consumers for this viewer
    for (const [consumerId, consumer] of state.consumers) {
      if (consumer.appData?.socketId === socket.id) {
        try {
          consumer.close();
        } catch (e) {
          console.warn("Error closing consumer during cleanup:", e);
        }
        state.consumers.delete(consumerId);
        console.log(`Consumer ${consumerId} closed for inactive viewer`);
      }
    }

    // Clean up transports
    for (const [transportId, transport] of state.transports) {
      if (transport.appData?.socketId === socket.id) {
        try {
          transport.close();
        } catch (e) {
          console.warn("Error closing transport during cleanup:", e);
        }
        state.transports.delete(transportId);
        console.log(`Transport ${transportId} closed for inactive viewer`);
      }
    }

    // Update participants list
    const meta = state.sockets.get(socket.id);
    if (meta && meta.userId) {
      state.participants.delete(meta.userId);
      
      // Notify all participants
      io.to(sessionId).emit("user_left", {
        userId: meta.userId,
        socketId: socket.id,
        reason: "inactive"
      });
      
      broadcastParticipantsList(io, sessionId);
    }

    // Remove from sockets
    state.sockets.delete(socket.id);
    
    // Remove from viewers set
    state.viewers.delete(socket.id);
    
    // Leave room
    socket.leave(sessionId);
    
    // Disconnect socket
    socket.disconnect(true);
    
    console.log(`✅ Inactive viewer ${socket.id} cleaned up successfully`);
    
  } catch (error) {
    console.error("Error in cleanupInactiveViewer:", error);
  }
};