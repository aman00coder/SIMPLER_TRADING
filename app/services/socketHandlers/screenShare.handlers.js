import { roomState } from "../socketState/roomState.js";
import authenticationModel from "../../model/Authentication/authentication.model.js";
import { safeEmit, broadcastParticipantsList } from "../socketUtils/general.utils.js";

export const screenShareHandlers = (socket, io) => {
  socket.on("screen-share-request", (data) => 
    handleScreenShareRequest(socket, io, data.sessionId)
  );
  
  socket.on("screen-share-response", (data) => 
    handleScreenShareResponse(socket, io, data.sessionId, data.requesterUserId, data.allow)
  );
  
  socket.on("transport-produce-screen", (data, cb) =>
    handleScreenShareStart(socket, io, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
  );
  
  socket.on("transport-produce-viewer-screen", (data, cb) =>
    handleViewerScreenShareStart(socket, io, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
  );
  
  socket.on("screen-share-stop", (data) => 
    handleStreamerScreenShareStop(socket, io, data.sessionId, data.userId)
  );
  
  socket.on("screen-share-force-stop", (data) => 
    handleStreamerStopScreenShare(socket, io, data.sessionId, data.targetUserId)
  );

  socket.on("viewer-screen-share-stop", (data) => 
    handleViewerScreenShareStop(socket, io, data.sessionId)
  );
  
  socket.on("streamer-consume-viewer-screen", (data) => 
    handleStreamerConsumeViewerScreen(socket, io, data.sessionId, data.producerId)
  );
  
  socket.on("transport-produce-viewer-screen-audio", (data, cb) =>
    handleViewerScreenShareAudio(socket, io, data.sessionId, data.transportId, data.rtpParameters, cb)
  );
  
  socket.on("screen-share-stopped-by-viewer", (data) => 
    handleScreenShareStoppedByViewer(socket, io, data)
  );
  
  socket.on("streamer-screen-share-stop", (data) => 
    handleStreamerScreenShareStop(socket, io, data.sessionId)
  );
};

const handleScreenShareRequest = async (socket, io, sessionId) => {
  try {
    console.log("Screen share request from:", socket.id);
    const state = roomState.get(sessionId);
    if (!state) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    // ✅ REMOVED: Permission check - directly allow
    // if (state.activeScreenShares.has(meta.userId)) {
    //   socket.emit("screen-share-error", { message: "You already have an active screen share" });
    //   return;
    // }

    // ✅ Directly add to active screen shares
    state.activeScreenShares.set(meta.userId, {
      userId: meta.userId,
      socketId: socket.id,
      userName: meta.userName || "Viewer",
      startedAt: new Date(),
    });

    // ✅ Update participant status
    const participant = state.participants.get(meta.userId);
    if (participant) {
      participant.isScreenSharing = true;

      io.to(sessionId).emit("participant_updated", {
        userId: meta.userId,
        updates: { isScreenSharing: true },
      });

      broadcastParticipantsList(io, sessionId);
    }

    // ✅ Notify all participants
    io.to(sessionId).emit("screen-share-started-by-viewer", {
      userId: meta.userId,
      userName: meta.userName || "Viewer",
      socketId: socket.id,
    });

    console.log(`✅ Viewer ${meta.userId} started screen share directly`);
    
  } catch (error) {
    console.error("Screen share request error:", error);
    socket.emit("screen-share-error", { message: "Failed to start screen share" });
  }
};

const handleScreenShareResponse = async (socket, io, sessionId, requesterIdentifier, allow) => {
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

    // 🔴 Old event (direct response to requester)
    safeEmit(io, request.socketId, "screen-share-response", {
      allowed: allow,
      message: allow
        ? "You can now share your screen"
        : "Streamer denied your screen share request",
    });

    if (allow) {
      // Add to active screen shares
      state.activeScreenShares.set(request.userId, {
        userId: request.userId,
        socketId: request.socketId,
        userName: request.userName,
        startedAt: new Date(),
      });

      // ✅ Update participant status
      const participant = state.participants.get(request.userId);
      if (participant) {
        participant.isScreenSharing = true;

        // 🔴 Old event (partial update)
        io.to(sessionId).emit("participant_updated", {
          userId: request.userId,
          updates: { isScreenSharing: true },
        });

        // 🟢 New event (full snapshot)
        broadcastParticipantsList(io, sessionId);
      }

      // 🔴 Old event (notify all participants about start)
      io.to(sessionId).emit("screen-share-started-by-viewer", {
        userId: request.userId,
        userName: request.userName,
        socketId: request.socketId,
      });
    }
  } catch (error) {
    console.error("Screen share response error:", error);
  }
};

const handleScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
  try {
    console.log("🎥 STREAMER Screen share start for transport:", transportId, "kind:", kind);
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
        source: 'screen',  // 🔑 KEY: "screen" source for streamer
        userId: socket.data.userId,
        userName: socket.data.userName || 'Streamer'
      },
    });

    state.producers.set(producer.id, producer);
    
    // ✅ Update participant status
    const participant = state.participants.get(socket.data.userId);
    if (participant) {
      participant.isScreenSharing = true;
      io.to(sessionId).emit("participant_updated", {
        userId: socket.data.userId,
        updates: { isScreenSharing: true },
      });
      broadcastParticipantsList(io, sessionId);
    }

    callback({ id: producer.id });

    // ✅ Notify all participants
    io.to(sessionId).emit("screen-share-started", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      userName: socket.data.userName || 'Streamer',
      source: 'screen'
    });
    
    // ✅ Also emit new-producer for consumers
    io.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: 'screen'
    });

  } catch (error) {
    console.error("❌ Streamer screen share start error:", error);
    callback({ error: error.message });
  }
};

// const handleScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
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



const handleViewerScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
  try {
    console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const meta = state.sockets.get(socket.id);
    if (!meta) return callback({ error: "Unauthorized" });

    // if (!state.activeScreenShares.has(meta.userId)) {
    //   return callback({ error: "No screen share permission" });
    // }

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
      safeEmit(io, state.streamerSocketId, "new-viewer-screen-producer", {
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
      handleViewerScreenShareStop(socket, io, sessionId, meta.userId);
    });

  } catch (error) {
    console.error("Viewer screen share start error:", error);
    callback({ error: error.message });
  }
};


// const handleViewerScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return callback({ error: "Unauthorized" });

//     // ✅ CHECK for existing screen share producers for this user
//     const existingProducers = [];
//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.userId === meta.userId && 
//           (producer.appData?.source === 'viewer-screen' || 
//            producer.appData?.source === 'viewer-screen-audio')) {
//         existingProducers.push(producerId);
//       }
//     }

//     // ✅ If user already has screen share active, clean it up first
//     if (existingProducers.length > 0) {
//       console.log(`⚠️ User ${meta.userId} has existing screen share producers, cleaning up...`);
//       for (const producerId of existingProducers) {
//         const producer = state.producers.get(producerId);
//         if (producer) {
//           try {
//             producer.close();
//           } catch (e) {
//             console.warn("Error closing existing producer:", e);
//           }
//           state.producers.delete(producerId);
//         }
//       }
//     }

//     // ✅ CHECK for SSRC conflicts in ALL producers in the room
//     const requestedSsrc = rtpParameters?.encodings?.[0]?.ssrc;
//     if (requestedSsrc) {
//       for (const [producerId, producer] of state.producers) {
//         const producerSsrc = producer.rtpParameters?.encodings?.[0]?.ssrc;
//         if (producerSsrc === requestedSsrc) {
//           console.log(`⚠️ SSRC conflict detected: ${requestedSsrc} already used by producer ${producerId}`);
          
//           // Generate a new random SSRC
//           const newSsrc = Math.floor(Math.random() * 4294967295) + 1;
//           rtpParameters.encodings[0].ssrc = newSsrc;
          
//           // Also update RTX SSRC if present
//           if (rtpParameters.encodings[0].rtx && rtpParameters.encodings[0].rtx.ssrc) {
//             rtpParameters.encodings[0].rtx.ssrc = newSsrc + 1000000;
//           }
          
//           console.log(`✅ Generated new SSRC: ${newSsrc}`);
//           break;
//         }
//       }
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
//         userId: meta.userId,
//         timestamp: Date.now() // Add timestamp for tracking
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
//     if (state.streamerSocketId) {
//       safeEmit(io, state.streamerSocketId, "new-viewer-screen-producer", {
//         producerId: producer.id,
//         kind: producer.kind,
//         userId: meta.userId,
//         userName: meta.userName || 'Viewer',
//         source: 'viewer-screen',
//         ssrc: rtpParameters.encodings[0]?.ssrc
//       });
//     }

//     // Notify all participants about the new screen share producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen',
//       ssrc: rtpParameters.encodings[0]?.ssrc
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
//       handleViewerScreenShareStop(socket, io, sessionId, meta.userId);
//     });

//     producer.on("close", () => {
//       console.log("Viewer screen share producer closed:", producer.id);
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer screen share start error:", error);
    
//     // Handle specific mediasoup errors
//     if (error.message.includes("ssrc already exists")) {
//       // Try with new SSRC
//       if (rtpParameters?.encodings?.[0]) {
//         const newSsrc = Math.floor(Math.random() * 4294967295) + 1;
//         rtpParameters.encodings[0].ssrc = newSsrc;
        
//         // Retry with new SSRC
//         setTimeout(() => {
//           socket.emit("retry-screen-share", { 
//             transportId, 
//             rtpParameters,
//             reason: "ssrc_conflict_resolved"
//           });
//         }, 100);
//       }
//     }
    
