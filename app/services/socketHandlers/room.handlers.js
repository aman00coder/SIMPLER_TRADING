// // services/socketHandlers/room.handlers.js
// import jwt from "jsonwebtoken";
// import liveSession from "../../model/liveSessions/liveeSession.model.js";
// import liveSessionParticipant from "../../model/liveSessionParticipant/liveSessionParticipant.model.js";
// import authenticationModel from "../../model/Authentication/authentication.model.js";
// import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";
// import { ROLE_MAP } from "../../constant/role.js";
// import { roomState } from "../socketState/roomState.js";
// import { getIceServersFromEnv, broadcastParticipantsList, safeEmit } from "../socketUtils/general.utils.js";

// // ✅ mediasoupWorker parameter add karo
// export const roomJoinHandler = (socket, io, mediasoupWorker) => {
//   socket.on("join_room", async (data) => {
//     const { token, sessionId, roomCode } = data;
//     console.log(`Join room request from socket: ${socket.id}, sessionId: ${sessionId}, roomCode: ${roomCode}`);
    
//     try {
//       if (!token || (!sessionId && !roomCode)) {
//         return socket.emit("error_message", "Missing token or sessionId/roomCode");
//       }

//       let decoded;
//       try {
//         decoded = jwt.verify(token, process.env.SECRET_KEY);
//         console.log(`Token decoded for user: ${decoded.userId}, role: ${decoded.role}`);
//       } catch (err) {
//         return socket.emit("error_message", "Invalid token");
//       }
      
//       const userId = decoded.userId;
//       const userRole = decoded.role;

//       let session;
//       if (sessionId) {
//         session = await liveSession.findOne({ sessionId });
//       } else {
//         session = await liveSession.findOne({ roomCode });
//       }

//       if (!session) return socket.emit("error_message", "Session not found");
//       if (!["SCHEDULED", "ACTIVE", "PAUSED"].includes(session.status)) {
//         return socket.emit("error_message", `Session is ${session.status}`);
//       }

//       if (session.isPrivate) {
//         const allowed = Array.isArray(session.allowedUsers) && 
//           session.allowedUsers.some(u => u.toString() === userId);
//         if (!allowed) return socket.emit("error_message", "You are not allowed to join this private session");
//       }

//       const sid = session.sessionId;
      
//       // Initialize room state if it doesn't exist
//       if (!roomState.has(sid)) {
//         roomState.set(sid, {
//           whiteboardId: session.whiteboardId || null,
//           createdBy: session.streamerId ? session.streamerId.toString() : null,
//           streamerSocketId: null,
//           viewers: new Set(),
//           sockets: new Map(),
//           participants: new Map(),
//           pendingScreenShareRequests: new Map(),
//           activeScreenShares: new Map(),
//           pendingOps: [],
//           flushTimer: null,
//           router: null,
//           transports: new Map(),
//           producers: new Map(),
//           consumers: new Map(),
//         });
//         console.log(`New room state created for session: ${sid}`);
//       }
      
//       const state = roomState.get(sid);

//       const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
//       const activeCount = await liveSessionParticipant.countDocuments({ 
//         sessionId: session._id, 
//         status: { $ne: "LEFT" } 
//       });
      
//       if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
//         return socket.emit("error_message", "Max participants limit reached");
//       }

//       let participant = await liveSessionParticipant.findOne({ sessionId: session._id, userId });
//       if (participant && participant.isBanned) {
//         return socket.emit("error_message", "You are banned from this session");
//       }

//       // Handle streamer connection
//       if (userRole === ROLE_MAP.STREAMER) {
//         if (state.streamerSocketId && state.streamerSocketId !== socket.id) {
//           console.log(`Streamer reconnecting from ${state.streamerSocketId} to ${socket.id}`);
//           if (state.sockets.has(state.streamerSocketId)) {
//             state.sockets.delete(state.streamerSocketId);
//             state.viewers.delete(state.streamerSocketId);
//           }
//         }
//         state.streamerSocketId = socket.id;
//         console.log(`Streamer socket ID updated to: ${socket.id}`);
//       }

//       // Create or update participant record
//       if (!participant) {
//         participant = await liveSessionParticipant.create({
//           sessionId: session._id,
//           userId,
//           socketId: socket.id,
//           status: "JOINED",
//           isActiveDevice: true,
//           joinedAt: new Date(),
//         });
//         session.totalJoins = (session.totalJoins || 0) + 1;
//         await session.save();
//         console.log(`New participant created, total joins: ${session.totalJoins}`);
//       } else {
//         participant.socketId = socket.id;
//         participant.status = "JOINED";
//         participant.isActiveDevice = true;
//         participant.joinedAt = new Date();
//         participant.leftAt = null;
//         await participant.save();
//       }

