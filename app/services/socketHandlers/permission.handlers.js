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

const handleViewerAudioProduce = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
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
        source: "viewer-mic",
        userId: socket.data.userId,
      },
    });

    state.producers.set(producer.id, producer);

    // 🔴 Old event: notify all participants about the new audio producer
    io.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: "viewer-mic",
    });

    // 🔴 Old event: audio permission granted
    io.to(sessionId).emit("viewer-audio-permission-granted", {
      userId: socket.data.userId,
      producerId: producer.id,
      socketId: socket.id,
      userName: state.sockets.get(socket.id)?.userName || "Viewer",
    });

    callback({ id: producer.id });

    // Participant update
    const meta = state.sockets.get(socket.id);
    if (meta) {
      const participant = state.participants.get(meta.userId);
      if (participant) {
        participant.hasAudio = true;

        // 🔴 Old event (keep for compatibility)
        io.to(sessionId).emit("participant_updated", {
          userId: meta.userId,
          updates: { hasAudio: true },
        });

        // 🟢 New event (full snapshot)
        broadcastParticipantsList(io, sessionId);
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

const handleViewerVideoProduce = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
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
        source: "viewer-camera",
        userId: socket.data.userId,
      },
    });

    state.producers.set(producer.id, producer);

    // 🔴 Old event: notify all participants about the new video producer
    io.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: "viewer-camera",
    });

    callback({ id: producer.id });

    // ✅ Update participant status
    const meta = state.sockets.get(socket.id);
    if (meta) {
      const participant = state.participants.get(meta.userId);
      if (participant) {
        participant.hasVideo = true;

        // 🔴 Old event (partial update — keep for compatibility)
        io.to(sessionId).emit("participant_updated", {
          userId: meta.userId,
          updates: { hasVideo: true },
        });

        // 🟢 New event (full snapshot)
        broadcastParticipantsList(io, sessionId);
      }
    }

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