//     callback({ error: error.message });
//   }
// };

// const handleViewerScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return callback({ error: "Unauthorized" });

//     // ✅ Step 1: Pehle existing screen share ko check aur clean karo
//     const existingScreenShareProducers = [];
//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.userId === meta.userId && 
//           (producer.appData?.source === 'viewer-screen' || 
//            producer.appData?.source === 'viewer-screen-audio')) {
//         existingScreenShareProducers.push({ producerId, producer });
//       }
//     }

//     // ✅ Agar existing screen share hai to pehle usko stop karo
//     if (existingScreenShareProducers.length > 0) {
//       console.log(`⚠️ User ${meta.userId} already has an active screen share. Stopping it first...`);
      
//       for (const { producerId, producer } of existingScreenShareProducers) {
//         try {
//           producer.close();
//           console.log(`✅ Closed existing producer: ${producerId}`);
//         } catch (e) {
//           console.warn("Error closing existing producer:", e);
//         }
//         state.producers.delete(producerId);
        
//         // Notify all participants including streamer
//         io.to(sessionId).emit("producer-closed", {
//           producerId: producerId,
//           userId: meta.userId,
//           source: producer.appData?.source,
//           reason: "replaced_by_new_screen_share"
//         });
//       }
      
//       // ✅ Update participant status temporarily
//       const participant = state.participants.get(meta.userId);
//       if (participant) {
//         participant.isScreenSharing = false;
        
//         // Brief update before new share starts
//         io.to(sessionId).emit("participant_updated", {
//           userId: meta.userId,
//           updates: { isScreenSharing: false }
//         });
//       }
      
//       // Small delay to ensure cleanup
//       await new Promise(resolve => setTimeout(resolve, 100));
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
//         userId: meta.userId,
//         timestamp: Date.now(),
//         isNewShare: true // Flag for tracking
//       },
//     });

//     state.producers.set(producer.id, producer);

//     // ✅ Update participant status for new share
//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       participant.isScreenSharing = true;
      
//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates: { isScreenSharing: true }
//       });
      
//       broadcastParticipantsList(io, sessionId);
//     }

//     // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
//     if (state.streamerSocketId) {
//       safeEmit(io, state.streamerSocketId, "new-viewer-screen-producer", {
//         producerId: producer.id,
//         kind: producer.kind,
//         userId: meta.userId,
//         userName: meta.userName || 'Viewer',
//         source: 'viewer-screen',
//         replacesExisting: existingScreenShareProducers.length > 0
//       });
//     }

//     // Notify all participants about the new screen share producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen',
//       replacesExisting: existingScreenShareProducers.length > 0
//     });

//     callback({ id: producer.id, replacedExisting: existingScreenShareProducers.length > 0 });

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
//       handleViewerScreenShareStop(socket, io, sessionId, meta.userId);
//     });

//     producer.on("close", () => {
//       console.log("Viewer screen share producer closed:", producer.id);
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("Viewer screen share start error:", error);
//     callback({ error: error.message });
//   }
// };

const handleStreamerConsumeViewerScreen = async (socket, io, sessionId, producerId) => {
  try {
    console.log("Streamer consuming viewer screen:", producerId);
    const state = roomState.get(sessionId);
    if (!state || !state.router) return;

    const producer = state.producers.get(producerId);
    if (!producer) return;

    // Create a consumer for the streamer
    createConsumer(socket, io, sessionId, producerId, producer.kind);
  } catch (error) {
    console.error("Streamer consume viewer screen error:", error);
  }
};

// const handleViewerScreenShareAudio = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
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

const handleViewerScreenShareAudio = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
  try {
    console.log("Viewer screen share audio for transport:", transportId);
    console.log("Socket ID:", socket.id);
    console.log("Session ID:", sessionId);
    console.log("RTP Parameters received:", rtpParameters ? "Yes" : "No");
    
    const state = roomState.get(sessionId);
    if (!state) {
      console.error("❌ Session not found for ID:", sessionId);
      return callback({ error: "Session not found" });
    }
    
    console.log("✅ Session found. Room state:", {
      hasSockets: state.sockets.size,
      hasTransports: state.transports.size,
      hasProducers: state.producers.size
    });

    const meta = state.sockets.get(socket.id);
    if (!meta) {
      console.error("❌ Socket metadata not found for socket ID:", socket.id);
      return callback({ error: "Unauthorized" });
    }
    
    console.log("✅ User metadata found:", {
      userId: meta.userId,
      userType: meta.userType || 'unknown'
    });

    const transport = state.transports.get(transportId);
    if (!transport) {
      console.error("❌ Transport not found for ID:", transportId);
      console.log("Available transports:", Array.from(state.transports.keys()));
      return callback({ error: "Transport not found" });
    }
    
    console.log("✅ Transport found. Attempting to produce audio...");
    console.log("Audio codec info:", rtpParameters?.codecs?.[0]?.mimeType || "Unknown");

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

    console.log("🎉✅ Viewer screen share audio producer created successfully!");
    console.log("Producer details:", {
      id: producer.id,
      kind: producer.kind,
      userId: meta.userId,
      source: 'viewer-screen-audio',
      codec: producer.rtpParameters?.codecs?.[0]?.mimeType || "Unknown"
    });

    state.producers.set(producer.id, producer);
    console.log(`📊 Total producers in room: ${state.producers.size}`);

    // Notify all participants about the new screen share audio producer
    console.log(`📢 Broadcasting 'new-producer' event to session: ${sessionId}`);
    io.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: meta.userId,
      source: 'viewer-screen-audio'
    });

    callback({ id: producer.id });
    console.log("✅ Callback sent with producer ID:", producer.id);

    producer.on("transportclose", () => {
      console.log("⚠️ Viewer screen share audio producer transport closed:", producer.id);
      console.log("User ID:", meta.userId, "Socket ID:", socket.id);
      try {
        producer.close();
        console.log("✅ Producer closed successfully");
      } catch (e) {
        console.error("❌ Error closing producer:", e.message);
      }
      state.producers.delete(producer.id);
      console.log(`📊 Remaining producers: ${state.producers.size}`);
    });

    // Optional: Add listener for producer close event
    producer.on("close", () => {
      console.log("🔴 Viewer screen share audio producer closed:", producer.id);
    });

    // Optional: Add listener for track ended
    producer.on("trackended", () => {
      console.log("🔇 Viewer screen share audio track ended:", producer.id);
    });

  } catch (error) {
    console.error("❌ Viewer screen share audio error:", error);
    console.error("Error stack:", error.stack);
    console.error("Error details:", {
      sessionId,
      transportId,
      socketId: socket.id,
      errorName: error.name,
      errorMessage: error.message
    });
    callback({ error: error.message });
  }
};


const handleViewerScreenShareStop = async (socket, io, sessionId, userId = null) => {
  try {
    console.log("Viewer screen share stop from:", socket.id);
    const state = roomState.get(sessionId);
    if (!state) return;

    const targetUserId = userId || socket.data?.userId;
    if (!targetUserId) return;

    // Clean up from active screen shares
    state.activeScreenShares.delete(targetUserId);

    // ✅ Update participant status for ALL participants
    const participant = state.participants.get(targetUserId);
    if (participant) {
      participant.isScreenSharing = false;

      // Notify ALL participants about status change
      io.to(sessionId).emit("participant_updated", {
        userId: targetUserId,
        updates: { isScreenSharing: false }
      });
      
      // Broadcast updated participants list to ALL
      broadcastParticipantsList(io, sessionId);
    }

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

    // ✅ IMPORTANT: Notify ALL participants including other viewers
    io.to(sessionId).emit("screen-share-stopped-by-viewer", {
      userId: targetUserId,
      stoppedByStreamer: false,
      // Add source to identify it's a viewer screen share
      source: "viewer-screen"
    });

    console.log(`Screen share stopped for user: ${targetUserId}, notified all participants`);
  } catch (error) {
    console.error("Viewer screen share stop error:", error);
  }
};