//       const user = await authenticationModel.findById(userId).select("name");
      
//       // Add to participants map
//       state.participants.set(userId, {
//         userId,
//         socketId: socket.id,
//         name: user?.name || "Unknown",
//         role: userRole,
//         joinedAt: new Date(),
//         isSpeaking: false,
//         hasAudio: false,
//         hasVideo: false,
//         isScreenSharing: false,
//       });

//       // Create Mediasoup router for streamer
//       if (userRole === ROLE_MAP.STREAMER && !state.router) {
//         console.log("Creating Mediasoup router for session:", sid);
//         const mediaCodecs = [
//           {
//             kind: "audio",
//             mimeType: "audio/opus",
//             clockRate: 48000,
//             channels: 2,
//           },
//           {
//             kind: "video",
//             mimeType: "video/VP8",
//             clockRate: 90000,
//             parameters: {
//               "x-google-start-bitrate": process.env.NODE_ENV === "production" ? 500000 : 1000000,
//             },
//           },
//         ];

//         // ✅ Yahan mediasoupWorker use karo (jo parameter mein aaya hai)
//         state.router = await mediasoupWorker.createRouter({ mediaCodecs });
//         console.log("Mediasoup router created for session:", sid);
//       }

//       state.sockets.set(socket.id, { userId, role: userRole, userName: user?.name || "Unknown" });
//       socket.data = { sessionId: sid, userId, role: userRole };
//       socket.join(sid);
//       console.log(`Socket ${socket.id} joined room ${sid}`);

//       const iceServers = getIceServersFromEnv();
//       socket.emit("ice_servers", iceServers);

//       // Broadcast participant list updates
//       broadcastParticipantsList(io, sid);

//       // Send current list to newly joined socket
//       const currentParticipants = Array.from(state.participants.values());
//       socket.emit("participants_list", currentParticipants);

//       // Send join confirmation
//       if (userRole === ROLE_MAP.STREAMER) {
//         socket.emit("joined_room", {
//           as: "STREAMER",
//           sessionId: sid,
//           roomCode: session.roomCode,
//           hasMediasoup: !!state.router,
//           environment: process.env.NODE_ENV,
//           iceServers: iceServers,
//           activeProducers: Array.from(state.producers.keys()),
//           pendingScreenShareRequests: Array.from(state.pendingScreenShareRequests.values()),
//           activeScreenShares: Array.from(state.activeScreenShares.values()),
//           participants: Array.from(state.participants.values())
//         });
//         console.log(`Streamer ${socket.id} joined room ${sid}`);
//       } else {
//         state.viewers.add(socket.id);
//         socket.emit("joined_room", {
//           as: "VIEWER",
//           sessionId: sid,
//           roomCode: session.roomCode,
//           whiteboardId: state.whiteboardId,
//           hasMediasoup: !!state.router,
//           environment: process.env.NODE_ENV,
//           iceServers: iceServers,
//           activeProducers: Array.from(state.producers.keys()),
//           participants: Array.from(state.participants.values())
//         });
//         console.log(`Viewer ${socket.id} joined room ${sid}`);
        
//         if (state.streamerSocketId) {
//           safeEmit(io, state.streamerSocketId, "viewer_ready", { 
//             viewerSocketId: socket.id, 
//             viewerUserId: userId 
//           });
//         }
//       }

//       // Handle whiteboard participation
//       if (state.whiteboardId) {
//         const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//         if (wb && !wb.participants.find(p => p.user.toString() === userId)) {
//           wb.participants.push({ 
//             user: userId, 
//             role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer", 
//             joinedAt: new Date() 
//           });
//           await wb.save();
//           console.log(`User added to whiteboard: ${state.whiteboardId}`);
//         }
//       }

//       // Update peak participants count
//       const currentParticipantsCount = state.viewers.size + (state.streamerSocketId ? 1 : 0);
//       if ((session.peakParticipants || 0) < currentParticipantsCount) {
//         session.peakParticipants = currentParticipantsCount;
//         await session.save();
//         console.log(`New peak participants: ${currentParticipantsCount}`);
//       }
//     } catch (err) {
//       console.error("join_room error:", err);
//       socket.emit("error_message", "Invalid token/session");
//       throw err;
//     }
//   });
// };







