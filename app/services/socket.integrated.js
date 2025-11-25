// commonly/socket.integrated.js
import { Server } from "socket.io";
import { setupSocketHandlers } from "../services/socketHandlers/index.js";
import { createMediasoupWorker } from "../services/socketUtils/mediasoup.utils.js";

let io;
let mediasoupWorker;

export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized. Call setupIntegratedSocket first.");
  return io;
};

export const setupIntegratedSocket = async (server, externalWorker = null) => { 
  console.log("Setting up integrated socket");

  try {
    // ✅ Use external worker if provided, otherwise create new
    mediasoupWorker = externalWorker || await createMediasoupWorker();
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

  // ✅ Pass mediasoupWorker to setupSocketHandlers
  setupSocketHandlers(io, mediasoupWorker);

  console.log("✅ Socket.io setup complete with screen share permission system");
  return io;
};

export { io, mediasoupWorker }; // ✅ mediasoupWorker bhi export karo


















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

// const broadcastParticipantsList = (sessionId) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const currentParticipants = Array.from(state.participants.values());
//   io.to(sessionId).emit("participants_list_updated", {
//     participants: currentParticipants
//   });
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
//       socket.emit("producer-closed", { 
//   producerId,
//   userId: producer.appData?.userId,
//   source: producer.appData?.source
// });

//     }
//   } catch (error) {
//     console.error("producer-close error:", error);
//   }
// };

// const handleViewerCameraPause = async (socket, sessionId) => {
//   try {
//     console.log("📷 handleViewerCameraPause called:", { sessionId, socketId: socket.id });
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     for (const [producerId, producer] of state.producers) {
//       if (
//         producer.appData?.socketId === socket.id &&
//         producer.appData?.source === "viewer-camera"
//       ) {
//         try {
//           await producer.pause();
//           console.log(`📷 Viewer camera paused: ${producerId}`);
//         } catch (err) {
//           console.warn("Error pausing viewer camera producer:", err);
//         }

//         const participant = state.participants.get(socket.data.userId);
//         if (participant) {
//           participant.hasVideo = false;

//           // 🔴 Partial update for compatibility
//           io.to(sessionId).emit("participant_updated", {
//             userId: socket.data.userId,
//             updates: { hasVideo: false },
//           });

//           // 🟢 Full snapshot
//           broadcastParticipantsList(sessionId);
//         }

//         // 🔔 Notify everyone (compatibility event)
//         io.to(sessionId).emit("viewer-camera-paused", {
//           userId: socket.data.userId,
//           socketId: socket.id,
//         });

//         // 🔔 Extra global event for clarity
//         io.to(sessionId).emit("viewer-camera-paused-global", {
//           userId: socket.data.userId,
//           userName: state.sockets.get(socket.id)?.userName || "Viewer",
//         });

//         console.log(`✅ Viewer camera paused for user: ${socket.data.userId}`);
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("handleViewerCameraPause error:", error);
//   }
// };


// const handleViewerCameraResume = async (socket, sessionId) => {
//   try {
//     console.log("📷 handleViewerCameraResume called:", { sessionId, socketId: socket.id });
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     for (const [producerId, producer] of state.producers) {
//       if (
//         producer.appData?.socketId === socket.id &&
//         producer.appData?.source === "viewer-camera"
//       ) {
//         try {
//           await producer.resume();
//           console.log(`📷 Viewer camera resumed: ${producerId}`);
//         } catch (err) {
//           console.warn("Error resuming viewer camera producer:", err);
//         }

//         const participant = state.participants.get(socket.data.userId);
//         if (participant) {
//           participant.hasVideo = true;

//           // 🔴 Partial update for compatibility
//           io.to(sessionId).emit("participant_updated", {
//             userId: socket.data.userId,
//             updates: { hasVideo: true },
//           });

//           // 🟢 Full snapshot
//           broadcastParticipantsList(sessionId);
//         }

//         // 🔔 Notify everyone (compatibility event)
//         io.to(sessionId).emit("viewer-camera-resumed", {
//           userId: socket.data.userId,
//           socketId: socket.id,
//         });

//         // 🔔 Extra global event for clarity
//         io.to(sessionId).emit("viewer-camera-resumed-global", {
//           userId: socket.data.userId,
//           userName: state.sockets.get(socket.id)?.userName || "Viewer",
//         });

//         console.log(`✅ Viewer camera resumed for user: ${socket.data.userId}`);
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("handleViewerCameraResume error:", error);
//   }
// };



// const handleViewerCameraStop = async (socket, sessionId, userId = null) => {
//   try {
//     console.log("📷 handleViewerCameraStop called:", { sessionId, userId });
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const targetUserId = userId || socket.data.userId;

//     // 🛑 Close and remove all camera producers for this user
//     for (const [producerId, producer] of state.producers) {
//       if (
//         producer.appData?.userId === targetUserId &&
//         producer.appData?.source === "viewer-camera"
//       ) {
//         try {
//           producer.close();
//         } catch (err) {
//           console.warn("Error closing viewer camera producer:", err);
//         }
//         state.producers.delete(producerId);
//         console.log(`📷 Viewer camera producer ${producerId} closed`);
//       }
//     }

//     // 🟢 Update participant status
//     const participant = state.participants.get(targetUserId);
//     if (participant) {
//       participant.hasVideo = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: targetUserId,
//         updates: { hasVideo: false },
//       });
//       broadcastParticipantsList(sessionId);
//     }

//     // 🔔 Notify everyone in the room
//     io.to(sessionId).emit("viewer-camera-stopped", {
//       userId: targetUserId,
//     });

//     // 🔔 Extra event for consistency with producer cleanup
//     io.to(sessionId).emit("producer-closed", {
//       userId: targetUserId,
//       source: "viewer-camera",
//     });

//     console.log(`✅ Viewer camera fully stopped for user: ${targetUserId}`);
//   } catch (error) {
//     console.error("handleViewerCameraStop error:", error);
//   }
// };


// const handleStreamerStopViewerVideo = async (socket, sessionId, targetSocketId) => {
//   try {
//     console.log("🎥 Streamer forcing stop of viewer video:", targetSocketId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     for (const [producerId, producer] of state.producers) {
//       if (
//         producer.appData?.socketId === targetSocketId &&
//         producer.kind === "video" &&
//         producer.appData?.source === "viewer-camera"
//       ) {
//         try {
//           producer.close();
//         } catch (e) {
//           console.error("Error closing viewer video producer:", e);
//         }

//         // ❌ Remove producer from state
//         state.producers.delete(producerId);

//         const viewerMeta = state.sockets.get(targetSocketId);
//         if (!viewerMeta) return;

//         const participant = state.participants.get(viewerMeta.userId);
//         if (participant) {
//           // 🔹 Update participant object
//           participant.hasVideo = false;
//           state.participants.set(viewerMeta.userId, participant);

//           // 🔹 Broadcast a delta update
//           io.to(sessionId).emit("participant_updated", {
//             userId: viewerMeta.userId,
//             updates: { hasVideo: false },
//           });

//           // 🔹 Always send full updated snapshot
//           broadcastParticipantsList(sessionId);
//         }

//         // 🔹 Reset meta reference
//         viewerMeta.videoProducerId = null;

//         // 🔹 Tell the target viewer to cleanup & reset UI
//         safeEmit(targetSocketId, "viewer-video-force-stopped", {
//           userId: viewerMeta.userId,
//           message: "Streamer stopped your video, please request again",
//         });

//         // 🔹 Notify everyone (global event)
//         io.to(sessionId).emit("viewer-video-force-stopped-global", {
//           userId: viewerMeta.userId,
//           userName: viewerMeta.userName || "Viewer",
//         });

//         // 🔹 Emit the same event used when viewer stops voluntarily
//         io.to(sessionId).emit("viewer-camera-stopped", {
//           userId: viewerMeta.userId,
//         });

//         console.log(`✅ Viewer video stopped: ${viewerMeta.userId}`);
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Streamer stop viewer video error:", error);
//   }
// };
// // ✅ ADD THIS NEW HANDLER FUNCTION (global functions section में)
// const handleScreenShareStoppedByViewer = async (socket, data) => {
//   try {
//     const { sessionId, userId } = data;
//     console.log("🛑 Viewer stopped screen share:", userId);
    
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // Clean up from active screen shares
//     state.activeScreenShares.delete(userId);
    
//     // Clean up screen share producers
//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.userId === userId && 
//           (producer.appData?.source === 'viewer-screen' || 
//            producer.appData?.source === 'viewer-screen-audio')) {
//         try {
//           producer.close();
//         } catch (e) {
//           console.warn("Error closing screen share producer:", e);
//         }
//         state.producers.delete(producerId);
//         console.log(`✅ Screen share producer ${producerId} closed`);
//       }
//     }

//     // Update participant status
//     const participant = state.participants.get(userId);
//     if (participant) {
//       participant.isScreenSharing = false;
      
//       // Notify all participants about status change
//       io.to(sessionId).emit("participant_updated", {
//         userId: userId,
//         updates: { isScreenSharing: false }
//       });
      
//       // Broadcast updated participants list
//       broadcastParticipantsList(sessionId);
//     }

//     // ✅ IMPORTANT: Notify everyone including streamer
//     io.to(sessionId).emit("screen-share-stopped-by-viewer", {
//       userId: userId,
//       stoppedByViewer: true
//     });

//     console.log(`✅ Viewer screen share cleaned up for user: ${userId}`);
//   } catch (error) {
//     console.error("handleScreenShareStoppedByViewer error:", error);
//   }
// };

// const handleStreamerStopViewerAudio = async (socket, sessionId, targetSocketId) => {
//   try {
//     console.log("Streamer forcing stop of viewer audio:", targetSocketId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     for (const [producerId, producer] of state.producers) {
//       if (
//         producer.appData?.socketId === targetSocketId &&
//         producer.kind === "audio" &&
//         producer.appData?.source === "viewer-mic"
//       ) {
//         try {
//           producer.close();
//         } catch (e) {
//           console.error("Error closing viewer audio producer:", e);
//         }

//         // ❌ Remove producer from state
//         state.producers.delete(producerId);

//         const viewerMeta = state.sockets.get(targetSocketId);
//         if (!viewerMeta) return;

//         const participant = state.participants.get(viewerMeta.userId);
//         if (participant) {
//           // 🔹 Update hasAudio flag
//           participant.hasAudio = false;

//           // 🔹 Update participant object in state
//           state.participants.set(viewerMeta.userId, participant);

//           // 🔹 Broadcast a delta update (optional)
//           io.to(sessionId).emit("participant_updated", {
//             userId: viewerMeta.userId,
//             updates: { hasAudio: false },
//           });

//           // 🔹 Always send full updated snapshot
//           broadcastParticipantsList(sessionId);
//         }

//         // 🔹 Reset producer reference
//         viewerMeta.audioProducerId = null;

//         // 🔹 Tell the target viewer: cleanup & reset UI
//         io.to(targetSocketId).emit("viewer-audio-force-stopped", {
//           userId: viewerMeta.userId,
//           message: "Streamer stopped your audio, please request again",
//         });

//         console.log(`✅ Viewer audio stopped: ${viewerMeta.userId}`);
//         break;
//       }
//     }
//   } catch (error) {
//     console.error("Streamer stop viewer audio error:", error);
//   }
// };

// // ✅ YE NAYA HANDLER ADD KARO
// const handleStreamerScreenShareAudio = async (socket, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("🎵 Streamer screen share audio for transport:", transportId);
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
//         source: 'screen-audio',  // Streamer screen audio
//         userId: socket.data.userId
//       },
//     });

//     state.producers.set(producer.id, producer);
    
//     // Notify all participants
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: 'screen-audio'
//     });

//     callback({ id: producer.id });

//     producer.on("transportclose", () => {
//       console.log("Streamer screen audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Streamer screen share audio error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleStreamerScreenShareStop = async (socket, sessionId) => {
//   try {
//     console.log("🎥 Streamer stopping own screen share:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     // 🔴 Find and close all screen producers from this streamer
//     for (const [producerId, producer] of state.producers) {
//       if (
//         producer.appData?.socketId === socket.id &&
//         producer.appData?.source === "screen"
//       ) {
//         try {
//           producer.close();
//         } catch (e) {
//           console.warn("Error closing streamer screen producer:", e);
//         }
//         state.producers.delete(producerId);
//         console.log(`✅ Streamer screen producer ${producerId} closed`);
//       }
//     }

//     // 🔹 Update participant flag
//     const participant = state.participants.get(socket.data.userId);
//     if (participant) {
//       participant.isScreenSharing = false;
//       io.to(sessionId).emit("participant_updated", {
//         userId: socket.data.userId,
//         updates: { isScreenSharing: false },
//       });
//       broadcastParticipantsList(sessionId);
//     }

//     // 🔹 Notify all viewers
//     io.to(sessionId).emit("screen-share-stop", {
//       userId: socket.data.userId,
//       stoppedByStreamer: true,
//     });

//   } catch (error) {
//     console.error("Streamer screen share stop error:", error);
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


// const handleScreenShareResponse = async (
//   socket,
//   sessionId,
//   requesterIdentifier,
//   allow
// ) => {
//   try {
//     console.log(
//       "Screen share response from streamer:",
//       allow,
//       "for:",
//       requesterIdentifier
//     );
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
//       console.log(
//         "No pending screen share request found for:",
//         requesterIdentifier
//       );
//       return;
//     }

//     state.pendingScreenShareRequests.delete(request.userId);

//     // 🔴 Old event (direct response to requester)
//     safeEmit(request.socketId, "screen-share-response", {
//       allowed: allow,
//       message: allow
//         ? "You can now share your screen"
//         : "Streamer denied your screen share request",
//     });

//     if (allow) {
//       // Add to active screen shares
//       state.activeScreenShares.set(request.userId, {
//         userId: request.userId,
//         socketId: request.socketId,
//         userName: request.userName,
//         startedAt: new Date(),
//       });

//       // ✅ Update participant status
//       const participant = state.participants.get(request.userId);
//       if (participant) {
//         participant.isScreenSharing = true;

//         // 🔴 Old event (partial update)
//         io.to(sessionId).emit("participant_updated", {
//           userId: request.userId,
//           updates: { isScreenSharing: true },
//         });

//         // 🟢 New event (full snapshot)
//         broadcastParticipantsList(sessionId);
//       }

//       // 🔴 Old event (notify all participants about start)
//       io.to(sessionId).emit("screen-share-started-by-viewer", {
//         userId: request.userId,
//         userName: request.userName,
//         socketId: request.socketId,
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


// // Server mein yeh handler update karo
// const handleViewerScreenShareStop = async (socket, sessionId, userId = null) => {
//   try {
//     console.log("Viewer screen share stop from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const targetUserId = userId || socket.data?.userId;
//     if (!targetUserId) return;

//     // Clean up from active screen shares
//     state.activeScreenShares.delete(targetUserId);

//     // ✅ Update participant status for ALL participants
//     const participant = state.participants.get(targetUserId);
//     if (participant) {
//       participant.isScreenSharing = false;

//       // Notify ALL participants about status change
//       io.to(sessionId).emit("participant_updated", {
//         userId: targetUserId,
//         updates: { isScreenSharing: false }
//       });
      
//       // Broadcast updated participants list to ALL
//       broadcastParticipantsList(sessionId);
//     }

//     // Clean up screen share producers
//     for (const [producerId, producer] of state.producers) {
//       if (
//         producer.appData?.userId === targetUserId &&
//         (producer.appData?.source === "viewer-screen" ||
//           producer.appData?.source === "viewer-screen-audio")
//       ) {
//         try {
//           producer.close();
//         } catch (e) {
//           console.warn("Error closing screen share producer:", e);
//         }
//         state.producers.delete(producerId);
//       }
//     }

//     // ✅ IMPORTANT: Notify ALL participants including other viewers
//     io.to(sessionId).emit("screen-share-stopped-by-viewer", {
//       userId: targetUserId,
//       stoppedByStreamer: false,
//       // Add source to identify it's a viewer screen share
//       source: "viewer-screen"
//     });

//     console.log(`Screen share stopped for user: ${targetUserId}, notified all participants`);
//   } catch (error) {
//     console.error("Viewer screen share stop error:", error);
//   }
// };
// const handleStreamerStopScreenShare = async (socket, sessionId, targetUserId) => {
//   try {
//     console.log("Streamer stopping screen share for user:", targetUserId);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     state.activeScreenShares.delete(targetUserId);

//     // ✅ Update participant status
//     const participant = state.participants.get(targetUserId);
//     if (participant) {
//       participant.isScreenSharing = false;

//       io.to(sessionId).emit("participant_updated", {
//         userId: targetUserId,
//         updates: { isScreenSharing: false },
//       });

//       broadcastParticipantsList(sessionId);
//     }

//     // Find and close the screen share producer(s)
//     for (const [producerId, producer] of state.producers) {
//       if (
//         producer.appData?.userId === targetUserId &&
//         (producer.appData?.source === "viewer-screen" ||
//           producer.appData?.source === "viewer-screen-audio")
//       ) {
//         try {
//           producer.close();
//         } catch (e) {}
//         state.producers.delete(producerId);
//         console.log(`Screen share producer ${producerId} closed`);
//       }
//     }

//     // Notify the viewer
//     const viewerSocket = state.participants.get(targetUserId)?.socketId;
//     if (viewerSocket) {
//       safeEmit(viewerSocket, "screen-share-force-stop", {
//         message: "Streamer stopped your screen share",
//       });
//     }

//     // ✅ CORRECT: Add stoppedByStreamer flag
//     io.to(sessionId).emit("screen-share-stopped-by-viewer", {
//       userId: targetUserId,
//       stoppedByStreamer: true  // 👈 YAHAN FLAG ADD KARO
//     });

//     console.log(`✅ Streamer forced stop of screen share for user ${targetUserId}`);
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
//     console.log(
//       "updateParticipantStatus for session:",
//       sessionId,
//       "updates:",
//       updates
//     );
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       // update participant object
//       Object.assign(participant, updates);

//       // 🔴 Old event (partial update — keep for compatibility)
//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates,
//       });

//       // 🟢 New event (always send full list)
//       broadcastParticipantsList(sessionId);
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

//       const currentParticipants = Array.from(state.participants.values());
//       // 🔴 Old event (keep for compatibility)
//       io.to(sid).emit("participant_left", {
//         participants: currentParticipants,
//       });

//       // 🟢 New event: full list
//       broadcastParticipantsList(sid);
//     }

//     if (state.whiteboardId) {
//       console.log(
//         `Processing whiteboard leave for user: ${meta.userId}, whiteboard: ${state.whiteboardId}`
//       );
//       const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//       if (wb) {
//         const participant = wb.participants.find((p) => p.user.toString() === meta.userId);
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
//           $or: [{ sessionId: sid, userId: meta.userId }, { socketId: socket.id }],
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
//         await flushCanvasOps(sid).catch((err) => {
//           console.error(
//             `Error flushing canvas ops during cleanup for session ${sid}:`,
//             err
//           );
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

// const handleViewerAudioProduce = async (
//   socket,
//   sessionId,
//   transportId,
//   rtpParameters,
//   callback
// ) => {
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
//         source: "viewer-mic",
//         userId: socket.data.userId,
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // 🔴 Old event: notify all participants about the new audio producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: "viewer-mic",
//     });

//     // 🔴 Old event: audio permission granted
//     io.to(sessionId).emit("viewer-audio-permission-granted", {
//       userId: socket.data.userId,
//       producerId: producer.id,
//       socketId: socket.id,
//       userName: state.sockets.get(socket.id)?.userName || "Viewer",
//     });

//     callback({ id: producer.id });

//     // Participant update
//     const meta = state.sockets.get(socket.id);
//     if (meta) {
//       const participant = state.participants.get(meta.userId);
//       if (participant) {
//         participant.hasAudio = true;

//         // 🔴 Old event (keep for compatibility)
//         io.to(sessionId).emit("participant_updated", {
//           userId: meta.userId,
//           updates: { hasAudio: true },
//         });

//         // 🟢 New event (full snapshot)
//         broadcastParticipantsList(sessionId);
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



// const handleViewerVideoProduce = async (
//   socket,
//   sessionId,
//   transportId,
//   rtpParameters,
//   callback
// ) => {
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
//         source: "viewer-camera",
//         userId: socket.data.userId,
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // 🔴 Old event: notify all participants about the new video producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: "viewer-camera",
//     });

//     callback({ id: producer.id });

//     // ✅ Update participant status
//     const meta = state.sockets.get(socket.id);
//     if (meta) {
//       const participant = state.participants.get(meta.userId);
//       if (participant) {
//         participant.hasVideo = true;

//         // 🔴 Old event (partial update — keep for compatibility)
//         io.to(sessionId).emit("participant_updated", {
//           userId: meta.userId,
//           updates: { hasVideo: true },
//         });

//         // 🟢 New event (full snapshot)
//         broadcastParticipantsList(sessionId);
//       }
//     }

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
//   console.log(`🎧 Viewer audio response from streamer: ${allow} for: ${requesterSocketId}`);
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   const viewerMeta = state.sockets.get(requesterSocketId);
//   if (!viewerMeta) return;

//   const participant = state.participants.get(viewerMeta.userId);

//   if (allow) {
//     // ✅ Tell viewer to start producing audio
//     io.to(requesterSocketId).emit("viewer-audio-response", { 
//       allowed: true,
//       mustProduce: true   // 👈 important flag for frontend
//     });

//     if (participant) {
//       participant.hasAudio = true;  // 🔥 mark audio as active
//       io.to(sessionId).emit("participant_updated", {
//         userId: viewerMeta.userId,
//         updates: { hasAudio: true },
//       });

//       // 🔄 broadcast full updated participant list
//       broadcastParticipantsList(sessionId);
//     }
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
//       if (
//         producer.appData?.socketId === targetSocketId &&
//         producer.kind === "audio" &&
//         producer.appData?.source === "viewer-mic"
//       ) {
//         await producer.pause();
//         console.log(`Viewer audio producer ${producerId} muted`);

//         const viewerMeta = state.sockets.get(targetSocketId);
//         if (viewerMeta) {
//           const participant = state.participants.get(viewerMeta.userId);
//           if (participant) {
//             participant.hasAudio = false;

//             // 🔴 Old event (partial update — keep for compatibility)
//             io.to(sessionId).emit("participant_updated", {
//               userId: viewerMeta.userId,
//               updates: { hasAudio: false },
//             });

//             // 🟢 New event (full snapshot)
//             broadcastParticipantsList(sessionId);
//           }
//         }

//         // 🔴 Old event (notify muted viewer only)
//         safeEmit(targetSocketId, "viewer-audio-muted", {
//           producerId: producer.id,
//           mutedBy: socket.data.userId,
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
//       if (
//         producer.appData?.socketId === targetSocketId &&
//         producer.kind === "video" &&
//         producer.appData?.source === "viewer-camera"
//       ) {
//         await producer.pause();
//         console.log(`Viewer video producer ${producerId} muted`);

//         const viewerMeta = state.sockets.get(targetSocketId);
//         if (viewerMeta) {
//           const participant = state.participants.get(viewerMeta.userId);
//           if (participant) {
//             participant.hasVideo = false;

//             // 🔴 Old event (partial update — keep for compatibility)
//             io.to(sessionId).emit("participant_updated", {
//               userId: viewerMeta.userId,
//               updates: { hasVideo: false },
//             });

//             // 🟢 New event (full snapshot)
//             broadcastParticipantsList(sessionId);
//           }
//         }

//         // 🔴 Old event (notify muted viewer only)
//         safeEmit(targetSocketId, "viewer-video-muted", {
//           producerId: producer.id,
//           mutedBy: socket.data.userId,
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

//       socket.emit("producer-closed", { 
//     consumerId: consumer.id,
//     producerId: producer.producerId,  // 👈 optional, if needed
//     userId: producer.appData?.userId,
//     source: producer.appData?.source
//   });
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

//     // 🔴 Old event (keep for compatibility)
//     const currentParticipants = Array.from(state.participants.values());
//     io.to(sid).emit("participant_joined", {
//       participants: currentParticipants
//     });

//     // 🟢 New full list event (always latest snapshot)
//     broadcastParticipantsList(sid);

//     // Sirf newly joined socket ke liye current list
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
//         activeScreenShares: Array.from(state.activeScreenShares.values()),
//         participants: Array.from(state.participants.values())
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
//         activeProducers: Array.from(state.producers.keys()),
//         participants: Array.from(state.participants.values())
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


//   io.on("connection", (socket) => {
//     console.log("New client connected:", socket.id);

//     // ====== NEW EVENT HANDLERS ADDED ======
//     // These events will forward messages to all clients in the room
   
    
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

// // ✅ YE LINE ADD KARO socket event handlers mein
// socket.on("transport-produce-streamer-screen-audio", (data, cb) =>
//   handleStreamerScreenShareAudio(socket, data.sessionId, data.transportId, data.rtpParameters, cb)
// );

// socket.on("viewer-video-response", (data) => {
//   const requesterId = data.requesterSocketId || data.requesterSocket || data.userId || data.requesterUserId;
//   const allow = (typeof data.allow === 'boolean') ? data.allow : data.allowed;
//   handleViewerVideoResponse(socket, data.sessionId, requesterId, allow);
// });

    
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

//     socket.on("streamer-stop-viewer-audio", (data) => 
//   handleStreamerStopViewerAudio(socket, data.sessionId, data.targetSocketId)
// );

// socket.on("streamer-screen-share-stop", (data) => 
//   handleStreamerScreenShareStop(socket, data.sessionId)
// );



    
//     socket.on("viewer-video-started", (data) => 
//       handleViewerVideoStarted(socket, data.sessionId, data)
//     );
    
//     socket.on("screen-share-started-by-viewer", (data) => 
//       handleScreenShareStartedByViewer(socket, data.sessionId, data)
//     );

//     socket.on("screen-share-stopped-by-viewer", (data) => 
//   handleScreenShareStoppedByViewer(socket, data)
// );
    
  
//     // Server side
// socket.on("screen-share-stop", async ({ sessionId, userId }) => {
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.userId === userId && producer.appData?.source === "screen") {
//       try {
//         producer.close();
//       } catch (e) {
//         console.warn("Error closing screen producer", e);
//       }
//       state.producers.delete(producerId);
//       console.log(`✅ Screen producer closed for user ${userId}`);
//     }
//   }

//   io.to(sessionId).emit("screen-share-stop", { userId, byStreamer: true });
// });

    
//     socket.on("viewer-audio-enabled", (data) => 
//       handleViewerAudioEnabled(socket, data.sessionId, data)
//     );
    
//     socket.on("viewer-video-enabled", (data) => 
//       handleViewerVideoEnabled(socket, data.sessionId, data)
//     );

//     socket.on("viewer-camera-pause", (data) => 
//   handleViewerCameraPause(socket, data.sessionId)
// );

// socket.on("viewer-camera-resume", (data) => 
//   handleViewerCameraResume(socket, data.sessionId)
// );

// socket.on("viewer-camera-stop", (data) => 
//   handleViewerCameraStop(socket, data.sessionId)
// );


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
//     socket.on("streamer-stop-viewer-video", (data) =>
//   handleStreamerStopViewerVideo(socket, data.sessionId, data.targetSocketId)
// );


//     socket.on("viewer-camera-stopped", (data) => {
//   const { sessionId, userId } = data;
//   const state = roomState.get(sessionId);
//   if (!state) return;

//   // producers cleanup
//   for (const [producerId, producer] of state.producers) {
//     if (producer.appData?.userId === userId && producer.appData?.source === "viewer-camera") {
//       try { producer.close(); } catch {}
//       state.producers.delete(producerId);
//       console.log(`📷 Viewer camera producer ${producerId} closed`);
//     }
//   }

//   // update participant
//   const participant = state.participants.get(userId);
//   if (participant) {
//     participant.hasVideo = false;
//     io.to(sessionId).emit("participant_updated", {
//       userId,
//       updates: { hasVideo: false },
//     });
//     broadcastParticipantsList(sessionId);
//   }

//   // notify sabko
//   io.to(sessionId).emit("producer-closed", {
//     userId,
//     source: "viewer-camera",
//   });
// });

    
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

//     // ✅ Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = true;

//       // 🔴 Old event (partial update — keep for compatibility)
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasAudio: true },
//       });

//       // 🟢 New event (full snapshot)
//       broadcastParticipantsList(sessionId);
//     }

//     // 🔴 Old event (notify all participants)
//     io.to(sessionId).emit("viewer-audio-started-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer",
//       socketId: socket.id,
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

//     // ✅ Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasVideo = true;

//       // 🔴 Old event (partial update — keep for compatibility)
//       io.to(sessionId).emit("participant_updated", {
//         userId: data.userId,
//         updates: { hasVideo: true },
//       });

//       // 🟢 New event (full snapshot)
//       broadcastParticipantsList(sessionId);
//     }

//     // 🔴 Old event (notify all participants)
//     io.to(sessionId).emit("viewer-video-started-global", {
//       userId: data.userId,
//       userName: data.userName || "Viewer",
//       socketId: socket.id,
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

//     // ✅ Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasAudio = true;

//       // 🔴 Old event (forward to all except sender — keep for compatibility)
//       socket.to(sessionId).emit("viewer-audio-enabled", data);

//       // 🟢 New event (full snapshot)
//       broadcastParticipantsList(sessionId);
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

//     // ✅ Update participant status
//     const participant = state.participants.get(data.userId);
//     if (participant) {
//       participant.hasVideo = true;

//       // 🔴 Old event (forward to all except sender — keep for compatibility)
//       socket.to(sessionId).emit("viewer-video-enabled", data);

//       // 🟢 New event (full snapshot)
//       broadcastParticipantsList(sessionId);
//     }
//   } catch (error) {
//     console.error("Viewer video enabled error:", error);
//   }
// };

// export { getIO }; 