const handleStreamerStopScreenShare = async (socket, io, sessionId, targetUserId) => {
  try {
    console.log("Streamer stopping screen share for user:", targetUserId);
    const state = roomState.get(sessionId);
    if (!state) return;

    state.activeScreenShares.delete(targetUserId);

    // ✅ Update participant status
    const participant = state.participants.get(targetUserId);
    if (participant) {
      participant.isScreenSharing = false;

      io.to(sessionId).emit("participant_updated", {
        userId: targetUserId,
        updates: { isScreenSharing: false },
      });

      broadcastParticipantsList(io, sessionId);
    }

    // Find and close the screen share producer(s)
    for (const [producerId, producer] of state.producers) {
      if (
        producer.appData?.userId === targetUserId &&
        (producer.appData?.source === "viewer-screen" ||
          producer.appData?.source === "viewer-screen-audio")
      ) {
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
      safeEmit(io, viewerSocket, "screen-share-force-stop", {
        message: "Streamer stopped your screen share",
      });
    }

    // ✅ CORRECT: Add stoppedByStreamer flag
    io.to(sessionId).emit("screen-share-stopped-by-viewer", {
      userId: targetUserId,
      stoppedByStreamer: true  // 👈 YAHAN FLAG ADD KARO
    });

    console.log(`✅ Streamer forced stop of screen share for user ${targetUserId}`);
  } catch (error) {
    console.error("Streamer stop screen share error:", error);
  }
};

const handleScreenShareStoppedByViewer = async (socket, io, data) => {
  try {
    const { sessionId, userId } = data;
    console.log("🛑 Viewer stopped screen share:", userId);
    
    const state = roomState.get(sessionId);
    if (!state) return;

    // Clean up from active screen shares
    state.activeScreenShares.delete(userId);
    
    // Clean up screen share producers
    for (const [producerId, producer] of state.producers) {
      if (producer.appData?.userId === userId && 
          (producer.appData?.source === 'viewer-screen' || 
           producer.appData?.source === 'viewer-screen-audio')) {
        try {
          producer.close();
        } catch (e) {
          console.warn("Error closing screen share producer:", e);
        }
        state.producers.delete(producerId);
        console.log(`✅ Screen share producer ${producerId} closed`);
      }
    }

    // Update participant status
    const participant = state.participants.get(userId);
    if (participant) {
      participant.isScreenSharing = false;
      
      // Notify all participants about status change
      io.to(sessionId).emit("participant_updated", {
        userId: userId,
        updates: { isScreenSharing: false }
      });
      
      // Broadcast updated participants list
      broadcastParticipantsList(io, sessionId);
    }

    // ✅ IMPORTANT: Notify everyone including streamer
    io.to(sessionId).emit("screen-share-stopped-by-viewer", {
      userId: userId,
      stoppedByViewer: true
    });

    console.log(`✅ Viewer screen share cleaned up for user: ${userId}`);
  } catch (error) {
    console.error("handleScreenShareStoppedByViewer error:", error);
  }
};

const handleStreamerScreenShareStop = async (socket, io, sessionId) => {
  try {
    console.log("🎥 Streamer stopping own screen share:", socket.id);
    const state = roomState.get(sessionId);
    if (!state) return;

    // 🔴 Find and close all screen producers from this streamer
    for (const [producerId, producer] of state.producers) {
      if (
        producer.appData?.socketId === socket.id &&
        producer.appData?.source === "screen"
      ) {
        try {
          producer.close();
        } catch (e) {
          console.warn("Error closing streamer screen producer:", e);
        }
        state.producers.delete(producerId);
        console.log(`✅ Streamer screen producer ${producerId} closed`);
      }
    }

    // 🔹 Update participant flag
    const participant = state.participants.get(socket.data.userId);
    if (participant) {
      participant.isScreenSharing = false;
      io.to(sessionId).emit("participant_updated", {
        userId: socket.data.userId,
        updates: { isScreenSharing: false },
      });
      broadcastParticipantsList(io, sessionId);
    }

    // 🔹 Notify all viewers
    io.to(sessionId).emit("screen-share-stop", {
      userId: socket.data.userId,
      stoppedByStreamer: true,
    });

  } catch (error) {
    console.error("Streamer screen share stop error:", error);
  }
};

// Helper function for consumer creation
const createConsumer = async (socket, io, sessionId, producerId, kind) => {
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

      socket.emit("producer-closed", { 
        consumerId: consumer.id,
        producerId: producer.producerId,
        userId: producer.appData?.userId,
        source: producer.appData?.source
      });
      state.consumers.delete(consumer.id);
    });

  } catch (error) {
    console.error("createConsumer error:", error);
  }
};

export { createConsumer };


















// import { roomState } from "../socketState/roomState.js";
// import authenticationModel from "../../model/Authentication/authentication.model.js";
// import { safeEmit, broadcastParticipantsList } from "../socketUtils/general.utils.js";

// export const screenShareHandlers = (socket, io) => {
//   socket.on("screen-share-request", (data) => 
//     handleScreenShareRequest(socket, io, data.sessionId)
//   );
  
//   socket.on("screen-share-response", (data) => 
//     handleScreenShareResponse(socket, io, data.sessionId, data.requesterUserId, data.allow)
//   );
  
//   socket.on("transport-produce-screen", (data, cb) =>
//     handleScreenShareStart(socket, io, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//   );
  
//   socket.on("transport-produce-viewer-screen", (data, cb) =>
//     handleViewerScreenShareStart(socket, io, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//   );
  
//   socket.on("screen-share-stop", (data) => 
//     handleViewerScreenShareStop(socket, io, data.sessionId)
//   );
  
//   socket.on("screen-share-force-stop", (data) => 
//     handleStreamerStopScreenShare(socket, io, data.sessionId, data.targetUserId)
//   );
  
//   socket.on("streamer-consume-viewer-screen", (data) => 
//     handleStreamerConsumeViewerScreen(socket, io, data.sessionId, data.producerId)
//   );
  
//   socket.on("transport-produce-viewer-screen-audio", (data, cb) =>
//     handleViewerScreenShareAudio(socket, io, data.sessionId, data.transportId, data.rtpParameters, cb)
//   );
  
//   socket.on("screen-share-stopped-by-viewer", (data) => 
//     handleScreenShareStoppedByViewer(socket, io, data)
//   );
  
//   socket.on("streamer-screen-share-stop", (data) => 
//     handleStreamerScreenShareStop(socket, io, data.sessionId)
//   );
// };

// const handleScreenShareRequest = async (socket, io, sessionId) => {
//   try {
//     console.log("Screen share request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     // ✅ REMOVED: Permission check - directly allow
//     // if (state.activeScreenShares.has(meta.userId)) {
//     //   socket.emit("screen-share-error", { message: "You already have an active screen share" });
//     //   return;
//     // }

//     // ✅ Directly add to active screen shares
//     state.activeScreenShares.set(meta.userId, {
//       userId: meta.userId,
//       socketId: socket.id,
//       userName: meta.userName || "Viewer",
//       startedAt: new Date(),
//     });

//     // ✅ Update participant status
//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       participant.isScreenSharing = true;

//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates: { isScreenSharing: true },
//       });

//       broadcastParticipantsList(io, sessionId);
//     }

//     // ✅ Notify all participants
//     io.to(sessionId).emit("screen-share-started-by-viewer", {
//       userId: meta.userId,
//       userName: meta.userName || "Viewer",
//       socketId: socket.id,
//     });

//     console.log(`✅ Viewer ${meta.userId} started screen share directly`);
    
//   } catch (error) {
//     console.error("Screen share request error:", error);
//     socket.emit("screen-share-error", { message: "Failed to start screen share" });
//   }
// };

// const handleScreenShareResponse = async (socket, io, sessionId, requesterIdentifier, allow) => {
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

//     // 🔴 Old event (direct response to requester)
//     safeEmit(io, request.socketId, "screen-share-response", {
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
//         broadcastParticipantsList(io, sessionId);
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

// // const handleScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
// //   try {
// //     console.log("Screen share start for transport:", transportId, "kind:", kind);
// //     const state = roomState.get(sessionId);
// //     if (!state) return callback({ error: "Session not found" });

// //     const transport = state.transports.get(transportId);
// //     if (!transport) return callback({ error: "Transport not found" });

// //     const producer = await transport.produce({
// //       kind,
// //       rtpParameters,
// //       appData: {
// //         socketId: socket.id,
// //         environment: process.env.NODE_ENV,
// //         source: 'screen',
// //         userId: socket.data.userId 
// //       },
// //     });

// //     state.producers.set(producer.id, producer);

// //     producer.on("transportclose", () => {
// //       console.log("Screen share producer transport closed:", producer.id);
// //       try {
// //         producer.close();
// //       } catch (e) {
// //         // ignore
// //       }
// //       state.producers.delete(producer.id);
// //     });

// //     callback({ id: producer.id });

// //     socket.to(sessionId).emit("screen-share-started", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: socket.data.userId,
// //       source: 'screen'
// //     });
    
// //     socket.to(sessionId).emit("new-producer", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: socket.data.userId,
// //       source: 'screen'
// //     });
// //   } catch (error) {
// //     console.error("Screen share start error:", error);
// //     callback({ error: error.message });
// //   }
// // };



// const handleViewerScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return callback({ error: "Unauthorized" });

//     // if (!state.activeScreenShares.has(meta.userId)) {
//     //   return callback({ error: "No screen share permission" });
//     // }

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
//       safeEmit(io, state.streamerSocketId, "new-viewer-screen-producer", {
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
//       handleViewerScreenShareStop(socket, io, sessionId, meta.userId);
//     });

//   } catch (error) {
//     console.error("Viewer screen share start error:", error);
//     callback({ error: error.message });
//   }
// };


// // const handleViewerScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
// //   try {
// //     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
// //     const state = roomState.get(sessionId);
// //     if (!state) return callback({ error: "Session not found" });

// //     const meta = state.sockets.get(socket.id);
// //     if (!meta) return callback({ error: "Unauthorized" });

// //     // ✅ CHECK for existing screen share producers for this user
// //     const existingProducers = [];
// //     for (const [producerId, producer] of state.producers) {
// //       if (producer.appData?.userId === meta.userId && 
// //           (producer.appData?.source === 'viewer-screen' || 
// //            producer.appData?.source === 'viewer-screen-audio')) {
// //         existingProducers.push(producerId);
// //       }
// //     }

// //     // ✅ If user already has screen share active, clean it up first
// //     if (existingProducers.length > 0) {
// //       console.log(`⚠️ User ${meta.userId} has existing screen share producers, cleaning up...`);
// //       for (const producerId of existingProducers) {
// //         const producer = state.producers.get(producerId);
// //         if (producer) {
// //           try {
// //             producer.close();
// //           } catch (e) {
// //             console.warn("Error closing existing producer:", e);
// //           }
// //           state.producers.delete(producerId);
// //         }
// //       }
// //     }