// services/socketHandlers/room.handlers.js
import jwt from "jsonwebtoken";
import liveSession from "../../model/liveSessions/liveeSession.model.js";
import liveSessionParticipant from "../../model/liveSessionParticipant/liveSessionParticipant.model.js";
import authenticationModel from "../../model/Authentication/authentication.model.js";
import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";
import { ROLE_MAP } from "../../constant/role.js";
import { roomState } from "../socketState/roomState.js";
import { getIceServersFromEnv, broadcastParticipantsList, safeEmit } from "../socketUtils/general.utils.js";

// ✅ Helper function: Purane connections ko cleanup kare
const cleanupPreviousConnections = (userId, sessionId, currentSocketId, io) => {
  const state = roomState.get(sessionId);
  if (!state) return null;

  let oldSocketId = null;
  
  // 1. Participant map mein purani socket ID dhoondho
  if (state.participants.has(userId)) {
    const participant = state.participants.get(userId);
    if (participant.socketId !== currentSocketId) {
      oldSocketId = participant.socketId;
    }
  }
  
  // 2. Ya fir sockets map mein search karo
  if (!oldSocketId) {
    for (const [socketId, data] of state.sockets.entries()) {
      if (data.userId === userId && socketId !== currentSocketId) {
        oldSocketId = socketId;
        break;
      }
    }
  }

  if (!oldSocketId) return null;

  console.log(`Cleaning up old connection for user ${userId}: ${oldSocketId} -> ${currentSocketId}`);

  // 3. State se purane socket data remove karo
  // Sockets map se
  if (state.sockets.has(oldSocketId)) {
    state.sockets.delete(oldSocketId);
  }

  // Viewers set se
  if (state.viewers.has(oldSocketId)) {
    state.viewers.delete(oldSocketId);
  }

  // Streamer socket ID update
  if (state.streamerSocketId === oldSocketId) {
    state.streamerSocketId = currentSocketId;
  }

  // 4. Participant map se purana entry remove karo
  if (state.participants.has(userId)) {
    state.participants.delete(userId);
  }

  // 5. Mediasoup resources cleanup (agar exist karta hai)
  // Transports
  if (state.transports && state.transports.has(oldSocketId)) {
    const transport = state.transports.get(oldSocketId);
    // Transport close karna safe nahi ho sakta yahan, 
    // isliye bas map se remove karo
    state.transports.delete(oldSocketId);
  }

  // Producers
  if (state.producers) {
    for (const [producerId, producerData] of state.producers.entries()) {
      if (producerData.socketId === oldSocketId) {
        state.producers.delete(producerId);
      }
    }
  }

  // Consumers
  if (state.consumers) {
    for (const [consumerId, consumerData] of state.consumers.entries()) {
      if (consumerData.socketId === oldSocketId) {
        state.consumers.delete(consumerId);
      }
    }
  }

  // 6. Pending screen share requests cleanup
  if (state.pendingScreenShareRequests) {
    for (const [requestId, requestData] of state.pendingScreenShareRequests.entries()) {
      if (requestData.viewerSocketId === oldSocketId || requestData.viewerUserId === userId) {
        state.pendingScreenShareRequests.delete(requestId);
      }
    }
  }

  // 7. Active screen shares cleanup
  if (state.activeScreenShares) {
    for (const [screenShareId, screenShareData] of state.activeScreenShares.entries()) {
      if (screenShareData.socketId === oldSocketId || screenShareData.userId === userId) {
        state.activeScreenShares.delete(screenShareId);
      }
    }
  }

  // 8. Agar old socket abhi connected hai to disconnect karo
  if (io && io.sockets && io.sockets.sockets.get(oldSocketId)) {
    try {
      io.to(oldSocketId).emit("force_disconnect", {
        reason: "new_device_login",
        message: "Logged in from another device"
      });
      
      // Thoda delay dekar disconnect karo taaki event deliver ho jaye
      setTimeout(() => {
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) {
          oldSocket.disconnect(true);
          console.log(`Force disconnected old socket: ${oldSocketId}`);
        }
      }, 100);
    } catch (err) {
      console.error(`Error force disconnecting socket ${oldSocketId}:`, err);
    }
  }

  return oldSocketId;
};

