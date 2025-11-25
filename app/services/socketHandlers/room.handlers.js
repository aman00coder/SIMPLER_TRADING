import jwt from "jsonwebtoken";
import liveSession from "../../model/liveSessions/liveeSession.model.js";
import liveSessionParticipant from "../../model/liveSessionParticipant/liveSessionParticipant.model.js";
import authenticationModel from "../../model/Authentication/authentication.model.js";
import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";
import { ROLE_MAP } from "../../constant/role.js";
import { roomState } from "../socketState/roomState.js";
import { getIceServersFromEnv, broadcastParticipantsList, safeEmit } from "../socketUtils/general.utils.js";

export const roomJoinHandler = (socket, io) => {
  socket.on("join_room", async (data) => {
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
      
      // Initialize room state if it doesn't exist
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

      // Handle streamer connection
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

      // Create or update participant record
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
      
      // Add to participants map
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

      // Create Mediasoup router for streamer
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

      // Broadcast participant list updates
      broadcastParticipantsList(io, sid);

      // Send current list to newly joined socket
      const currentParticipants = Array.from(state.participants.values());
      socket.emit("participants_list", currentParticipants);

      // Send join confirmation
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
          activeScreenShares: Array.from(state.activeScreenShares.values()),
          participants: Array.from(state.participants.values())
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
          activeProducers: Array.from(state.producers.keys()),
          participants: Array.from(state.participants.values())
        });
        console.log(`Viewer ${socket.id} joined room ${sid}`);
        
        if (state.streamerSocketId) {
          safeEmit(io, state.streamerSocketId, "viewer_ready", { 
            viewerSocketId: socket.id, 
            viewerUserId: userId 
          });
        }
      }

      // Handle whiteboard participation
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

      // Update peak participants count
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
  });
};