// //     // ✅ CHECK for SSRC conflicts in ALL producers in the room
// //     const requestedSsrc = rtpParameters?.encodings?.[0]?.ssrc;
// //     if (requestedSsrc) {
// //       for (const [producerId, producer] of state.producers) {
// //         const producerSsrc = producer.rtpParameters?.encodings?.[0]?.ssrc;
// //         if (producerSsrc === requestedSsrc) {
// //           console.log(`⚠️ SSRC conflict detected: ${requestedSsrc} already used by producer ${producerId}`);
          
// //           // Generate a new random SSRC
// //           const newSsrc = Math.floor(Math.random() * 4294967295) + 1;
// //           rtpParameters.encodings[0].ssrc = newSsrc;
          
// //           // Also update RTX SSRC if present
// //           if (rtpParameters.encodings[0].rtx && rtpParameters.encodings[0].rtx.ssrc) {
// //             rtpParameters.encodings[0].rtx.ssrc = newSsrc + 1000000;
// //           }
          
// //           console.log(`✅ Generated new SSRC: ${newSsrc}`);
// //           break;
// //         }
// //       }
// //     }

// //     const transport = state.transports.get(transportId);
// //     if (!transport) return callback({ error: "Transport not found" });

// //     const producer = await transport.produce({
// //       kind,
// //       rtpParameters,
// //       appData: {
// //         socketId: socket.id,
// //         environment: process.env.NODE_ENV,
// //         source: 'viewer-screen',
// //         userId: meta.userId,
// //         timestamp: Date.now() // Add timestamp for tracking
// //       },
// //     });

// //     state.producers.set(producer.id, producer);

// //     // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
// //     if (state.streamerSocketId) {
// //       safeEmit(io, state.streamerSocketId, "new-viewer-screen-producer", {
// //         producerId: producer.id,
// //         kind: producer.kind,
// //         userId: meta.userId,
// //         userName: meta.userName || 'Viewer',
// //         source: 'viewer-screen',
// //         ssrc: rtpParameters.encodings[0]?.ssrc
// //       });
// //     }

// //     // Notify all participants about the new screen share producer
// //     io.to(sessionId).emit("new-producer", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: meta.userId,
// //       source: 'viewer-screen',
// //       ssrc: rtpParameters.encodings[0]?.ssrc
// //     });

// //     callback({ id: producer.id });

// //     producer.on("transportclose", () => {
// //       console.log("Viewer screen share producer transport closed:", producer.id);
// //       try {
// //         producer.close();
// //       } catch (e) {
// //         // ignore
// //       }
// //       state.producers.delete(producer.id);
// //     });

// //     producer.on("trackended", () => {
// //       console.log("Viewer screen share track ended:", producer.id);
// //       handleViewerScreenShareStop(socket, io, sessionId, meta.userId);
// //     });

// //     producer.on("close", () => {
// //       console.log("Viewer screen share producer closed:", producer.id);
// //       state.producers.delete(producer.id);
// //     });

// //   } catch (error) {
// //     console.error("Viewer screen share start error:", error);
    
// //     // Handle specific mediasoup errors
// //     if (error.message.includes("ssrc already exists")) {
// //       // Try with new SSRC
// //       if (rtpParameters?.encodings?.[0]) {
// //         const newSsrc = Math.floor(Math.random() * 4294967295) + 1;
// //         rtpParameters.encodings[0].ssrc = newSsrc;
        
// //         // Retry with new SSRC
// //         setTimeout(() => {
// //           socket.emit("retry-screen-share", { 
// //             transportId, 
// //             rtpParameters,
// //             reason: "ssrc_conflict_resolved"
// //           });
// //         }, 100);
// //       }
// //     }
    
// //     callback({ error: error.message });
// //   }
// // };

// // const handleViewerScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
// //   try {
// //     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
// //     const state = roomState.get(sessionId);
// //     if (!state) return callback({ error: "Session not found" });

// //     const meta = state.sockets.get(socket.id);
// //     if (!meta) return callback({ error: "Unauthorized" });

// //     // ✅ Step 1: Pehle existing screen share ko check aur clean karo
// //     const existingScreenShareProducers = [];
// //     for (const [producerId, producer] of state.producers) {
// //       if (producer.appData?.userId === meta.userId && 
// //           (producer.appData?.source === 'viewer-screen' || 
// //            producer.appData?.source === 'viewer-screen-audio')) {
// //         existingScreenShareProducers.push({ producerId, producer });
// //       }
// //     }

// //     // ✅ Agar existing screen share hai to pehle usko stop karo
// //     if (existingScreenShareProducers.length > 0) {
// //       console.log(`⚠️ User ${meta.userId} already has an active screen share. Stopping it first...`);
      
// //       for (const { producerId, producer } of existingScreenShareProducers) {
// //         try {
// //           producer.close();
// //           console.log(`✅ Closed existing producer: ${producerId}`);
// //         } catch (e) {
// //           console.warn("Error closing existing producer:", e);
// //         }
// //         state.producers.delete(producerId);
        
// //         // Notify all participants including streamer
// //         io.to(sessionId).emit("producer-closed", {
// //           producerId: producerId,
// //           userId: meta.userId,
// //           source: producer.appData?.source,
// //           reason: "replaced_by_new_screen_share"
// //         });
// //       }
      
// //       // ✅ Update participant status temporarily
// //       const participant = state.participants.get(meta.userId);
// //       if (participant) {
// //         participant.isScreenSharing = false;
        
// //         // Brief update before new share starts
// //         io.to(sessionId).emit("participant_updated", {
// //           userId: meta.userId,
// //           updates: { isScreenSharing: false }
// //         });
// //       }
      
// //       // Small delay to ensure cleanup
// //       await new Promise(resolve => setTimeout(resolve, 100));
// //     }

// //     const transport = state.transports.get(transportId);
// //     if (!transport) return callback({ error: "Transport not found" });

// //     const producer = await transport.produce({
// //       kind,
// //       rtpParameters,
// //       appData: {
// //         socketId: socket.id,
// //         environment: process.env.NODE_ENV,
// //         source: 'viewer-screen',
// //         userId: meta.userId,
// //         timestamp: Date.now(),
// //         isNewShare: true // Flag for tracking
// //       },
// //     });

// //     state.producers.set(producer.id, producer);

// //     // ✅ Update participant status for new share
// //     const participant = state.participants.get(meta.userId);
// //     if (participant) {
// //       participant.isScreenSharing = true;
      
// //       io.to(sessionId).emit("participant_updated", {
// //         userId: meta.userId,
// //         updates: { isScreenSharing: true }
// //       });
      
// //       broadcastParticipantsList(io, sessionId);
// //     }

// //     // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
// //     if (state.streamerSocketId) {
// //       safeEmit(io, state.streamerSocketId, "new-viewer-screen-producer", {
// //         producerId: producer.id,
// //         kind: producer.kind,
// //         userId: meta.userId,
// //         userName: meta.userName || 'Viewer',
// //         source: 'viewer-screen',
// //         replacesExisting: existingScreenShareProducers.length > 0
// //       });
// //     }

// //     // Notify all participants about the new screen share producer
// //     io.to(sessionId).emit("new-producer", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: meta.userId,
// //       source: 'viewer-screen',
// //       replacesExisting: existingScreenShareProducers.length > 0
// //     });

// //     callback({ id: producer.id, replacedExisting: existingScreenShareProducers.length > 0 });

// //     producer.on("transportclose", () => {
// //       console.log("Viewer screen share producer transport closed:", producer.id);
// //       try {
// //         producer.close();
// //       } catch (e) {
// //         // ignore
// //       }
// //       state.producers.delete(producer.id);
// //     });

// //     producer.on("trackended", () => {
// //       console.log("Viewer screen share track ended:", producer.id);
// //       handleViewerScreenShareStop(socket, io, sessionId, meta.userId);
// //     });

// //     producer.on("close", () => {
// //       console.log("Viewer screen share producer closed:", producer.id);
// //       state.producers.delete(producer.id);
// //     });

// //   } catch (error) {
// //     console.error("Viewer screen share start error:", error);
// //     callback({ error: error.message });
// //   }
// // };

// const handleStreamerConsumeViewerScreen = async (socket, io, sessionId, producerId) => {
//   try {
//     console.log("Streamer consuming viewer screen:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return;

//     const producer = state.producers.get(producerId);
//     if (!producer) return;

//     // Create a consumer for the streamer
//     createConsumer(socket, io, sessionId, producerId, producer.kind);
//   } catch (error) {
//     console.error("Streamer consume viewer screen error:", error);
//   }
// };

// // const handleViewerScreenShareAudio = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
// //   try {
// //     console.log("Viewer screen share audio for transport:", transportId);
// //     const state = roomState.get(sessionId);
// //     if (!state) return callback({ error: "Session not found" });

// //     const meta = state.sockets.get(socket.id);
// //     if (!meta) return callback({ error: "Unauthorized" });

// //     const transport = state.transports.get(transportId);
// //     if (!transport) return callback({ error: "Transport not found" });

// //     const producer = await transport.produce({
// //       kind: "audio",
// //       rtpParameters,
// //       appData: {
// //         socketId: socket.id,
// //         environment: process.env.NODE_ENV,
// //         source: 'viewer-screen-audio',
// //         userId: meta.userId
// //       },
// //     });

// //     state.producers.set(producer.id, producer);

