// services/socketUtils/general.utils.js
import { roomState } from "../socketState/roomState.js";
import liveSession from "../../model/liveSessions/liveeSession.model.js";
import liveSessionParticipant from "../../model/liveSessionParticipant/liveSessionParticipant.model.js";
import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";
import { ROLE_MAP } from "../../constant/role.js";
import { flushCanvasOps } from "./whiteboard.utils.js";

// -----------------------------------------
// ✅ GLOBAL IO HANDLER
// -----------------------------------------
let globalIO = null;

export const setGlobalIO = (io) => {
  globalIO = io;
  console.log("✅ Global IO set successfully");
};

// -----------------------------------------
// ✅ SAFE EMIT USING GLOBAL IO
// -----------------------------------------
export const safeEmit = (toSocketId, event, payload) => {
  try {
    if (!globalIO) return console.error("Global IO missing in safeEmit");

    const s = globalIO.sockets.sockets.get(toSocketId);
    if (s) {
      s.emit(event, payload);
      console.log(`Emitted ${event} → ${toSocketId}`);
    } else {
      console.log(`Socket not found: ${toSocketId}`);
    }
  } catch (err) {
    console.error("safeEmit error:", err);
  }
};

// -----------------------------------------
// ICE SERVERS
// -----------------------------------------
export const getIceServersFromEnv = () => {
  const isProduction = process.env.NODE_ENV === "production";

  const servers = [];
  const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  stunUrls.forEach((url) => servers.push({ urls: url }));

  if (isProduction) {
    const turnUrls = (process.env.TURN_URLS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const turnUsername = process.env.TURN_USERNAME;
    const turnPassword = process.env.TURN_PASSWORD;

    turnUrls.forEach((url) => {
      if (url && turnUsername && turnPassword) {
        servers.push({
          urls: url,
          username: turnUsername,
          credential: turnPassword,
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

// -----------------------------------------
// ✅ BROADCAST PARTICIPANTS LIST USING GLOBAL IO
// -----------------------------------------
export const broadcastParticipantsList = (sessionId) => {
  if (!globalIO) return console.error("Global IO not set");

  const state = roomState.get(sessionId);
  if (!state) return;

  const currentParticipants = Array.from(state.participants.values());

  globalIO.to(sessionId).emit("participants_list_updated", {
    participants: currentParticipants,
  });
};

// -----------------------------------------
// ✅ CLEANUP SOCKET FROM ROOM (GLOBAL IO)
// -----------------------------------------
export const cleanupSocketFromRoom = async (socket) => {
  console.log(`Cleanup requested for socket: ${socket.id}`);

  try {
    if (!globalIO) return console.error("Global IO missing in cleanup");

    const sid = socket.data?.sessionId;
    if (!sid) return console.log(`No sessionId for ${socket.id}`);

    const state = roomState.get(sid);
    if (!state) return console.log(`No room state for ${sid}`);

    const meta = state.sockets.get(socket.id);
    if (!meta) return console.log(`No metadata for socket ${socket.id}`);

    // -----------------------------------------
    // SCREEN SHARE CLEANUP
    // -----------------------------------------
    if (state.pendingScreenShareRequests.has(meta.userId)) {
      state.pendingScreenShareRequests.delete(meta.userId);
    }

    if (state.activeScreenShares.has(meta.userId)) {
      await handleViewerScreenShareStop(socket, sid, meta.userId);
    }

    // -----------------------------------------
    // CONSUMERS CLEANUP
    // -----------------------------------------
    for (const [consumerId, consumer] of state.consumers) {
      try {
        if (consumer?.appData?.socketId === socket.id) {
          consumer.close();
          state.consumers.delete(consumerId);
          console.log(`Consumer ${consumerId} removed`);
        }
      } catch (e) {
        console.warn("Consumer cleanup error:", e);
      }
    }

    // -----------------------------------------
    // TRANSPORTS CLEANUP
    // -----------------------------------------
    for (const [transportId, transport] of state.transports) {
      try {
        if (transport?.appData?.socketId === socket.id) {
          transport.close();
          state.transports.delete(transportId);
          console.log(`Transport ${transportId} removed`);
        }
      } catch (e) {
        console.warn("Transport cleanup error:", e);
      }
    }

    // -----------------------------------------
    // PRODUCERS CLEANUP
    // -----------------------------------------
    for (const [producerId, producer] of state.producers) {
      try {
        if (producer?.appData?.socketId === socket.id) {
          producer.close();
          state.producers.delete(producerId);
          console.log(`Producer ${producerId} removed`);
        }
      } catch (e) {
        console.warn("Producer cleanup error:", e);
      }
    }

    // -----------------------------------------
    // PARTICIPANTS UPDATE
    // -----------------------------------------
    if (meta.userId) {
      state.participants.delete(meta.userId);

      globalIO.to(sid).emit("participant_left", {
        participants: Array.from(state.participants.values()),
      });

      broadcastParticipantsList(sid);
    }

    // -----------------------------------------
    // WHITEBOARD CLEANUP
    // -----------------------------------------
    if (state.whiteboardId) {
      const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });

      if (wb) {
        const participant = wb.participants.find(
          (p) => p.user.toString() === meta.userId
        );

        if (participant) {
          participant.status = "LEFT";
          participant.leftAt = new Date();
          wb.save();
        }
      }
    }

    // -----------------------------------------
    // VIEWER OR STREAMER LOGIC
    // -----------------------------------------
    if (meta.role !== ROLE_MAP.STREAMER) {
      // Update DB
      const participant = await liveSessionParticipant.findOne({
        $or: [
          { sessionId: sid, userId: meta.userId },
          { socketId: socket.id },
        ],
      });

      if (participant) {
        participant.status = "LEFT";
        participant.leftAt = new Date();
        participant.isActiveDevice = false;
        await participant.save();
      }

      state.viewers.delete(socket.id);

      globalIO.to(sid).emit("user_left", {
        userId: meta.userId,
        socketId: socket.id,
      });

    } else {
      // STREAMER LEFT
      state.streamerSocketId = null;

      const session = await liveSession.findOne({ sessionId: sid });
      if (session) {
        session.status = "PAUSED";
        await session.save();
      }

      globalIO.to(sid).emit("session_paused_or_ended_by_streamer");
    }

    // -----------------------------------------
    // REMOVE SOCKET FROM STATE
    // -----------------------------------------
    state.sockets.delete(socket.id);
    socket.leave(sid);

    // -----------------------------------------
    // ROOM CLEANUP IF EMPTY
    // -----------------------------------------
    if (state.sockets.size === 0) {
      if (state.pendingOps?.length > 0) {
        await flushCanvasOps(sid).catch((err) =>
          console.error("Flush ops error:", err)
        );
      }

      if (state.flushTimer) clearTimeout(state.flushTimer);

      if (state.router) {
        try {
          state.router.close();
        } catch (e) {
          console.warn("Router close error:", e);
        }
      }

      roomState.delete(sid);
    }
  } catch (e) {
    console.error("cleanupSocketFromRoom error:", e);
  }
};

// -----------------------------------------
// SCREEN SHARE STOP HELPER
// -----------------------------------------
const handleViewerScreenShareStop = async (socket, sessionId, userId = null) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  const targetUserId = userId || socket.data?.userId;
  if (!targetUserId) return;

  state.activeScreenShares.delete(targetUserId);

  for (const [producerId, producer] of state.producers) {
    if (
      producer.appData?.userId === targetUserId &&
      (producer.appData?.source === "viewer-screen" ||
        producer.appData?.source === "viewer-screen-audio")
    ) {
      try {
        producer.close();
      } catch (e) {
        console.warn("Screen share producer close error:", e);
      }
      state.producers.delete(producerId);
    }
  }
};