export const roomJoinHandler = (socket, io, mediasoupWorker) => {
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

      // ✅ **PURANE CONNECTIONS KO CLEANUP KARO**
      const oldSocketId = cleanupPreviousConnections(userId, sid, socket.id, io);
      
      // ✅ **Database mein old participant record update karo**
      if (oldSocketId) {
        try {
          await liveSessionParticipant.updateOne(
            { 
              sessionId: session._id, 
              userId,
              socketId: oldSocketId,
              status: { $ne: "LEFT" }
            },
            {
              $set: {
                status: "LEFT",
                isActiveDevice: false,
                leftAt: new Date(),
                reason: "DEVICE_CHANGED"
              }
            }
          );
          console.log(`Updated old participant record for socket: ${oldSocketId}`);
        } catch (err) {
          console.error("Error updating old participant record:", err);
        }
      }

      // ✅ **MAX PARTICIPANTS CHECK - cleanup ke baad**
      const activeCount = await liveSessionParticipant.countDocuments({ 
        sessionId: session._id, 
        status: "JOINED"
      });
      
      const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 100;
      
      if (maxParticipants <= activeCount && userRole !== ROLE_MAP.STREAMER) {
        return socket.emit("error_message", "Max participants limit reached");
      }

      // ✅ **Participant record create/update**
      let participant = await liveSessionParticipant.findOne({ 
        sessionId: session._id, 
        userId,
        status: { $ne: "LEFT" }
      });

      if (participant) {
        // Existing participant update karo
        participant.socketId = socket.id;
        participant.status = "JOINED";
        participant.isActiveDevice = true;
        participant.joinedAt = new Date();
        participant.leftAt = null;
        participant.reason = null;
        await participant.save();
        console.log(`Updated participant for user ${userId} with new socket: ${socket.id}`);
      } else {
        // Naya participant create karo
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
      }

      // ✅ **State mein participant update**
      const user = await authenticationModel.findById(userId).select("name");
      
      // Pehle existing entry remove karo (agar hai) - cleanup function ne already kar diya hai
      // Lekin fir bhi double-check karo
      if (state.participants.has(userId)) {
        state.participants.delete(userId);
      }
      
      // Naya entry add karo
      state.participants.set(userId, {
        userId,
        socketId: socket.id,  // ✅ Naya socket ID
        name: user?.name || "Unknown",
        role: userRole,
        joinedAt: new Date(),
        isSpeaking: false,
        hasAudio: false,
        hasVideo: false,
        isScreenSharing: false,
      });

      // ✅ **Sockets map mein add karo**
      // Pehle existing entry remove karo
      for (const [sockId, data] of state.sockets.entries()) {
        if (data.userId === userId) {
          state.sockets.delete(sockId);
          break;
        }
      }
      
      // Naya entry add karo
      state.sockets.set(socket.id, { 
        userId, 
        role: userRole, 
        userName: user?.name || "Unknown" 
      });

      // ✅ **Viewers set update**
      if (userRole !== ROLE_MAP.STREAMER) {
        // Purana socket remove karo
        for (const sockId of state.viewers) {
          const viewerData = state.sockets.get(sockId);
          if (viewerData && viewerData.userId === userId) {
            state.viewers.delete(sockId);
            break;
          }
        }
        // Naya socket add karo
        state.viewers.add(socket.id);
      }

      // ✅ **Streamer socket ID update**
      if (userRole === ROLE_MAP.STREAMER) {
        state.streamerSocketId = socket.id;
        console.log(`Streamer socket ID updated to: ${socket.id}`);
      }

      // ✅ **Create Mediasoup router for streamer**
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

      // ✅ **Socket data set karo aur room join karo**
      socket.data = { sessionId: sid, userId, role: userRole };
      socket.join(sid);
      console.log(`Socket ${socket.id} joined room ${sid}`);

      // ✅ **Ice servers bhejo**
      const iceServers = getIceServersFromEnv();
      socket.emit("ice_servers", iceServers);

      // ✅ **Broadcast updated participant list**
      broadcastParticipantsList(io, sid);

      // ✅ **Current list newly joined socket ko bhejo**
      const currentParticipants = Array.from(state.participants.values());
      socket.emit("participants_list", currentParticipants);

      // ✅ **Join confirmation bhejo**
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
        
        // ✅ **Streamer ko notify karo ki naya viewer ready hai**
        if (state.streamerSocketId) {
          safeEmit(io, state.streamerSocketId, "viewer_ready", { 
            viewerSocketId: socket.id, 
            viewerUserId: userId 
          });
        }
      }

      // ✅ **Whiteboard participation handle karo**
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

      // ✅ **Peak participants count update karo**
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