// //     // Notify all participants about the new screen share audio producer
// //     io.to(sessionId).emit("new-producer", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: meta.userId,
// //       source: 'viewer-screen-audio'
// //     });

// //     callback({ id: producer.id });

// //     producer.on("transportclose", () => {
// //       console.log("Viewer screen share audio producer transport closed:", producer.id);
// //       try {
// //         producer.close();
// //       } catch (e) {
// //         // ignore
// //       }
// //       state.producers.delete(producer.id);
// //     });

// //   } catch (error) {
// //     console.error("Viewer screen share audio error:", error);
// //     callback({ error: error.message });
// //   }
// // };

// const handleViewerScreenShareAudio = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share audio for transport:", transportId);
//     console.log("Socket ID:", socket.id);
//     console.log("Session ID:", sessionId);
//     console.log("RTP Parameters received:", rtpParameters ? "Yes" : "No");
    
//     const state = roomState.get(sessionId);
//     if (!state) {
//       console.error("❌ Session not found for ID:", sessionId);
//       return callback({ error: "Session not found" });
//     }
    
//     console.log("✅ Session found. Room state:", {
//       hasSockets: state.sockets.size,
//       hasTransports: state.transports.size,
//       hasProducers: state.producers.size
//     });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.error("❌ Socket metadata not found for socket ID:", socket.id);
//       return callback({ error: "Unauthorized" });
//     }
    
//     console.log("✅ User metadata found:", {
//       userId: meta.userId,
//       userType: meta.userType || 'unknown'
//     });

//     const transport = state.transports.get(transportId);
//     if (!transport) {
//       console.error("❌ Transport not found for ID:", transportId);
//       console.log("Available transports:", Array.from(state.transports.keys()));
//       return callback({ error: "Transport not found" });
//     }
    
//     console.log("✅ Transport found. Attempting to produce audio...");
//     console.log("Audio codec info:", rtpParameters?.codecs?.[0]?.mimeType || "Unknown");

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

//     console.log("🎉✅ Viewer screen share audio producer created successfully!");
//     console.log("Producer details:", {
//       id: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen-audio',
//       codec: producer.rtpParameters?.codecs?.[0]?.mimeType || "Unknown"
//     });

//     state.producers.set(producer.id, producer);
//     console.log(`📊 Total producers in room: ${state.producers.size}`);

//     // Notify all participants about the new screen share audio producer
//     console.log(`📢 Broadcasting 'new-producer' event to session: ${sessionId}`);
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen-audio'
//     });

//     callback({ id: producer.id });
//     console.log("✅ Callback sent with producer ID:", producer.id);

//     producer.on("transportclose", () => {
//       console.log("⚠️ Viewer screen share audio producer transport closed:", producer.id);
//       console.log("User ID:", meta.userId, "Socket ID:", socket.id);
//       try {
//         producer.close();
//         console.log("✅ Producer closed successfully");
//       } catch (e) {
//         console.error("❌ Error closing producer:", e.message);
//       }
//       state.producers.delete(producer.id);
//       console.log(`📊 Remaining producers: ${state.producers.size}`);
//     });

//     // Optional: Add listener for producer close event
//     producer.on("close", () => {
//       console.log("🔴 Viewer screen share audio producer closed:", producer.id);
//     });

//     // Optional: Add listener for track ended
//     producer.on("trackended", () => {
//       console.log("🔇 Viewer screen share audio track ended:", producer.id);
//     });

//   } catch (error) {
//     console.error("❌ Viewer screen share audio error:", error);
//     console.error("Error stack:", error.stack);
//     console.error("Error details:", {
//       sessionId,
//       transportId,
//       socketId: socket.id,
//       errorName: error.name,
//       errorMessage: error.message
//     });
//     callback({ error: error.message });
//   }
// };


// const handleViewerScreenShareStop = async (socket, io, sessionId, userId = null) => {
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
//       broadcastParticipantsList(io, sessionId);
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

// const handleStreamerStopScreenShare = async (socket, io, sessionId, targetUserId) => {
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

//       broadcastParticipantsList(io, sessionId);
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
//       safeEmit(io, viewerSocket, "screen-share-force-stop", {
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

// const handleScreenShareStoppedByViewer = async (socket, io, data) => {
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
//       broadcastParticipantsList(io, sessionId);
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

// const handleStreamerScreenShareStop = async (socket, io, sessionId) => {
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
//       broadcastParticipantsList(io, sessionId);
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

// // Helper function for consumer creation
// const createConsumer = async (socket, io, sessionId, producerId, kind) => {
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
//         consumerId: consumer.id,
//         producerId: producer.producerId,
//         userId: producer.appData?.userId,
//         source: producer.appData?.source
//       });
//       state.consumers.delete(consumer.id);
//     });

//   } catch (error) {
//     console.error("createConsumer error:", error);
//   }
// };

// export { createConsumer };
























// // services/socketHandlers/screenShare.handlers.js
// import { roomState } from "../socketState/roomState.js";
// import authenticationModel from "../../model/Authentication/authentication.model.js";
// import { safeEmit, broadcastParticipantsList } from "../socketUtils/general.utils.js";

// export const screenShareHandlers = (socket, io) => {
//   socket.on("screen-share-request", (data) => 
//     handleScreenShareRequest(socket, io, data.sessionId)
//   );
  
//   socket.on("screen-share-response", (data) => 
//     handleScreenShareResponse(socket, io, data.sessionId, data.requesterUserId, data.allow)
//   );
  
//   socket.on("transport-produce-screen", (data, cb) =>
//     handleScreenShareStart(socket, io, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//   );
  
//   socket.on("transport-produce-viewer-screen", (data, cb) =>
//     handleViewerScreenShareStart(socket, io, data.sessionId, data.transportId, data.kind, data.rtpParameters, cb)
//   );
  
//   socket.on("screen-share-stop", (data) => 
//     handleViewerScreenShareStop(socket, io, data.sessionId)
//   );
  
//   socket.on("screen-share-force-stop", (data) => 
//     handleStreamerStopScreenShare(socket, io, data.sessionId, data.targetUserId)
//   );
  
//   socket.on("streamer-consume-viewer-screen", (data) => 
//     handleStreamerConsumeViewerScreen(socket, io, data.sessionId, data.producerId)
//   );
  
//   socket.on("transport-produce-viewer-screen-audio", (data, cb) =>
//     handleViewerScreenShareAudio(socket, io, data.sessionId, data.transportId, data.rtpParameters, cb)
//   );
  
//   socket.on("screen-share-stopped-by-viewer", (data) => 
//     handleScreenShareStoppedByViewer(socket, io, data)
//   );
  
//   socket.on("streamer-screen-share-stop", (data) => 
//     handleStreamerScreenShareStop(socket, io, data.sessionId)
//   );
// };

// const handleScreenShareRequest = async (socket, io, sessionId) => {
//   try {
//     console.log("Screen share request from:", socket.id);
//     const state = roomState.get(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     // ✅ REMOVED: Permission check - directly allow
//     // if (state.activeScreenShares.has(meta.userId)) {
//     //   socket.emit("screen-share-error", { message: "You already have an active screen share" });
//     //   return;
//     // }

//     // ✅ Directly add to active screen shares
//     state.activeScreenShares.set(meta.userId, {
//       userId: meta.userId,
//       socketId: socket.id,
//       userName: meta.userName || "Viewer",
//       startedAt: new Date(),
//     });

//     // ✅ Update participant status
//     const participant = state.participants.get(meta.userId);
//     if (participant) {
//       participant.isScreenSharing = true;

//       io.to(sessionId).emit("participant_updated", {
//         userId: meta.userId,
//         updates: { isScreenSharing: true },
//       });

//       broadcastParticipantsList(io, sessionId);
//     }

//     // ✅ Notify all participants
//     io.to(sessionId).emit("screen-share-started-by-viewer", {
//       userId: meta.userId,
//       userName: meta.userName || "Viewer",
//       socketId: socket.id,
//     });

//     console.log(`✅ Viewer ${meta.userId} started screen share directly`);
    
//   } catch (error) {
//     console.error("Screen share request error:", error);
//     socket.emit("screen-share-error", { message: "Failed to start screen share" });
//   }
// };

// const handleScreenShareResponse = async (socket, io, sessionId, requesterIdentifier, allow) => {
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

//     // 🔴 Old event (direct response to requester)
//     safeEmit(io, request.socketId, "screen-share-response", {
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
//         broadcastParticipantsList(io, sessionId);
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


// // const handleViewerScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
// //   try {
// //     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
// //     const state = roomState.get(sessionId);
// //     if (!state) return callback({ error: "Session not found" });

// //     const meta = state.sockets.get(socket.id);
// //     if (!meta) return callback({ error: "Unauthorized" });

// //     // if (!state.activeScreenShares.has(meta.userId)) {
// //     //   return callback({ error: "No screen share permission" });
// //     // }

// //     const transport = state.transports.get(transportId);
// //     if (!transport) return callback({ error: "Transport not found" });

// //     const producer = await transport.produce({
// //       kind,
// //       rtpParameters,
// //       appData: {
// //         socketId: socket.id,
// //         environment: process.env.NODE_ENV,
// //         source: 'viewer-screen',
// //         userId: meta.userId
// //       },
// //     });

// //     state.producers.set(producer.id, producer);

// //     // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
// //     if (state.streamerSocketId) {
// //       safeEmit(io, state.streamerSocketId, "new-viewer-screen-producer", {
// //         producerId: producer.id,
// //         kind: producer.kind,
// //         userId: meta.userId,
// //         userName: meta.userName || 'Viewer',
// //         source: 'viewer-screen'
// //       });
// //     }

