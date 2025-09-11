import jwt from "jsonwebtoken";
import liveSession from "../../model/liveSessions/liveeSession.model.js";
import liveSessionParticipant from "../../model/liveSessionParticipant/liveSessionParticipant.model.js";
import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";
import { ROLE_MAP } from "../../constant/role.js";
import authenticationModel from "../../model/Authentication/authentication.model.js";
import { getIceServersFromEnv, safeEmit } from "../socketUtils/index.js";

export const joinRoomHandler = async (socket, data, io, roomState, mediasoupWorker) => {
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
    roomState.ensureRoom(sid, {
      whiteboardId: session.whiteboardId || null,
      createdBy: session.streamerId ? session.streamerId.toString() : null,
    });
    
    const state = roomState.getRoom(sid);

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

    state.sockets.set(socket.id, { userId, role: userRole });
    socket.data = { sessionId: sid, userId, role: userRole };
    socket.join(sid);
    console.log(`Socket ${socket.id} joined room ${sid}`);

    const iceServers = getIceServersFromEnv();
    socket.emit("ice_servers", iceServers);

    if (userRole === ROLE_MAP.STREAMER) {
      socket.emit("joined_room", {
        as: "STREAMER",
        sessionId: sid,
        roomCode: session.roomCode,
        hasMediasoup: !!state.router,
        environment: process.env.NODE_ENV,
        iceServers: iceServers,
        activeProducers: Array.from(state.producers.keys())
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
        safeEmit(io, state.streamerSocketId, "viewer_ready", { 
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

    const currentParticipants = state.viewers.size + (state.streamerSocketId ? 1 : 0);
    if ((session.peakParticipants || 0) < currentParticipants) {
      session.peakParticipants = currentParticipants;
      await session.save();
      console.log(`New peak participants: ${currentParticipants}`);
    }
  } catch (err) {
    console.error("join_room error:", err);
    socket.emit("error_message", "Invalid token/session");
    throw err;
  }
};

export const cleanupSocketFromRoom = async (socket, io, roomState) => {
  console.log(`Cleanup requested for socket: ${socket.id}`);
  try {
    const sid = socket.data?.sessionId;
    if (!sid) {
      console.log(`No session ID found for socket: ${socket.id}`);
      return;
    }
    
    const state = roomState.getRoom(sid);
    if (!state) {
      console.log(`No state found for session: ${sid}`);
      return;
    }

    const meta = state.sockets.get(socket.id);
    if (!meta) {
      console.log(`No metadata found for socket: ${socket.id}`);
      return;
    }

    // Cleanup Mediasoup resources
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

    // Handle producers based on role
    for (const [producerId, producer] of state.producers) {
      try {
        if (producer?.appData?.socketId === socket.id) {
          if (meta.role === ROLE_MAP.STREAMER) {
            await producer.pause();
            console.log(`Producer ${producerId} paused during cleanup (streamer)`);
          } else {
            producer.close();
            state.producers.delete(producerId);
            console.log(`Producer ${producerId} closed and removed (viewer)`);
          }
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
        const participant = wb.participants.find(p => p.user.toString() === meta.userId);
        if (participant) {
          participant.status = "LEFT";
          participant.leftAt = new Date();
        }
        await wb.save();
        console.log(`User ${meta.userId} left whiteboard ${state.whiteboardId}`);
      }
    }

    // Update participant record
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

    // Clean up empty room state
    if (state.sockets.size === 0) {
      if (state.pendingOps && state.pendingOps.length > 0) {
        await flushCanvasOps(sid, roomState).catch(err => {
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
      
      roomState.deleteRoom(sid);
      console.log(`Room state cleaned up for session: ${sid}`);
    }
  } catch (e) {
    console.error("cleanupSocketFromRoom error:", e?.message || e);
  }
};