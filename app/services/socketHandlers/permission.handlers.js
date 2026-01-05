// services/socketHandlers/permission.handlers.js
import { roomState } from "../socketState/roomState.js";
import authenticationModel from "../../model/Authentication/authentication.model.js";
import { safeEmit, broadcastParticipantsList } from "../socketUtils/general.utils.js";

export const permissionHandlers = (socket, io) => {
  // Audio/Video permission events
  socket.on("viewer-audio-request", (data) => 
    handleViewerAudioRequest(socket, io, data.sessionId)
  );
  
  socket.on("viewer-video-request", (data) => 
    handleViewerVideoRequest(socket, io, data.sessionId)
  );
  
  socket.on("viewer-audio-response", (data) => 
    handleViewerAudioResponse(socket, io, data.sessionId, data.requesterSocketId, data.allow)
  );
  
  socket.on("viewer-video-response", (data) => 
    handleViewerVideoResponse(socket, io, data.sessionId, data.requesterSocketId || data.requesterUserId, data.allow)
  );
  
  // Audio/Video produce events
  socket.on("transport-produce-viewer-audio", (data, cb) =>
    handleViewerAudioProduce(socket, io, data.sessionId, data.transportId, data.rtpParameters, cb)
  );
  
  socket.on("transport-produce-viewer-video", (data, cb) =>
    handleViewerVideoProduce(socket, io, data.sessionId, data.transportId, data.rtpParameters, cb)
  );
  
  // Mute/Stop events
  socket.on("viewer-audio-mute", (data) => 
    handleViewerAudioMute(socket, io, data.sessionId, data.targetSocketId)
  );
  
  socket.on("viewer-video-mute", (data) => 
    handleViewerVideoMute(socket, io, data.sessionId, data.targetSocketId)
  );
  
  socket.on("streamer-stop-viewer-audio", (data) => 
    handleStreamerStopViewerAudio(socket, io, data.sessionId, data.targetSocketId)
  );
  
  socket.on("streamer-stop-viewer-video", (data) => 
    handleStreamerStopViewerVideo(socket, io, data.sessionId, data.targetSocketId)
  );
  
  // Camera control events
  socket.on("viewer-camera-pause", (data) => 
    handleViewerCameraPause(socket, io, data.sessionId)
  );
  
  socket.on("viewer-camera-resume", (data) => 
    handleViewerCameraResume(socket, io, data.sessionId)
  );
  
  socket.on("viewer-camera-stop", (data) => 
    handleViewerCameraStop(socket, io, data.sessionId)
  );
  
  // Forwarding events
  socket.on("viewer-audio-enabled", (data) => {
    console.log("Viewer audio enabled event received, forwarding to room:", data.sessionId);
    socket.to(data.sessionId).emit("viewer-audio-enabled", data);
  });
  
  socket.on("screen-share-started-by-viewer", (data) => {
    console.log("Screen share started by viewer event received, forwarding to room:", data.sessionId);
    socket.to(data.sessionId).emit("screen-share-started-by-viewer", data);
  });
};

const handleViewerAudioRequest = async (socket, io, sessionId) => {
  try {
    console.log("Viewer audio permission request from:", socket.id);
    const state = roomState.get(sessionId);
    if (!state || !state.streamerSocketId) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    const user = await authenticationModel.findById(meta.userId).select("name");
    
    safeEmit(io, state.streamerSocketId, "viewer-audio-request", {
      requestedUserId: meta.userId,
      requesterSocketId: socket.id,
      requesterName: user?.name || "Viewer"
    });
  } catch (error) {
    console.error("Viewer audio request error:", error);
  }
};

const handleViewerVideoRequest = async (socket, io, sessionId) => {
  try {
    console.log("Viewer video permission request from:", socket.id);
    const state = roomState.get(sessionId);
    if (!state || !state.streamerSocketId) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    const user = await authenticationModel.findById(meta.userId).select("name");
    
    safeEmit(io, state.streamerSocketId, "viewer-video-request", {
      requestedUserId: meta.userId,
      requesterSocketId: socket.id,
      requesterName: user?.name || "Viewer"
    });
  } catch (error) {
    console.error("Viewer video request error:", error);
  }
};

const handleViewerAudioResponse = (socket, io, sessionId, requesterSocketId, allow) => {
  console.log(`🎧 Viewer audio response from streamer: ${allow} for: ${requesterSocketId}`);
  const state = roomState.get(sessionId);
  if (!state) return;

  const viewerMeta = state.sockets.get(requesterSocketId);
  if (!viewerMeta) return;

  const participant = state.participants.get(viewerMeta.userId);

  if (allow) {
    // ✅ Tell viewer to start producing audio
    io.to(requesterSocketId).emit("viewer-audio-response", { 
      allowed: true,
      mustProduce: true   // 👈 important flag for frontend
    });

    if (participant) {
      participant.hasAudio = true;  // 🔥 mark audio as active
      io.to(sessionId).emit("participant_updated", {
        userId: viewerMeta.userId,
        updates: { hasAudio: true },
      });

      // 🔄 broadcast full updated participant list
      broadcastParticipantsList(io, sessionId);
    }
  } else {
    io.to(requesterSocketId).emit("viewer-audio-response", { allowed: false });
  }
};