// //     // Notify all participants about the new screen share producer
// //     io.to(sessionId).emit("new-producer", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: meta.userId,
// //       source: 'viewer-screen'
// //     });

// //     callback({ id: producer.id });

// //     producer.on("transportclose", () => {
// //       console.log("Viewer screen share producer transport closed:", producer.id);
// //       try {
// //         producer.close();
// //       } catch (e) {
// //         // ignore
// //       }
// //       state.producers.delete(producer.id);
// //     });

// //     producer.on("trackended", () => {
// //       console.log("Viewer screen share track ended:", producer.id);
// //       handleViewerScreenShareStop(socket, io, sessionId, meta.userId);
// //     });

// //   } catch (error) {
// //     console.error("Viewer screen share start error:", error);
// //     callback({ error: error.message });
// //   }
// // };






// // const handleScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
// //   try {
// //     console.log("Screen share start for transport:", transportId, "kind:", kind);
// //     const state = roomState.get(sessionId);
// //     if (!state) return callback({ error: "Session not found" });

// //     const transport = state.transports.get(transportId);
// //     if (!transport) return callback({ error: "Transport not found" });

// //     const producer = await transport.produce({
// //       kind,
// //       rtpParameters,
// //       appData: {
// //         socketId: socket.id,
// //         environment: process.env.NODE_ENV,
// //         source: 'screen',
// //         userId: socket.data.userId 
// //       },
// //     });

// //     state.producers.set(producer.id, producer);

// //     producer.on("transportclose", () => {
// //       console.log("Screen share producer transport closed:", producer.id);
// //       try {
// //         producer.close();
// //       } catch (e) {
// //         // ignore
// //       }
// //       state.producers.delete(producer.id);
// //     });

// //     callback({ id: producer.id });

// //     socket.to(sessionId).emit("screen-share-started", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: socket.data.userId,
// //       source: 'screen'
// //     });
    
// //     socket.to(sessionId).emit("new-producer", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: socket.data.userId,
// //       source: 'screen'
// //     });
// //   } catch (error) {
// //     console.error("Screen share start error:", error);
// //     callback({ error: error.message });
// //   }
// // };



// // const handleViewerScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
// //   try {
// //     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
// //     const state = roomState.get(sessionId);
// //     if (!state) return callback({ error: "Session not found" });

// //     const meta = state.sockets.get(socket.id);
// //     if (!meta) return callback({ error: "Unauthorized" });

// //     // ✅ CHECK for existing screen share producers for this user
// //     const existingProducers = [];
// //     for (const [producerId, producer] of state.producers) {
// //       if (producer.appData?.userId === meta.userId && 
// //           (producer.appData?.source === 'viewer-screen' || 
// //            producer.appData?.source === 'viewer-screen-audio')) {
// //         existingProducers.push(producerId);
// //       }
// //     }

// //     // ✅ If user already has screen share active, clean it up first
// //     if (existingProducers.length > 0) {
// //       console.log(`⚠️ User ${meta.userId} has existing screen share producers, cleaning up...`);
// //       for (const producerId of existingProducers) {
// //         const producer = state.producers.get(producerId);
// //         if (producer) {
// //           try {
// //             producer.close();
// //           } catch (e) {
// //             console.warn("Error closing existing producer:", e);
// //           }
// //           state.producers.delete(producerId);
// //         }
// //       }
// //     }

// //     // ✅ CHECK for SSRC conflicts in ALL producers in the room
// //     const requestedSsrc = rtpParameters?.encodings?.[0]?.ssrc;
// //     if (requestedSsrc) {
// //       for (const [producerId, producer] of state.producers) {
// //         const producerSsrc = producer.rtpParameters?.encodings?.[0]?.ssrc;
// //         if (producerSsrc === requestedSsrc) {
// //           console.log(`⚠️ SSRC conflict detected: ${requestedSsrc} already used by producer ${producerId}`);
          
// //           // Generate a new random SSRC
// //           const newSsrc = Math.floor(Math.random() * 4294967295) + 1;
// //           rtpParameters.encodings[0].ssrc = newSsrc;
          
// //           // Also update RTX SSRC if present
// //           if (rtpParameters.encodings[0].rtx && rtpParameters.encodings[0].rtx.ssrc) {
// //             rtpParameters.encodings[0].rtx.ssrc = newSsrc + 1000000;
// //           }
          
// //           console.log(`✅ Generated new SSRC: ${newSsrc}`);
// //           break;
// //         }
// //       }
// //     }

// //     const transport = state.transports.get(transportId);
// //     if (!transport) return callback({ error: "Transport not found" });

// //     const producer = await transport.produce({
// //       kind,
// //       rtpParameters,
// //       appData: {
// //         socketId: socket.id,
// //         environment: process.env.NODE_ENV,
// //         source: 'viewer-screen',
// //         userId: meta.userId,
// //         timestamp: Date.now() // Add timestamp for tracking
// //       },
// //     });

// //     state.producers.set(producer.id, producer);

// //     // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
// //     if (state.streamerSocketId) {
// //       safeEmit(io, state.streamerSocketId, "new-viewer-screen-producer", {
// //         producerId: producer.id,
// //         kind: producer.kind,
// //         userId: meta.userId,
// //         userName: meta.userName || 'Viewer',
// //         source: 'viewer-screen',
// //         ssrc: rtpParameters.encodings[0]?.ssrc
// //       });
// //     }

// //     // Notify all participants about the new screen share producer
// //     io.to(sessionId).emit("new-producer", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: meta.userId,
// //       source: 'viewer-screen',
// //       ssrc: rtpParameters.encodings[0]?.ssrc
// //     });

// //     callback({ id: producer.id });

// //     producer.on("transportclose", () => {
// //       console.log("Viewer screen share producer transport closed:", producer.id);
// //       try {
// //         producer.close();
// //       } catch (e) {
// //         // ignore
// //       }
// //       state.producers.delete(producer.id);
// //     });

// //     producer.on("trackended", () => {
// //       console.log("Viewer screen share track ended:", producer.id);
// //       handleViewerScreenShareStop(socket, io, sessionId, meta.userId);
// //     });

// //     producer.on("close", () => {
// //       console.log("Viewer screen share producer closed:", producer.id);
// //       state.producers.delete(producer.id);
// //     });

// //   } catch (error) {
// //     console.error("Viewer screen share start error:", error);
    
// //     // Handle specific mediasoup errors
// //     if (error.message.includes("ssrc already exists")) {
// //       // Try with new SSRC
// //       if (rtpParameters?.encodings?.[0]) {
// //         const newSsrc = Math.floor(Math.random() * 4294967295) + 1;
// //         rtpParameters.encodings[0].ssrc = newSsrc;
        
// //         // Retry with new SSRC
// //         setTimeout(() => {
// //           socket.emit("retry-screen-share", { 
// //             transportId, 
// //             rtpParameters,
// //             reason: "ssrc_conflict_resolved"
// //           });
// //         }, 100);
// //       }
// //     }
    
// //     callback({ error: error.message });
// //   }
// // };

// // const handleViewerScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
// //   try {
// //     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
// //     const state = roomState.get(sessionId);
// //     if (!state) return callback({ error: "Session not found" });

// //     const meta = state.sockets.get(socket.id);
// //     if (!meta) return callback({ error: "Unauthorized" });

// //     // ✅ Step 1: Pehle existing screen share ko check aur clean karo
// //     const existingScreenShareProducers = [];
// //     for (const [producerId, producer] of state.producers) {
// //       if (producer.appData?.userId === meta.userId && 
// //           (producer.appData?.source === 'viewer-screen' || 
// //            producer.appData?.source === 'viewer-screen-audio')) {
// //         existingScreenShareProducers.push({ producerId, producer });
// //       }
// //     }

// //     // ✅ Agar existing screen share hai to pehle usko stop karo
// //     if (existingScreenShareProducers.length > 0) {
// //       console.log(`⚠️ User ${meta.userId} already has an active screen share. Stopping it first...`);
      
// //       for (const { producerId, producer } of existingScreenShareProducers) {
// //         try {
// //           producer.close();
// //           console.log(`✅ Closed existing producer: ${producerId}`);
// //         } catch (e) {
// //           console.warn("Error closing existing producer:", e);
// //         }
// //         state.producers.delete(producerId);
        
// //         // Notify all participants including streamer
// //         io.to(sessionId).emit("producer-closed", {
// //           producerId: producerId,
// //           userId: meta.userId,
// //           source: producer.appData?.source,
// //           reason: "replaced_by_new_screen_share"
// //         });
// //       }
      
// //       // ✅ Update participant status temporarily
// //       const participant = state.participants.get(meta.userId);
// //       if (participant) {
// //         participant.isScreenSharing = false;
        
// //         // Brief update before new share starts
// //         io.to(sessionId).emit("participant_updated", {
// //           userId: meta.userId,
// //           updates: { isScreenSharing: false }
// //         });
// //       }
      
// //       // Small delay to ensure cleanup
// //       await new Promise(resolve => setTimeout(resolve, 100));
// //     }

// //     const transport = state.transports.get(transportId);
// //     if (!transport) return callback({ error: "Transport not found" });

// //     const producer = await transport.produce({
// //       kind,
// //       rtpParameters,
// //       appData: {
// //         socketId: socket.id,
// //         environment: process.env.NODE_ENV,
// //         source: 'viewer-screen',
// //         userId: meta.userId,
// //         timestamp: Date.now(),
// //         isNewShare: true // Flag for tracking
// //       },
// //     });

