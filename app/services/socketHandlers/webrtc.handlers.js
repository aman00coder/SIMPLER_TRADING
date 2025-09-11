import { safeEmit } from "../socketUtils/index.js";

export const getRouterRtpCapabilitiesHandler = async (socket, sessionId, callback, roomState) => {
  try {
    console.log("getRouterRtpCapabilities for session:", sessionId);
    const state = roomState.getRoom(sessionId);
    if (!state || !state.router) return callback({ error: "Router not found" });
    callback({ rtpCapabilities: state.router.rtpCapabilities });
  } catch (error) {
    console.error("getRouterRtpCapabilities error:", error);
    callback({ error: error.message });
  }
};

export const createWebRtcTransportHandler = async (socket, sessionId, callback, roomState) => {
  try {
    console.log("createWebRtcTransport for session:", sessionId);
    const state = roomState.getRoom(sessionId);
    if (!state || !state.router) return callback({ error: "Router not found" });

    const transport = await state.router.createWebRtcTransport({
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: process.env.SERVER_IP || "127.0.0.1",
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: process.env.NODE_ENV === "production" ? 500000 : 1000000,
    });

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") transport.close();
    });

    transport.appData = { socketId: socket.id };
    state.transports.set(transport.id, transport);

    callback({
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    });
  } catch (error) {
    console.error("createWebRtcTransport error:", error);
    callback({ error: error.message });
  }
};

export const transportConnectHandler = async (socket, sessionId, transportId, dtlsParameters, callback, roomState) => {
  try {
    console.log("transport-connect for transport:", transportId);
    const state = roomState.getRoom(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    await transport.connect({ dtlsParameters });
    callback({ success: true });
  } catch (error) {
    console.error("transport-connect error:", error);
    callback({ error: error.message });
  }
};

export const transportProduceHandler = async (socket, sessionId, transportId, kind, rtpParameters, appData, callback, roomState) => {
  try {
    console.log("transport-produce for transport:", transportId, "kind:", kind, "source:", appData?.source);
    const state = roomState.getRoom(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: {
        socketId: socket.id,
        environment: process.env.NODE_ENV,
        source: appData?.source || 'camera'
      },
    });

    state.producers.set(producer.id, producer);

    producer.on("transportclose", () => {
      console.log("Producer transport closed:", producer.id);
      try {
        producer.close();
      } catch (e) {
        // ignore
      }
      state.producers.delete(producer.id);
    });

    callback({ id: producer.id });

    socket.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: appData?.source || 'camera'
    });
  } catch (error) {
    console.error("transport-produce error:", error);
    callback({ error: error.message });
  }
};

export const handleScreenShareStart = async (socket, sessionId, transportId, kind, rtpParameters, callback, roomState) => {
  try {
    console.log("Screen share start for transport:", transportId, "kind:", kind);
    const state = roomState.getRoom(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: {
        socketId: socket.id,
        environment: process.env.NODE_ENV,
        source: 'screen'  // This identifies it as screen share
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

    // Emit a specific event for screen share
    socket.to(sessionId).emit("screen-share-started", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: 'screen'
    });
    
    // Also emit the regular new-producer event for compatibility
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

export const consumeHandler = async (socket, sessionId, transportId, producerId, rtpCapabilities, callback, roomState) => {
  try {
    console.log("consume for producer:", producerId, "transport:", transportId);
    const state = roomState.getRoom(sessionId);
    if (!state || !state.router) {
      console.log("❌ Router not found for session:", sessionId);
      return callback({ error: "Router not found" });
    }

    const producer = state.producers.get(producerId);
    if (!producer) {
      console.log("❌ Producer not found:", producerId);
      return callback({ error: "Producer not found" });
    }

    if (!state.router.canConsume({ producerId, rtpCapabilities })) {
      console.log("❌ Cannot consume - router.canConsume returned false");
      return callback({ error: "Cannot consume" });
    }

    const transport = state.transports.get(transportId);
    if (!transport) {
      console.log("❌ Transport not found:", transportId);
      return callback({ error: "Transport not found" });
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
      appData: {
        socketId: socket.id,
        environment: process.env.NODE_ENV,
      },
    });

    state.consumers.set(consumer.id, consumer);
    console.log("✅ Consumer created:", consumer.id);

    callback({
      params: {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      },
    });
  } catch (error) {
    console.error("consume error:", error);
    callback({ error: error.message });
  }
};

export const consumerResumeHandler = async (socket, sessionId, consumerId, callback, roomState) => {
  try {
    console.log("consumer-resume for consumer:", consumerId);
    const state = roomState.getRoom(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const consumer = state.consumers.get(consumerId);
    if (!consumer) return callback({ error: "Consumer not found" });

    await consumer.resume();
    callback({ success: true });
  } catch (error) {
    console.error("consumer-resume error:", error);
    callback({ error: error.message });
  }
};

export const getProducersHandler = async (socket, sessionId, callback, roomState) => {
  try {
    console.log("getProducers for session:", sessionId);
    const state = roomState.getRoom(sessionId);
    callback(state ? Array.from(state.producers.keys()) : []);
  } catch (error) {
    console.error("getProducers error:", error);
    callback([]);
  }
};

export const getProducerInfoHandler = async (socket, sessionId, producerId, callback, roomState) => {
  try {
    console.log("getProducerInfo for producer:", producerId);
    const state = roomState.getRoom(sessionId);
    if (!state) return callback(null);

    const producer = state.producers.get(producerId);
    if (!producer) return callback(null);

    callback({
      id: producer.id,
      kind: producer.kind,
      userId: socket.data?.userId,
      socketId: producer.appData?.socketId,
      source: producer.appData?.source || 'camera'
    });
  } catch (error) {
    console.error("getProducerInfo error:", error);
    callback(null);
  }
};

export const consumerReadyHandler = async (socket, sessionId, consumerId, callback, roomState) => {
  try {
    console.log("consumer-ready for consumer:", consumerId);
    const state = roomState.getRoom(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const consumer = state.consumers.get(consumerId);
    if (!consumer) return callback({ error: "Consumer not found" });

    callback({ success: true });
  } catch (error) {
    console.error("consumer-ready error:", error);
    callback({ error: error.message });
  }
};

export const offerHandler = (socket, sessionId, targetSocketId, sdp, io, roomState) => {
  console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
  const state = roomState.getRoom(sessionId);
  if (!state || state.streamerSocketId !== socket.id) return;
  safeEmit(io, targetSocketId, "offer", { from: socket.id, sdp });
};

export const answerHandler = (socket, sessionId, sdp, io, roomState) => {
  console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.getRoom(sessionId);
  if (!state) return;

  const meta = state.sockets.get(socket.id);
  if (!meta || meta.role === ROLE_MAP.STREAMER) return;

  safeEmit(io, state.streamerSocketId, "answer", { from: socket.id, sdp });
};

export const iceCandidateHandler = (socket, sessionId, targetSocketId, candidate, io, roomState) => {
  console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
  const state = roomState.getRoom(sessionId);
  if (!state) return;
  safeEmit(io, targetSocketId, "ice-candidate", { from: socket.id, candidate });
};