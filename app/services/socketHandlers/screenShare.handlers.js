// services/socketHandlers/screenShare.handlers.js
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
    handleViewerScreenShareStop(socket, io, data.sessionId)
  );
  
  socket.on("screen-share-force-stop", (data) => 
    handleStreamerStopScreenShare(socket, io, data.sessionId, data.targetUserId)
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

    safeEmit(io, state.streamerSocketId, "screen-share-request", {
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

const handleViewerScreenShareStart = async (socket, io, sessionId, transportId, kind, rtpParameters, callback) => {
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

const handleViewerScreenShareAudio = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
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