// //     state.producers.set(producer.id, producer);

// //     // ✅ Update participant status for new share
// //     const participant = state.participants.get(meta.userId);
// //     if (participant) {
// //       participant.isScreenSharing = true;
      
// //       io.to(sessionId).emit("participant_updated", {
// //         userId: meta.userId,
// //         updates: { isScreenSharing: true }
// //       });
      
// //       broadcastParticipantsList(io, sessionId);
// //     }

// //     // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
// //     if (state.streamerSocketId) {
// //       safeEmit(io, state.streamerSocketId, "new-viewer-screen-producer", {
// //         producerId: producer.id,
// //         kind: producer.kind,
// //         userId: meta.userId,
// //         userName: meta.userName || 'Viewer',
// //         source: 'viewer-screen',
// //         replacesExisting: existingScreenShareProducers.length > 0
// //       });
// //     }

// //     // Notify all participants about the new screen share producer
// //     io.to(sessionId).emit("new-producer", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: meta.userId,
// //       source: 'viewer-screen',
// //       replacesExisting: existingScreenShareProducers.length > 0
// //     });

// //     callback({ id: producer.id, replacedExisting: existingScreenShareProducers.length > 0 });

// //     producer.on("transportclose", () => {
// //       console.log("Viewer screen share producer transport closed:", producer.id);
// //       try {
// //         producer.close();
// //       } catch (e) {
// //         // ignore
// //       }
// //       state.producers.delete(producer.id);
// //     });

// //     producer.on("trackended", () => {
// //       console.log("Viewer screen share track ended:", producer.id);
// //       handleViewerScreenShareStop(socket, io, sessionId, meta.userId);
// //     });

// //     producer.on("close", () => {
// //       console.log("Viewer screen share producer closed:", producer.id);
// //       state.producers.delete(producer.id);
// //     });

// //   } catch (error) {
// //     console.error("Viewer screen share start error:", error);
// //     callback({ error: error.message });
// //   }
// // };

// const handleViewerScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share start for transport:", transportId, "kind:", kind);
//     const state = roomState.get(sessionId);
//     if (!state) return callback({ error: "Session not found" });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return callback({ error: "Unauthorized" });

//     // ✅ STEP 1: Check and resolve SSRC conflicts
//     const requestedSsrc = rtpParameters?.encodings?.[0]?.ssrc;
//     if (requestedSsrc) {
//       console.log(`🔍 Checking SSRC ${requestedSsrc} for conflicts...`);
      
//       // Check all existing producers for SSRC conflicts
//       let ssrcConflict = false;
//       for (const [producerId, existingProducer] of state.producers) {
//         const existingSsrc = existingProducer.rtpParameters?.encodings?.[0]?.ssrc;
//         if (existingSsrc === requestedSsrc) {
//           console.log(`⚠️ SSRC conflict detected: ${requestedSsrc} already used by producer ${producerId}`);
//           ssrcConflict = true;
//           break;
//         }
//       }
      
//       // If conflict found, generate a new unique SSRC
//       if (ssrcConflict) {
//         // Generate random SSRC in valid range (1 to 2^32-1)
//         const newSsrc = Math.floor(Math.random() * 4294967295) + 1;
//         console.log(`🔄 Generating new SSRC: ${newSsrc} (was ${requestedSsrc})`);
        
//         // Update the SSRC in encodings
//         rtpParameters.encodings[0].ssrc = newSsrc;
        
//         // Also update RTX SSRC if present
//         if (rtpParameters.encodings[0].rtx && rtpParameters.encodings[0].rtx.ssrc) {
//           rtpParameters.encodings[0].rtx.ssrc = newSsrc + 1000000;
//         }
//       }
//     }

//     // ✅ STEP 2: Clean up existing screen share producers for this user
//     const existingProducersToClose = [];
//     for (const [producerId, producer] of state.producers) {
//       if (producer.appData?.userId === meta.userId && 
//           (producer.appData?.source === 'viewer-screen' || 
//            producer.appData?.source === 'viewer-screen-audio')) {
//         existingProducersToClose.push({ producerId, producer });
//       }
//     }

//     // Close existing screen share producers
//     for (const { producerId, producer } of existingProducersToClose) {
//       try {
//         producer.close();
//         console.log(`✅ Closed existing screen share producer: ${producerId}`);
//       } catch (e) {
//         console.warn("Error closing existing producer:", e);
//       }
//       state.producers.delete(producerId);
//     }

//     const transport = state.transports.get(transportId);
//     if (!transport) return callback({ error: "Transport not found" });

//     // ✅ STEP 3: Create new producer with potentially updated SSRC
//     const producer = await transport.produce({
//       kind,
//       rtpParameters,
//       appData: {
//         socketId: socket.id,
//         environment: process.env.NODE_ENV,
//         source: 'viewer-screen',
//         userId: meta.userId,
//         timestamp: Date.now(),
//         ssrc: rtpParameters.encodings?.[0]?.ssrc // Store the SSRC for debugging
//       },
//     });

//     state.producers.set(producer.id, producer);
//     console.log(`✅ Created new screen share producer: ${producer.id} with SSRC: ${rtpParameters.encodings?.[0]?.ssrc}`);

//     // SPECIFICALLY NOTIFY THE STREAMER about the new screen share
//     if (state.streamerSocketId) {
//       safeEmit(io, state.streamerSocketId, "new-viewer-screen-producer", {
//         producerId: producer.id,
//         kind: producer.kind,
//         userId: meta.userId,
//         userName: meta.userName || 'Viewer',
//         source: 'viewer-screen',
//         ssrc: rtpParameters.encodings?.[0]?.ssrc
//       });
//     }

//     // Notify all participants about the new screen share producer
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen',
//       ssrc: rtpParameters.encodings?.[0]?.ssrc
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
//       handleViewerScreenShareStop(socket, io, sessionId, meta.userId);
//     });

//     producer.on("close", () => {
//       console.log("Viewer screen share producer closed:", producer.id);
//       state.producers.delete(producer.id);
//     });

//   } catch (error) {
//     console.error("❌ Viewer screen share start error:", error);
    
//     // Handle SSRC conflict error specifically
//     if (error.message.includes("ssrc already exists")) {
//       console.log("🔄 SSRC conflict detected, retrying with new SSRC...");
      
//       // If error still occurs, generate a completely new SSRC and retry
//       if (rtpParameters?.encodings?.[0]) {
//         const newSsrc = Math.floor(Math.random() * 4294967295) + 1;
//         rtpParameters.encodings[0].ssrc = newSsrc;
        
//         // Update RTX SSRC if present
//         if (rtpParameters.encodings[0].rtx && rtpParameters.encodings[0].rtx.ssrc) {
//           rtpParameters.encodings[0].rtx.ssrc = newSsrc + 1000000;
//         }
        
//         // Notify client to retry
//         socket.emit("screen-share-retry-request", {
//           transportId,
//           rtpParameters,
//           reason: "ssrc_conflict_retry"
//         });
//       }
//     }
    
//     callback({ error: error.message });
//   }
// };

// const handleStreamerConsumeViewerScreen = async (socket, io, sessionId, producerId) => {
//   try {
//     console.log("Streamer consuming viewer screen:", producerId);
//     const state = roomState.get(sessionId);
//     if (!state || !state.router) return;

//     const producer = state.producers.get(producerId);
//     if (!producer) return;

//     // Create a consumer for the streamer
//     createConsumer(socket, io, sessionId, producerId, producer.kind);
//   } catch (error) {
//     console.error("Streamer consume viewer screen error:", error);
//   }
// };

// // const handleViewerScreenShareAudio = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
// //   try {
// //     console.log("Viewer screen share audio for transport:", transportId);
// //     const state = roomState.get(sessionId);
// //     if (!state) return callback({ error: "Session not found" });

// //     const meta = state.sockets.get(socket.id);
// //     if (!meta) return callback({ error: "Unauthorized" });

// //     const transport = state.transports.get(transportId);
// //     if (!transport) return callback({ error: "Transport not found" });

// //     const producer = await transport.produce({
// //       kind: "audio",
// //       rtpParameters,
// //       appData: {
// //         socketId: socket.id,
// //         environment: process.env.NODE_ENV,
// //         source: 'viewer-screen-audio',
// //         userId: meta.userId
// //       },
// //     });

// //     state.producers.set(producer.id, producer);

// //     // Notify all participants about the new screen share audio producer
// //     io.to(sessionId).emit("new-producer", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: meta.userId,
// //       source: 'viewer-screen-audio'
// //     });

// //     callback({ id: producer.id });

// //     producer.on("transportclose", () => {
// //       console.log("Viewer screen share audio producer transport closed:", producer.id);
// //       try {
// //         producer.close();
// //       } catch (e) {
// //         // ignore
// //       }
// //       state.producers.delete(producer.id);
// //     });

// //   } catch (error) {
// //     console.error("Viewer screen share audio error:", error);
// //     callback({ error: error.message });
// //   }
// // };

// // const handleViewerScreenShareAudio = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
// //   try {
// //     console.log("Viewer screen share audio for transport:", transportId);
// //     console.log("Socket ID:", socket.id);
// //     console.log("Session ID:", sessionId);
// //     console.log("RTP Parameters received:", rtpParameters ? "Yes" : "No");
    