const handleViewerVideoResponse = async (socket, io, sessionId, requesterIdentifier, allow) => {
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
    safeEmit(io, viewerSocketId, "viewer-video-response", {
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


// // ✅ handleViewerVideoProduce mein participants list update karein
// const handleViewerVideoProduce = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("🎥 Viewer video produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.error("❌ Socket metadata not found for:", socket.id);
//       return callback({ error: "User not found" });
//     }

//     // ✅ Check if user already has a video producer
//     for (const [existingProducerId, existingProducer] of state.producers) {
//       if (
//         existingProducer.appData?.userId === meta.userId &&
//         existingProducer.appData?.source === "viewer-camera"
//       ) {
//         console.log("✅ User already has a video producer:", existingProducerId);
//         // Return existing producer
//         return callback({ id: existingProducerId });
//       }
//     }

//     const producer = await transport.produce({
//       kind: "video",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: "viewer-camera",
//         userId: meta.userId,
//         userName: meta.userName || "Viewer"
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // ✅ ✅ ✅ IMPORTANT: Update participant's hasVideo status
//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       participant.hasVideo = true;
      
//       // 🔄 Broadcast participant updated event
//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates: { hasVideo: true }
//       });
      
//       // 🔄 Broadcast full participants list
//       broadcastParticipantsList(io, sessionId);
      
//       console.log(`✅ Participant ${meta.userId} hasVideo set to true`);
//     }

//     // ✅ Notify everyone about new producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: "viewer-camera",
//       socketId: socket.id,
//       userName: meta.userName || "Viewer"
//     });

//     // ✅ Global event for video started
//     io.to(sessionId).emit("viewer-video-started-global", {
//       userId: meta.userId,
//       producerId: producer.id,
//       socketId: socket.id,
//       userName: meta.userName || "Viewer"
//     });

//     callback({ id: producer.id });

//     // Producer cleanup handlers
//     producer.on("transportclose", () => {
//       console.log("Viewer video producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
      
//       // Update participant status on cleanup
//       if (meta) {
//         const participant = state.participants.get(meta.userId);
//         if (participant) {
//           participant.hasVideo = false;
//           io.to(sessionId).emit("participant_updated", {
//             userId: meta.userId,
//             updates: { hasVideo: false }
//           });
//           broadcastParticipantsList(io, sessionId);
//         }
//       }
//     });

//     producer.on("trackended", () => {
//       console.log("📹 Video track ended:", producer.id);
//       // Auto cleanup
//       handleViewerCameraStop(socket, io, sessionId, meta.userId);
//     });

//   } catch (error) {
//     console.error("❌ Viewer video produce error:", error);
//     callback({ error: error.message });
//   }
// };

// // ✅ handleViewerAudioProduce mein participants list update karein
// const handleViewerAudioProduce = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("🎤 Viewer audio produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.error("❌ Socket metadata not found for:", socket.id);
//       return callback({ error: "User not found" });
//     }

//     // ✅ Check if user already has audio producer
//     for (const [existingProducerId, existingProducer] of state.producers) {
//       if (
//         existingProducer.appData?.userId === meta.userId &&
//         existingProducer.appData?.source === "viewer-mic"
//       ) {
//         console.log("✅ User already has audio producer:", existingProducerId);
//         return callback({ id: existingProducerId });
//       }
//     }

//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: "viewer-mic",
//         userId: meta.userId,
//         userName: meta.userName || "Viewer"
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // ✅ ✅ ✅ IMPORTANT: Update participant's hasAudio status
//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       participant.hasAudio = true;
      
//       // 🔄 Broadcast participant updated event
//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates: { hasAudio: true }
//       });
      
//       // 🔄 Broadcast full participants list
//       broadcastParticipantsList(io, sessionId);
      
//       console.log(`✅ Participant ${meta.userId} hasAudio set to true`);
//     }

//     // ✅ Notify everyone about new audio producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: "viewer-mic",
//       socketId: socket.id,
//       userName: meta.userName || "Viewer"
//     });

//     // ✅ Global event for audio started
//     io.to(sessionId).emit("viewer-audio-started-global", {
//       userId: meta.userId,
//       producerId: producer.id,
//       socketId: socket.id,
//       userName: meta.userName || "Viewer"
//     });

//     callback({ id: producer.id });

//     // Producer cleanup handlers
//     producer.on("transportclose", () => {
//       console.log("🎤 Viewer audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
      
//       // Update participant status on cleanup
//       if (meta) {
//         const participant = state.participants.get(meta.userId);
//         if (participant) {
//           participant.hasAudio = false;
//           io.to(sessionId).emit("participant_updated", {
//             userId: meta.userId,
//             updates: { hasAudio: false }
//           });
//           broadcastParticipantsList(io, sessionId);
//         }
//       }
//     });

//   } catch (error) {
//     console.error("❌ Viewer audio produce error:", error);
//     callback({ error: error.message });
//   }
// };


// const handleViewerVideoProduce = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("🎥 Viewer video produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.error("❌ Socket metadata not found for:", socket.id);
//       return callback({ error: "User not found" });
//     }

//     // ✅ Check if user already has a video producer
//     for (const [existingProducerId, existingProducer] of state.producers) {
//       if (
//         existingProducer.appData?.userId === meta.userId &&
//         existingProducer.appData?.source === "viewer-camera"
//       ) {
//         console.log("✅ User already has a video producer:", existingProducerId);
//         // Return existing producer
//         return callback({ id: existingProducerId });
//       }
//     }

//     const producer = await transport.produce({
//       kind: "video",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: "viewer-camera",
//         userId: meta.userId,
//         userName: meta.userName || "Viewer"
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // ✅ ✅ ✅ IMPORTANT: Update participant's hasVideo status
//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       participant.hasVideo = true;
      
//       // 🔄 Broadcast participant updated event - PEHLE
//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates: { hasVideo: true }
//       });
      
//       // 🔄 Broadcast full participants list - PEHLE
//       broadcastParticipantsList(io, sessionId);
      
//       console.log(`✅ Participant ${meta.userId} hasVideo set to true`);
//     }

//     // ✅ Notify everyone about new producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: "viewer-camera",
//       socketId: socket.id,
//       userName: meta.userName || "Viewer"
//     });

//     // ✅ Global event for video started
//     io.to(sessionId).emit("viewer-video-started-global", {
//       userId: meta.userId,
//       producerId: producer.id,
//       socketId: socket.id,
//       userName: meta.userName || "Viewer"
//     });

//     // ✅ CALLBACK SE PEHLE SAB BROADCAST HO GAYA
//     callback({ id: producer.id });

//     // Producer cleanup handlers
//     producer.on("transportclose", () => {
//       console.log("Viewer video producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
      
//       // Update participant status on cleanup
//       if (meta) {
//         const participant = state.participants.get(meta.userId);
//         if (participant) {
//           participant.hasVideo = false;
//           io.to(sessionId).emit("participant_updated", {
//             userId: meta.userId,
//             updates: { hasVideo: false }
//           });
//           broadcastParticipantsList(io, sessionId);
//         }
//       }
//     });

//     producer.on("trackended", () => {
//       console.log("📹 Video track ended:", producer.id);
//       // Auto cleanup
//       handleViewerCameraStop(socket, io, sessionId, meta.userId);
//     });

//   } catch (error) {
//     console.error("❌ Viewer video produce error:", error);
//     callback({ error: error.message });
//   }
// };

// const handleViewerAudioProduce = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("🎤 Viewer audio produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.error("❌ Socket metadata not found for:", socket.id);
//       return callback({ error: "User not found" });
//     }

//     // ✅ Check if user already has audio producer
//     for (const [existingProducerId, existingProducer] of state.producers) {
//       if (
//         existingProducer.appData?.userId === meta.userId &&
//         existingProducer.appData?.source === "viewer-mic"
//       ) {
//         console.log("✅ User already has audio producer:", existingProducerId);
//         return callback({ id: existingProducerId });
//       }
//     }

//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: "viewer-mic",
//         userId: meta.userId,
//         userName: meta.userName || "Viewer"
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // ✅ ✅ ✅ IMPORTANT: Update participant's hasAudio status
//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       participant.hasAudio = true;
      
//       // 🔄 Broadcast participant updated event - PEHLE
//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates: { hasAudio: true }
//       });
      
//       // 🔄 Broadcast full participants list - PEHLE
//       broadcastParticipantsList(io, sessionId);
      
//       console.log(`✅ Participant ${meta.userId} hasAudio set to true`);
//     }

//     // ✅ Notify everyone about new audio producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: "viewer-mic",
//       socketId: socket.id,
//       userName: meta.userName || "Viewer"
//     });

//     // ✅ Global event for audio started
//     io.to(sessionId).emit("viewer-audio-started-global", {
//       userId: meta.userId,
//       producerId: producer.id,
//       socketId: socket.id,
//       userName: meta.userName || "Viewer"
//     });

//     // ✅ CALLBACK SE PEHLE SAB BROADCAST HO GAYA
//     callback({ id: producer.id });

//     // Producer cleanup handlers
//     producer.on("transportclose", () => {
//       console.log("🎤 Viewer audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         // ignore
//       }
//       state.producers.delete(producer.id);
      
//       // Update participant status on cleanup
//       if (meta) {
//         const participant = state.participants.get(meta.userId);
//         if (participant) {
//           participant.hasAudio = false;
//           io.to(sessionId).emit("participant_updated", {
//             userId: meta.userId,
//             updates: { hasAudio: false }
//           });
//           broadcastParticipantsList(io, sessionId);
//         }
//       }
//     });

//   } catch (error) {
//     console.error("❌ Viewer audio produce error:", error);
//     callback({ error: error.message });
//   }
// };


const handleViewerVideoProduce = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
  try {
    console.log("🎥 === VIDEO PRODUCE START ===");
    console.log("🎥 Socket ID:", socket.id);
    console.log("🎥 Session ID:", sessionId);
    console.log("🎥 Transport ID:", transportId);
    
    // 1. Get room state
    const state = roomState.get(sessionId);
    if (!state) {
      console.error("❌ Session not found in roomState:", sessionId);
      console.log("🎥 Available sessions:", Array.from(roomState.keys()));
      return callback({ error: "Session not found" });
    }
    console.log("✅ Session found in roomState");

    // 2. Get transport
    const transport = state.transports.get(transportId);
    if (!transport) {
      console.error("❌ Transport not found:", transportId);
      console.log("🎥 Available transports:", Array.from(state.transports.keys()));
      return callback({ error: "Transport not found" });
    }
    console.log("✅ Transport found");

    // 3. Get socket metadata
    const meta = state.sockets.get(socket.id);
    if (!meta) {
      console.error("❌ Socket metadata not found for socket ID:", socket.id);
      console.log("🎥 Available sockets in state:", Array.from(state.sockets.keys()));
      return callback({ error: "User not found" });
    }
    console.log("✅ Socket metadata found:", {
      userId: meta.userId,
      userName: meta.userName,
      isStreamer: meta.isStreamer
    });

    // 4. DEBUG: Check participants BEFORE any changes
    console.log("🔍 === PARTICIPANTS BEFORE ===");
    console.log("🔍 Total participants in state:", state.participants.size);
    console.log("🔍 Participant IDs:", Array.from(state.participants.keys()));
    
    // Check if this user exists in participants
    const existingParticipant = state.participants.get(meta.userId);
    if (existingParticipant) {
      console.log("✅ Participant already exists:", {
        userId: existingParticipant.userId,
        userName: existingParticipant.userName,
        hasAudio: existingParticipant.hasAudio,
        hasVideo: existingParticipant.hasVideo,
        socketId: existingParticipant.socketId,
        isStreamer: existingParticipant.isStreamer
      });
    } else {
      console.warn("⚠️ Participant NOT found for userId:", meta.userId);
      // // Create participant if not exists
      // const newParticipant = {
      //   userId: meta.userId,
      //   userName: meta.userName || "Viewer",
      //   hasAudio: false,
      //   hasVideo: false,
      //   isStreamer: false,
      //   socketId: socket.id,
      //   isMuted: false,
      //   isSpeaking: false,
      //   joinTime: Date.now()
      // };
      // state.participants.set(meta.userId, newParticipant);
      // console.log("✅ Created new participant:", newParticipant);
    }

    // 5. Check for existing video producers
    console.log("🔍 Checking for existing video producers...");
    let existingVideoProducerId = null;
    for (const [producerId, producer] of state.producers) {
      console.log(`🔍 Checking producer ${producerId}:`, {
        userId: producer.appData?.userId,
        source: producer.appData?.source,
        kind: producer.kind
      });
      
      if (
        producer.appData?.userId === meta.userId &&
        producer.appData?.source === "viewer-camera" &&
        producer.kind === "video"
      ) {
        existingVideoProducerId = producerId;
        console.log("✅ Found existing video producer:", producerId);
        console.log("Producer details:", {
          userId: producer.appData?.userId,
          source: producer.appData?.source,
          kind: producer.kind,
          socketId: producer.appData?.socketId
        });
        break;
      }
    }

    if (existingVideoProducerId) {
      console.log("🔄 Found existing video producer, updating participant...");
      
      // Update participant status even for existing producer
      const participant = state.participants.get(meta.userId);
      if (participant) {
        console.log("✅ Found participant for update:", participant);
        participant.hasVideo = true;
        participant.socketId = socket.id; // Update socket ID if changed
        
        // Save back to map
        state.participants.set(meta.userId, participant);
        
        // Broadcast updates
        console.log("📢 Broadcasting participant_updated event...");
        io.to(sessionId).emit("participant_updated", {
          userId: meta.userId,
          updates: { hasVideo: true }
        });
        
        console.log("📢 Broadcasting participants list...");
        broadcastParticipantsList(io, sessionId);
        
        console.log(`✅ Participant ${meta.userId} hasVideo set to true`);
        
        // DEBUG: Check participants AFTER update
        console.log("🔍 === PARTICIPANTS AFTER EXISTING PRODUCER UPDATE ===");
        const updatedParticipant = state.participants.get(meta.userId);
        console.log("🔍 Updated participant:", updatedParticipant);
        
        // Check all participants
        console.log("🔍 All participants in room:");
        for (const [uid, p] of state.participants) {
          console.log(`  - ${uid}:`, {
            userName: p.userName,
            hasVideo: p.hasVideo,
            hasAudio: p.hasAudio,
            isStreamer: p.isStreamer
          });
        }
      } else {
        console.error("❌ ERROR: Participant not found for existing producer!");
      }
      
      // Return existing producer ID
      return callback({ id: existingVideoProducerId });
    }

    // 6. Create new video producer
    console.log("🎥 Creating NEW video producer...");
    try {
      const producer = await transport.produce({
        kind: "video",
        rtpParameters,
        appData: {
          socketId: socket.id,
          environment: process.env.NODE_ENV,
          source: "viewer-camera",
          userId: meta.userId,
          userName: meta.userName || "Viewer"
        },
      });

      console.log("✅ Video producer created successfully:", producer.id);
      state.producers.set(producer.id, producer);
      
      // DEBUG: Check all producers after creation
      console.log("🔍 Total producers after creation:", state.producers.size);
      console.log("🔍 All producers:");
      for (const [pid, prod] of state.producers) {
        console.log(`  - ${pid}:`, {
          kind: prod.kind,
          userId: prod.appData?.userId,
          source: prod.appData?.source,
          socketId: prod.appData?.socketId
        });
      }

      // 7. Update participant status
      console.log("🔄 Updating participant status...");
      let participant = state.participants.get(meta.userId);
      if (participant) {
        console.log("✅ Found participant to update:", {
          beforeHasVideo: participant.hasVideo,
          beforeSocketId: participant.socketId
        });
        
        participant.hasVideo = true;
        participant.socketId = socket.id;
        
        // Save back to map
        state.participants.set(meta.userId, participant);
        
        console.log("✅ Updated participant in state:", {
          userId: participant.userId,
          hasVideo: participant.hasVideo,
          hasAudio: participant.hasAudio,
          socketId: participant.socketId
        });
      } else {
        console.error("❌ ERROR: Participant not found after producer creation!");
        // Create as fallback
        participant = {
          userId: meta.userId,
          userName: meta.userName || "Viewer",
          hasAudio: false,
          hasVideo: true,
          isStreamer: false,
          socketId: socket.id,
          isMuted: false,
          isSpeaking: false,
          joinTime: Date.now()
        };
        state.participants.set(meta.userId, participant);
        console.log("✅ Created participant as fallback:", participant);
      }

      // 8. DEBUG: Check participants AFTER update
      console.log("🔍 === PARTICIPANTS AFTER UPDATE ===");
      const updatedParticipant = state.participants.get(meta.userId);
      console.log("🔍 Updated participant:", updatedParticipant);
      
      // Check ALL participants in room
      console.log("🔍 ALL PARTICIPANTS IN ROOM:");
      for (const [uid, p] of state.participants) {
        console.log(`  - ${uid}:`, {
          userName: p.userName,
          hasVideo: p.hasVideo,
          hasAudio: p.hasAudio,
          isStreamer: p.isStreamer,
          socketId: p.socketId
        });
      }

      // 9. Broadcast events - PEHLE callback se pehle
      console.log("📢 Broadcasting events to room:", sessionId);
      
      // Event 1: participant_updated
      console.log("📢 Emitting participant_updated event...");
      io.to(sessionId).emit("participant_updated", {
        userId: meta.userId,
        updates: { hasVideo: true }
      });
      console.log("✅ participant_updated event emitted");
      
      // Event 2: broadcastParticipantsList
      console.log("📢 Calling broadcastParticipantsList...");
      broadcastParticipantsList(io, sessionId);
      console.log("✅ broadcastParticipantsList called");
      
      // Event 3: new-producer
      console.log("📢 Emitting new-producer event...");
      io.to(sessionId).emit("new-producer", {
        producerId: producer.id,
        kind: producer.kind,
        userId: meta.userId,
        source: "viewer-camera",
        socketId: socket.id,
        userName: meta.userName || "Viewer"
      });
      console.log("✅ new-producer event emitted");
      
      // Event 4: viewer-video-started-global
      console.log("📢 Emitting viewer-video-started-global...");
      io.to(sessionId).emit("viewer-video-started-global", {
        userId: meta.userId,
        producerId: producer.id,
        socketId: socket.id,
        userName: meta.userName || "Viewer"
      });
      console.log("✅ viewer-video-started-global event emitted");

      // Event 5: viewer-video-permission-granted (for consistency)
      console.log("📢 Emitting viewer-video-permission-granted...");
      io.to(sessionId).emit("viewer-video-permission-granted", {
        userId: meta.userId,
        producerId: producer.id,
        socketId: socket.id,
        userName: meta.userName || "Viewer"
      });
      console.log("✅ viewer-video-permission-granted event emitted");

      // 10. Send callback response
      console.log("✅ Sending callback with producer ID:", producer.id);
      callback({ id: producer.id });
      console.log("✅ Callback sent");

      // 11. Setup producer event handlers
      console.log("🔧 Setting up producer event handlers...");
      
      producer.on("transportclose", () => {
        console.log("🚪 Video producer transport closed:", producer.id);
        try {
          producer.close();
        } catch (e) {
          console.warn("Warning closing producer:", e);
        }
        state.producers.delete(producer.id);
        
        // Update participant on cleanup
        if (meta) {
          const cleanupParticipant = state.participants.get(meta.userId);
          if (cleanupParticipant) {
            cleanupParticipant.hasVideo = false;
            state.participants.set(meta.userId, cleanupParticipant);
            
            io.to(sessionId).emit("participant_updated", {
              userId: meta.userId,
              updates: { hasVideo: false }
            });
            broadcastParticipantsList(io, sessionId);
            console.log(`✅ Participant ${meta.userId} hasVideo set to false on cleanup`);
          }
        }
      });

      producer.on("trackended", () => {
        console.log("⏹️ Video track ended for producer:", producer.id);
        // Auto cleanup
        handleViewerCameraStop(socket, io, sessionId, meta.userId);
      });

      console.log("🎥 === VIDEO PRODUCE COMPLETED SUCCESSFULLY ===");

    } catch (produceError) {
      console.error("❌ Error in transport.produce():", produceError);
      console.error("❌ Error stack:", produceError.stack);
      callback({ error: produceError.message });
    }

  } catch (error) {
    console.error("❌ === VIDEO PRODUCE ERROR ===");
    console.error("❌ Error message:", error.message);
    console.error("❌ Error stack:", error.stack);
    console.error("❌ Error details:", error);
    
    // Send detailed error to frontend
    callback({ 
      error: error.message,
      code: error.name,
      details: "Video production failed"
    });
  }
};





const handleViewerAudioProduce = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
  try {
    console.log("🎤 === AUDIO PRODUCE START ===");
    console.log("🎤 Socket ID:", socket.id);
    console.log("🎤 Session ID:", sessionId);
    console.log("🎤 Transport ID:", transportId);
    
    // 1. Get room state
    const state = roomState.get(sessionId);
    if (!state) {
      console.error("❌ Session not found in roomState:", sessionId);
      console.log("🎤 Available sessions:", Array.from(roomState.keys()));
      return callback({ error: "Session not found" });
    }
    console.log("✅ Session found in roomState");

    // 2. Get transport
    const transport = state.transports.get(transportId);
    if (!transport) {
      console.error("❌ Transport not found:", transportId);
      console.log("🎤 Available transports:", Array.from(state.transports.keys()));
      return callback({ error: "Transport not found" });
    }
    console.log("✅ Transport found");

    // 3. Get socket metadata
    const meta = state.sockets.get(socket.id);
    if (!meta) {
      console.error("❌ Socket metadata not found for socket ID:", socket.id);
      console.log("🎤 Available sockets in state:", Array.from(state.sockets.keys()));
      return callback({ error: "User not found" });
    }
    console.log("✅ Socket metadata found:", {
      userId: meta.userId,
      userName: meta.userName,
      isStreamer: meta.isStreamer
    });

    // 4. DEBUG: Check participants BEFORE any changes
    console.log("🔍 === PARTICIPANTS BEFORE ===");
    console.log("🔍 Total participants in state:", state.participants.size);
    console.log("🔍 Participant IDs:", Array.from(state.participants.keys()));
    
    // Check if this user exists in participants
    const existingParticipant = state.participants.get(meta.userId);
    if (existingParticipant) {
      console.log("✅ Participant already exists:", {
        userId: existingParticipant.userId,
        userName: existingParticipant.userName,
        hasAudio: existingParticipant.hasAudio,
        hasVideo: existingParticipant.hasVideo,
        socketId: existingParticipant.socketId
      });
    } else {
      console.warn("⚠️ Participant NOT found for userId:", meta.userId);
      
    }

    // 5. Check for existing audio producers
    console.log("🔍 Checking for existing audio producers...");
    let existingAudioProducerId = null;
    for (const [producerId, producer] of state.producers) {
      if (
        producer.appData?.userId === meta.userId &&
        producer.appData?.source === "viewer-mic" &&
        producer.kind === "audio"
      ) {
        existingAudioProducerId = producerId;
        console.log("✅ Found existing audio producer:", producerId);
        console.log("Producer details:", {
          userId: producer.appData?.userId,
          source: producer.appData?.source,
          kind: producer.kind,
          socketId: producer.appData?.socketId
        });
        break;
      }
    }

    if (existingAudioProducerId) {
      // Update participant status even for existing producer
      const participant = state.participants.get(meta.userId);
      if (participant) {
        console.log("🔄 Updating participant for existing producer...");
        participant.hasAudio = true;
        participant.socketId = socket.id; // Update socket ID if changed
        
        // Save back to map
        state.participants.set(meta.userId, participant);
        
        // Broadcast updates
        console.log("📢 Broadcasting participant_updated event...");
        io.to(sessionId).emit("participant_updated", {
          userId: meta.userId,
          updates: { hasAudio: true }
        });
        
        console.log("📢 Broadcasting participants list...");
        broadcastParticipantsList(io, sessionId);
        
        console.log(`✅ Participant ${meta.userId} hasAudio set to true`);
      }
      
      // Return existing producer ID
      return callback({ id: existingAudioProducerId });
    }

    // 6. Create new audio producer
    console.log("🎤 Creating NEW audio producer...");
    try {
      const producer = await transport.produce({
        kind: "audio",
        rtpParameters,
        appData: {
          socketId: socket.id,
          environment: process.env.NODE_ENV,
          source: "viewer-mic",
          userId: meta.userId,
          userName: meta.userName || "Viewer"
        },
      });

      console.log("✅ Audio producer created successfully:", producer.id);
      state.producers.set(producer.id, producer);

      // 7. Update participant status
      console.log("🔄 Updating participant status...");
      const participant = state.participants.get(meta.userId);
      if (participant) {
        participant.hasAudio = true;
        participant.socketId = socket.id;
        
        // Save back to map
        state.participants.set(meta.userId, participant);
        
        console.log("✅ Updated participant in state:", {
          userId: participant.userId,
          hasAudio: participant.hasAudio,
          hasVideo: participant.hasVideo,
          socketId: participant.socketId
        });
      } else {
        console.error("❌ ERROR: Participant still not found after creation!");
        // Create as fallback
        const newParticipant = {
          userId: meta.userId,
          userName: meta.userName || "Viewer",
          hasAudio: true,
          hasVideo: false,
          isStreamer: false,
          socketId: socket.id,
          isMuted: false,
          isSpeaking: false,
          joinTime: Date.now()
        };
        state.participants.set(meta.userId, newParticipant);
        console.log("✅ Created participant as fallback:", newParticipant);
      }

      // 8. DEBUG: Check participants AFTER update
      console.log("🔍 === PARTICIPANTS AFTER UPDATE ===");
      const updatedParticipant = state.participants.get(meta.userId);
      console.log("🔍 Updated participant:", updatedParticipant);
      console.log("🔍 All participants:", Array.from(state.participants.entries()));

      // 9. Broadcast events - PEHLE callback se pehle
      console.log("📢 Broadcasting events to room:", sessionId);
      
      // Event 1: participant_updated
      console.log("📢 Emitting participant_updated...");
      io.to(sessionId).emit("participant_updated", {
        userId: meta.userId,
        updates: { hasAudio: true }
      });
      
      // Event 2: broadcastParticipantsList
      console.log("📢 Calling broadcastParticipantsList...");
      broadcastParticipantsList(io, sessionId);
      
      // Event 3: new-producer
      console.log("📢 Emitting new-producer...");
      io.to(sessionId).emit("new-producer", {
        producerId: producer.id,
        kind: producer.kind,
        userId: meta.userId,
        source: "viewer-mic",
        socketId: socket.id,
        userName: meta.userName || "Viewer"
      });
      
      // Event 4: viewer-audio-started-global
      console.log("📢 Emitting viewer-audio-started-global...");
      io.to(sessionId).emit("viewer-audio-started-global", {
        userId: meta.userId,
        producerId: producer.id,
        socketId: socket.id,
        userName: meta.userName || "Viewer"
      });

      // 10. Send callback response
      console.log("✅ Sending callback with producer ID:", producer.id);
      callback({ id: producer.id });

      // 11. Setup producer event handlers
      console.log("🔧 Setting up producer event handlers...");
      
      producer.on("transportclose", () => {
        console.log("🚪 Audio producer transport closed:", producer.id);
        try {
          producer.close();
        } catch (e) {
          console.warn("Warning closing producer:", e);
        }
        state.producers.delete(producer.id);
        
        // Update participant on cleanup
        if (meta) {
          const cleanupParticipant = state.participants.get(meta.userId);
          if (cleanupParticipant) {
            cleanupParticipant.hasAudio = false;
            state.participants.set(meta.userId, cleanupParticipant);
            
            io.to(sessionId).emit("participant_updated", {
              userId: meta.userId,
              updates: { hasAudio: false }
            });
            broadcastParticipantsList(io, sessionId);
            console.log(`✅ Participant ${meta.userId} hasAudio set to false on cleanup`);
          }
        }
      });

      producer.on("trackended", () => {
        console.log("⏹️ Audio track ended for producer:", producer.id);
        // Auto cleanup logic can go here
      });

      console.log("🎤 === AUDIO PRODUCE COMPLETED SUCCESSFULLY ===");

    } catch (produceError) {
      console.error("❌ Error in transport.produce():", produceError);
      console.error("❌ Error stack:", produceError.stack);
      callback({ error: produceError.message });
    }

  } catch (error) {
    console.error("❌ === AUDIO PRODUCE ERROR ===");
    console.error("❌ Error message:", error.message);
    console.error("❌ Error stack:", error.stack);
    console.error("❌ Error details:", error);
    
    // Send detailed error to frontend
    callback({ 
      error: error.message,
      code: error.name,
      details: "Audio production failed"
    });
  }
};

// const handleViewerVideoProduce = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
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

//     // ✅ Directly notify all participants
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: "viewer-camera",
//     });

//     callback({ id: producer.id });

//     // ✅ Directly update participant status
//     const meta = state.sockets.get(socket.id);
//     if (meta) {
//       const participant = state.participants.get(meta.userId);
//       if (participant) {
//         participant.hasVideo = true;

//         io.to(sessionId).emit("participant_updated", {
//           userId: meta.userId,
//           updates: { hasVideo: true },
//         });

//         broadcastParticipantsList(io, sessionId);
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

// const handleViewerAudioProduce = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
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

//     // ✅ Directly notify all participants (no permission request needed)
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: socket.data.userId,
//       source: "viewer-mic",
//     });

//     callback({ id: producer.id });

//     // ✅ Directly update participant status
//     const meta = state.sockets.get(socket.id);
//     if (meta) {
//       const participant = state.participants.get(meta.userId);
//       if (participant) {
//         participant.hasAudio = true;

//         io.to(sessionId).emit("participant_updated", {
//           userId: meta.userId,
//           updates: { hasAudio: true },
//         });

//         broadcastParticipantsList(io, sessionId);
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


// const handleViewerAudioProduce = async (
//   socket,
//   sessionId,
//   transportId,
//   rtpParameters,
//   callback
// ) => {
//   try {
//     console.log("🎤 Viewer audio produce for transport:", transportId);
//     const state = roomState.get(sessionId);
//     if (!state) {
//       console.error("❌ Session not found:", sessionId);
//       return callback({ error: "Session not found" });
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) {
//       console.error("❌ Transport not found:", transportId);
//       return callback({ error: "Transport not found" });
//     }

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.error("❌ Socket metadata not found for socket:", socket.id);
//       return callback({ error: "Unauthorized" });
//     }

//     // Check if there's already an audio producer for this user
//     for (const [existingProducerId, existingProducer] of state.producers) {
//       if (
//         existingProducer.appData?.userId === meta.userId &&
//         existingProducer.appData?.source === "viewer-mic" &&
//         existingProducer.kind === "audio"
//       ) {
//         console.log("✅ User already has an audio producer:", existingProducerId);
//         // Return existing producer ID
//         return callback({ id: existingProducerId });
//       }
//     }

//     // Produce audio track
//     console.log("🎤 Creating new audio producer for user:", meta.userId);
//     const producer = await transport.produce({
//       kind: "audio",
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: "viewer-mic",
//         userId: meta.userId,
//         userName: meta.userName || "Viewer"
//       },
//     });

//     state.producers.set(producer.id, producer);
//     console.log("✅ Audio producer created:", producer.id);

//     // ✅ Update participant status
//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       participant.hasAudio = true;
      
//       // Notify all participants about status change
//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates: { hasAudio: true },
//       });
      
//       // Broadcast updated participants list
//       broadcastParticipantsList(sessionId);
//     }

//     // ✅ Notify everyone about new audio producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: "viewer-mic",
//       socketId: socket.id
//     });

//     // ✅ Specifically send to the viewer who started audio
//     io.to(socket.id).emit("viewer-audio-permission-granted", {
//       userId: meta.userId,
//       producerId: producer.id,
//       socketId: socket.id,
//       userName: meta.userName || "Viewer",
//     });

//     // ✅ Notify all that viewer audio started
//     io.to(sessionId).emit("viewer-audio-started", {
//       userId: meta.userId,
//       producerId: producer.id,
//       socketId: socket.id,
//       userName: meta.userName || "Viewer",
//     });

//     // ✅ Callback with producer ID
//     if (callback && typeof callback === 'function') {
//       callback({ id: producer.id });
//     }

//     // Handle producer events
//     producer.on("transportclose", () => {
//       console.log("📴 Viewer audio producer transport closed:", producer.id);
//       try {
//         producer.close();
//       } catch (e) {
//         console.warn("Error closing audio producer:", e);
//       }
//       state.producers.delete(producer.id);
      
//       // Update participant status
//       if (meta) {
//         const participant = state.participants.get(meta.userId);
//         if (participant) {
//           participant.hasAudio = false;
//           io.to(sessionId).emit("participant_updated", {
//             userId: meta.userId,
//             updates: { hasAudio: false },
//           });
//           broadcastParticipantsList(sessionId);
//         }
//       }
//     });

//     producer.on("trackended", () => {
//       console.log("🎤 Audio track ended for producer:", producer.id);
//       // Clean up automatically
//       try {
//         producer.close();
//       } catch (e) {
//         console.warn("Error closing track-ended producer:", e);
//       }
//       state.producers.delete(producer.id);
//     });

//     console.log(`✅ Audio setup complete for user: ${meta.userId}`);

//   } catch (error) {
//     console.error("❌ Viewer audio produce error:", error);
//     if (callback && typeof callback === 'function') {
//       callback({ 
//         error: error.message,
//         code: error.name === 'TypeError' ? 'TYPE_ERROR' : 'UNKNOWN_ERROR'
//       });
//     }
//   }
// };

const handleViewerAudioMute = async (socket, io, sessionId, targetSocketId) => {
  try {
    console.log("Muting viewer audio:", targetSocketId);
    const state = roomState.get(sessionId);
    if (!state) return;

    for (const [producerId, producer] of state.producers) {
      if (
        producer.appData?.socketId === targetSocketId &&
        producer.kind === "audio" &&
        producer.appData?.source === "viewer-mic"
      ) {
        await producer.pause();
        console.log(`Viewer audio producer ${producerId} muted`);

        const viewerMeta = state.sockets.get(targetSocketId);
        if (viewerMeta) {
          const participant = state.participants.get(viewerMeta.userId);
          if (participant) {
            participant.hasAudio = false;

            // 🔴 Old event (partial update — keep for compatibility)
            io.to(sessionId).emit("participant_updated", {
              userId: viewerMeta.userId,
              updates: { hasAudio: false },
            });

            // 🟢 New event (full snapshot)
            broadcastParticipantsList(io, sessionId);
          }
        }

        // 🔴 Old event (notify muted viewer only)
        safeEmit(io, targetSocketId, "viewer-audio-muted", {
          producerId: producer.id,
          mutedBy: socket.data.userId,
        });

        break;
      }
    }
  } catch (error) {
    console.error("Viewer audio mute error:", error);
  }
};

const handleViewerVideoMute = async (socket, io, sessionId, targetSocketId) => {
  try {
    console.log("Muting viewer video:", targetSocketId);
    const state = roomState.get(sessionId);
    if (!state) return;

    for (const [producerId, producer] of state.producers) {
      if (
        producer.appData?.socketId === targetSocketId &&
        producer.kind === "video" &&
        producer.appData?.source === "viewer-camera"
      ) {
        await producer.pause();
        console.log(`Viewer video producer ${producerId} muted`);

        const viewerMeta = state.sockets.get(targetSocketId);
        if (viewerMeta) {
          const participant = state.participants.get(viewerMeta.userId);
          if (participant) {
            participant.hasVideo = false;

            // 🔴 Old event (partial update — keep for compatibility)
            io.to(sessionId).emit("participant_updated", {
              userId: viewerMeta.userId,
              updates: { hasVideo: false },
            });

            // 🟢 New event (full snapshot)
            broadcastParticipantsList(io, sessionId);
          }
        }

        // 🔴 Old event (notify muted viewer only)
        safeEmit(io, targetSocketId, "viewer-video-muted", {
          producerId: producer.id,
          mutedBy: socket.data.userId,
        });

        break;
      }
    }
  } catch (error) {
    console.error("Viewer video mute error:", error);
  }
};

const handleStreamerStopViewerAudio = async (socket, io, sessionId, targetSocketId) => {
  try {
    console.log("Streamer forcing stop of viewer audio:", targetSocketId);
    const state = roomState.get(sessionId);
    if (!state) return;

    for (const [producerId, producer] of state.producers) {
      if (
        producer.appData?.socketId === targetSocketId &&
        producer.kind === "audio" &&
        producer.appData?.source === "viewer-mic"
      ) {
        try {
          producer.close();
        } catch (e) {
          console.error("Error closing viewer audio producer:", e);
        }

        // ❌ Remove producer from state
        state.producers.delete(producerId);

        const viewerMeta = state.sockets.get(targetSocketId);
        if (!viewerMeta) return;

        const participant = state.participants.get(viewerMeta.userId);
        if (participant) {
          // 🔹 Update hasAudio flag
          participant.hasAudio = false;

          // 🔹 Update participant object in state
          state.participants.set(viewerMeta.userId, participant);

          // 🔹 Broadcast a delta update (optional)
          io.to(sessionId).emit("participant_updated", {
            userId: viewerMeta.userId,
            updates: { hasAudio: false },
          });

          // 🔹 Always send full updated snapshot
          broadcastParticipantsList(io, sessionId);
        }

        // 🔹 Reset producer reference
        viewerMeta.audioProducerId = null;

        // 🔹 Tell the target viewer: cleanup & reset UI
        io.to(targetSocketId).emit("viewer-audio-force-stopped", {
          userId: viewerMeta.userId,
          message: "Streamer stopped your audio, please request again",
        });

        console.log(`✅ Viewer audio stopped: ${viewerMeta.userId}`);
        break;
      }
    }
  } catch (error) {
    console.error("Streamer stop viewer audio error:", error);
  }
};

const handleStreamerStopViewerVideo = async (socket, io, sessionId, targetSocketId) => {
  try {
    console.log("🎥 Streamer forcing stop of viewer video:", targetSocketId);
    const state = roomState.get(sessionId);
    if (!state) return;

    for (const [producerId, producer] of state.producers) {
      if (
        producer.appData?.socketId === targetSocketId &&
        producer.kind === "video" &&
        producer.appData?.source === "viewer-camera"
      ) {
        try {
          producer.close();
        } catch (e) {
          console.error("Error closing viewer video producer:", e);
        }

        // ❌ Remove producer from state
        state.producers.delete(producerId);

        const viewerMeta = state.sockets.get(targetSocketId);
        if (!viewerMeta) return;

        const participant = state.participants.get(viewerMeta.userId);
        if (participant) {
          // 🔹 Update participant object
          participant.hasVideo = false;
          state.participants.set(viewerMeta.userId, participant);

          // 🔹 Broadcast a delta update
          io.to(sessionId).emit("participant_updated", {
            userId: viewerMeta.userId,
            updates: { hasVideo: false },
          });

          // 🔹 Always send full updated snapshot
          broadcastParticipantsList(io, sessionId);
        }

        // 🔹 Reset meta reference
        viewerMeta.videoProducerId = null;

        // 🔹 Tell the target viewer to cleanup & reset UI
        safeEmit(io, targetSocketId, "viewer-video-force-stopped", {
          userId: viewerMeta.userId,
          message: "Streamer stopped your video, please request again",
        });

        // 🔹 Notify everyone (global event)
        io.to(sessionId).emit("viewer-video-force-stopped-global", {
          userId: viewerMeta.userId,
          userName: viewerMeta.userName || "Viewer",
        });

        // 🔹 Emit the same event used when viewer stops voluntarily
        io.to(sessionId).emit("viewer-camera-stopped", {
          userId: viewerMeta.userId,
        });

        console.log(`✅ Viewer video stopped: ${viewerMeta.userId}`);
        break;
      }
    }
  } catch (error) {
    console.error("Streamer stop viewer video error:", error);
  }
};

const handleViewerCameraPause = async (socket, io, sessionId) => {
  try {
    console.log("📷 handleViewerCameraPause called:", { sessionId, socketId: socket.id });
    const state = roomState.get(sessionId);
    if (!state) return;

    for (const [producerId, producer] of state.producers) {
      if (
        producer.appData?.socketId === socket.id &&
        producer.appData?.source === "viewer-camera"
      ) {
        try {
          await producer.pause();
          console.log(`📷 Viewer camera paused: ${producerId}`);
        } catch (err) {
          console.warn("Error pausing viewer camera producer:", err);
        }

        const participant = state.participants.get(socket.data.userId);
        if (participant) {
          participant.hasVideo = false;

          // 🔴 Partial update for compatibility
          io.to(sessionId).emit("participant_updated", {
            userId: socket.data.userId,
            updates: { hasVideo: false },
          });

          // 🟢 Full snapshot
          broadcastParticipantsList(io, sessionId);
        }

        // 🔔 Notify everyone (compatibility event)
        io.to(sessionId).emit("viewer-camera-paused", {
          userId: socket.data.userId,
          socketId: socket.id,
        });

        // 🔔 Extra global event for clarity
        io.to(sessionId).emit("viewer-camera-paused-global", {
          userId: socket.data.userId,
          userName: state.sockets.get(socket.id)?.userName || "Viewer",
        });

        console.log(`✅ Viewer camera paused for user: ${socket.data.userId}`);
        break;
      }
    }
  } catch (error) {
    console.error("handleViewerCameraPause error:", error);
  }
};

const handleViewerCameraResume = async (socket, io, sessionId) => {
  try {
    console.log("📷 handleViewerCameraResume called:", { sessionId, socketId: socket.id });
    const state = roomState.get(sessionId);
    if (!state) return;

    for (const [producerId, producer] of state.producers) {
      if (
        producer.appData?.socketId === socket.id &&
        producer.appData?.source === "viewer-camera"
      ) {
        try {
          await producer.resume();
          console.log(`📷 Viewer camera resumed: ${producerId}`);
        } catch (err) {
          console.warn("Error resuming viewer camera producer:", err);
        }

        const participant = state.participants.get(socket.data.userId);
        if (participant) {
          participant.hasVideo = true;

          // 🔴 Partial update for compatibility
          io.to(sessionId).emit("participant_updated", {
            userId: socket.data.userId,
            updates: { hasVideo: true },
          });

          // 🟢 Full snapshot
          broadcastParticipantsList(io, sessionId);
        }

        // 🔔 Notify everyone (compatibility event)
        io.to(sessionId).emit("viewer-camera-resumed", {
          userId: socket.data.userId,
          socketId: socket.id,
        });

        // 🔔 Extra global event for clarity
        io.to(sessionId).emit("viewer-camera-resumed-global", {
          userId: socket.data.userId,
          userName: state.sockets.get(socket.id)?.userName || "Viewer",
        });

        console.log(`✅ Viewer camera resumed for user: ${socket.data.userId}`);
        break;
      }
    }
  } catch (error) {
    console.error("handleViewerCameraResume error:", error);
  }
};

const handleViewerCameraStop = async (socket, io, sessionId, userId = null) => {
  try {
    console.log("📷 handleViewerCameraStop called:", { sessionId, userId });
    const state = roomState.get(sessionId);
    if (!state) return;

    const targetUserId = userId || socket.data.userId;

    // 🛑 Close and remove all camera producers for this user
    for (const [producerId, producer] of state.producers) {
      if (
        producer.appData?.userId === targetUserId &&
        producer.appData?.source === "viewer-camera"
      ) {
        try {
          producer.close();
        } catch (err) {
          console.warn("Error closing viewer camera producer:", err);
        }
        state.producers.delete(producerId);
        console.log(`📷 Viewer camera producer ${producerId} closed`);
      }
    }

    // 🟢 Update participant status
    const participant = state.participants.get(targetUserId);
    if (participant) {
      participant.hasVideo = false;
      io.to(sessionId).emit("participant_updated", {
        userId: targetUserId,
        updates: { hasVideo: false },
      });
      broadcastParticipantsList(io, sessionId);
    }

    // 🔔 Notify everyone in the room
    io.to(sessionId).emit("viewer-camera-stopped", {
      userId: targetUserId,
    });

    // 🔔 Extra event for consistency with producer cleanup
    io.to(sessionId).emit("producer-closed", {
      userId: targetUserId,
      source: "viewer-camera",
    });

    console.log(`✅ Viewer camera fully stopped for user: ${targetUserId}`);
  } catch (error) {
    console.error("handleViewerCameraStop error:", error);
  }
};