// //     const state = roomState.get(sessionId);
// //     if (!state) {
// //       console.error("❌ Session not found for ID:", sessionId);
// //       return callback({ error: "Session not found" });
// //     }
    
// //     console.log("✅ Session found. Room state:", {
// //       hasSockets: state.sockets.size,
// //       hasTransports: state.transports.size,
// //       hasProducers: state.producers.size
// //     });

// //     const meta = state.sockets.get(socket.id);
// //     if (!meta) {
// //       console.error("❌ Socket metadata not found for socket ID:", socket.id);
// //       return callback({ error: "Unauthorized" });
// //     }
    
// //     console.log("✅ User metadata found:", {
// //       userId: meta.userId,
// //       userType: meta.userType || 'unknown'
// //     });

// //     const transport = state.transports.get(transportId);
// //     if (!transport) {
// //       console.error("❌ Transport not found for ID:", transportId);
// //       console.log("Available transports:", Array.from(state.transports.keys()));
// //       return callback({ error: "Transport not found" });
// //     }
    
// //     console.log("✅ Transport found. Attempting to produce audio...");
// //     console.log("Audio codec info:", rtpParameters?.codecs?.[0]?.mimeType || "Unknown");

// //     const producer = await transport.produce({
// //       kind: "audio",
// //       rtpParameters,
// //       appData: {
// //         socketId: socket.id,
// //         environment: process.env.NODE_ENV,
// //         source: 'viewer-screen-audio',
// //         userId: meta.userId
// //       },
// //     });

// //     console.log("🎉✅ Viewer screen share audio producer created successfully!");
// //     console.log("Producer details:", {
// //       id: producer.id,
// //       kind: producer.kind,
// //       userId: meta.userId,
// //       source: 'viewer-screen-audio',
// //       codec: producer.rtpParameters?.codecs?.[0]?.mimeType || "Unknown"
// //     });

// //     state.producers.set(producer.id, producer);
// //     console.log(`📊 Total producers in room: ${state.producers.size}`);

// //     // Notify all participants about the new screen share audio producer
// //     console.log(`📢 Broadcasting 'new-producer' event to session: ${sessionId}`);
// //     io.to(sessionId).emit("new-producer", {
// //       producerId: producer.id,
// //       kind: producer.kind,
// //       userId: meta.userId,
// //       source: 'viewer-screen-audio'
// //     });

// //     callback({ id: producer.id });
// //     console.log("✅ Callback sent with producer ID:", producer.id);

// //     producer.on("transportclose", () => {
// //       console.log("⚠️ Viewer screen share audio producer transport closed:", producer.id);
// //       console.log("User ID:", meta.userId, "Socket ID:", socket.id);
// //       try {
// //         producer.close();
// //         console.log("✅ Producer closed successfully");
// //       } catch (e) {
// //         console.error("❌ Error closing producer:", e.message);
// //       }
// //       state.producers.delete(producer.id);
// //       console.log(`📊 Remaining producers: ${state.producers.size}`);
// //     });

// //     // Optional: Add listener for producer close event
// //     producer.on("close", () => {
// //       console.log("🔴 Viewer screen share audio producer closed:", producer.id);
// //     });

// //     // Optional: Add listener for track ended
// //     producer.on("trackended", () => {
// //       console.log("🔇 Viewer screen share audio track ended:", producer.id);
// //     });

// //   } catch (error) {
// //     console.error("❌ Viewer screen share audio error:", error);
// //     console.error("Error stack:", error.stack);
// //     console.error("Error details:", {
// //       sessionId,
// //       transportId,
// //       socketId: socket.id,
// //       errorName: error.name,
// //       errorMessage: error.message
// //     });
// //     callback({ error: error.message });
// //   }
// // };

// const handleViewerScreenShareAudio = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
//   try {
//     console.log("Viewer screen share audio for transport:", transportId);
//     console.log("Socket ID:", socket.id);
//     console.log("Session ID:", sessionId);
//     console.log("Callback type:", typeof callback);
    
//     // ✅ STEP 1: Check if callback is a function
//     if (typeof callback !== 'function') {
//       console.warn("⚠️ No callback provided or callback is not a function. Creating dummy callback.");
//       callback = (response) => {
//         if (response && response.error) {
//           console.error("Dummy callback error:", response.error);
//         } else {
//           console.log("✅ Screen share audio processed successfully via dummy callback");
//         }
//       };
//     }

//     const state = roomState.get(sessionId);
//     if (!state) {
//       console.error("❌ Session not found for ID:", sessionId);
      
//       // ✅ Safer way to send error response
//       if (typeof callback === 'function') {
//         return callback({ error: "Session not found" });
//       } else {
//         // Agar callback nahi hai, toh socket se emit karo
//         socket.emit("screen-share-audio-error", { error: "Session not found" });
//         return;
//       }
//     }
    
//     console.log("✅ Session found. Room state:", {
//       hasSockets: state.sockets.size,
//       hasTransports: state.transports.size,
//       hasProducers: state.producers.size
//     });

//     const meta = state.sockets.get(socket.id);
//     if (!meta) {
//       console.error("❌ Socket metadata not found for socket ID:", socket.id);
      
//       if (typeof callback === 'function') {
//         return callback({ error: "Unauthorized" });
//       } else {
//         socket.emit("screen-share-audio-error", { error: "Unauthorized" });
//         return;
//       }
//     }
    
//     console.log("✅ User metadata found:", {
//       userId: meta.userId,
//       userType: meta.userType || 'unknown'
//     });

//     const transport = state.transports.get(transportId);
//     if (!transport) {
//       console.error("❌ Transport not found for ID:", transportId);
//       console.log("Available transports:", Array.from(state.transports.keys()));
      
//       if (typeof callback === 'function') {
//         return callback({ error: "Transport not found" });
//       } else {
//         socket.emit("screen-share-audio-error", { error: "Transport not found" });
//         return;
//       }
//     }
    
//     console.log("✅ Transport found. Attempting to produce audio...");
//     console.log("Audio codec info:", rtpParameters?.codecs?.[0]?.mimeType || "Unknown");

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

//     console.log("🎉✅ Viewer screen share audio producer created successfully!");
//     console.log("Producer details:", {
//       id: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen-audio',
//       codec: producer.rtpParameters?.codecs?.[0]?.mimeType || "Unknown"
//     });

//     state.producers.set(producer.id, producer);
//     console.log(`📊 Total producers in room: ${state.producers.size}`);

//     // Notify all participants about the new screen share audio producer
//     console.log(`📢 Broadcasting 'new-producer' event to session: ${sessionId}`);
//     io.to(sessionId).emit("new-producer", {
//       producerId: producer.id,
//       kind: producer.kind,
//       userId: meta.userId,
//       source: 'viewer-screen-audio'
//     });

//     // ✅ Check callback existence before calling
//     if (typeof callback === 'function') {
//       callback({ id: producer.id });
//       console.log("✅ Callback sent with producer ID:", producer.id);
//     } else {
//       console.log("ℹ️ No callback to respond to, but producer created successfully");
//       socket.emit("screen-share-audio-created", { id: producer.id });
//     }

//     producer.on("transportclose", () => {
//       console.log("⚠️ Viewer screen share audio producer transport closed:", producer.id);
//       console.log("User ID:", meta.userId, "Socket ID:", socket.id);
//       try {
//         producer.close();
//         console.log("✅ Producer closed successfully");
//       } catch (e) {
//         console.error("❌ Error closing producer:", e.message);
//       }
//       state.producers.delete(producer.id);
//       console.log(`📊 Remaining producers: ${state.producers.size}`);
//     });

//     // Optional: Add listener for producer close event
//     producer.on("close", () => {
//       console.log("🔴 Viewer screen share audio producer closed:", producer.id);
//     });

//     // Optional: Add listener for track ended
//     producer.on("trackended", () => {
//       console.log("🔇 Viewer screen share audio track ended:", producer.id);
//     });

//   } catch (error) {
//     console.error("❌ Viewer screen share audio error:", error);
//     console.error("Error stack:", error.stack);
//     console.error("Error details:", {
//       sessionId,
//       transportId,
//       socketId: socket.id,
//       errorName: error.name,
//       errorMessage: error.message
//     });
    
//     // ✅ Safe error response
//     if (typeof callback === 'function') {
//       callback({ error: error.message });
//     } else {
//       socket.emit("screen-share-audio-error", { 
//         error: error.message,
//         sessionId,
//         transportId 
//       });
//     }
//   }
// };
// const handleViewerScreenShareStop = async (socket, io, sessionId, userId = null) => {
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
//       broadcastParticipantsList(io, sessionId);
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

// const handleStreamerStopScreenShare = async (socket, io, sessionId, targetUserId) => {
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

//       broadcastParticipantsList(io, sessionId);
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
//       safeEmit(io, viewerSocket, "screen-share-force-stop", {
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

// const handleScreenShareStoppedByViewer = async (socket, io, data) => {
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
//       broadcastParticipantsList(io, sessionId);
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

// const handleStreamerScreenShareStop = async (socket, io, sessionId) => {
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
//       broadcastParticipantsList(io, sessionId);
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

// // Helper function for consumer creation
// const createConsumer = async (socket, io, sessionId, producerId, kind) => {
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
//         consumerId: consumer.id,
//         producerId: producer.producerId,
//         userId: producer.appData?.userId,
//         source: producer.appData?.source
//       });
//       state.consumers.delete(consumer.id);
//     });

//   } catch (error) {
//     console.error("createConsumer error:", error);
//   }
// };

// export { createConsumer };