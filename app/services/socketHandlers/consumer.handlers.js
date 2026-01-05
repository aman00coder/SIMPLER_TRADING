// services/socketHandlers/consumer.handlers.js
import { roomState } from "../socketState/roomState.js";

export const consumerHandlers = (socket, io) => {
  socket.on("getRouterRtpCapabilities", (data, cb) => 
    getRouterRtpCapabilitiesHandler(socket, data.sessionId, cb)
  );
  
  socket.on("createWebRtcTransport", (data, cb) => 
    createWebRtcTransportHandler(socket, data.sessionId, cb)
  );
  
  socket.on("transport-connect", (data, cb) =>
    transportConnectHandler(socket, data.sessionId, data.transportId, data.dtlsParameters, cb)
  );
  
  socket.on("consume", (data, cb) =>
    consumeHandler(socket, data.sessionId, data.transportId, data.producerId, data.rtpCapabilities, cb)
  );
  
  socket.on("consumer-resume", (data, cb) =>
    consumerResumeHandler(socket, data.sessionId, data.consumerId, cb)
  );
  
  socket.on("getProducers", (data, cb) =>
    getProducersHandler(socket, data.sessionId, cb)
  );
  
  socket.on("getProducerInfo", (data, cb) =>
    getProducerInfoHandler(socket, data.sessionId, data.producerId, cb)
  );
  
  socket.on("consumer-ready", (data, cb) =>
    consumerReadyHandler(socket, data.sessionId, data.consumerId, cb)
  );
};

const getRouterRtpCapabilitiesHandler = async (socket, sessionId, callback) => {
  try {
    console.log("getRouterRtpCapabilities for session:", sessionId);
    const state = roomState.get(sessionId);
    if (!state || !state.router) return callback({ error: "Router not found" });
    callback({ rtpCapabilities: state.router.rtpCapabilities });
  } catch (error) {
    console.error("getRouterRtpCapabilities error:", error);
    callback({ error: error.message });
  }
};

const createWebRtcTransportHandler = async (socket, sessionId, callback) => {
  try {
    console.log("createWebRtcTransport for session:", sessionId);
    const state = roomState.get(sessionId);
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

const transportConnectHandler = async (socket, sessionId, transportId, dtlsParameters, callback) => {
  try {
    console.log("transport-connect for transport:", transportId);
    const state = roomState.get(sessionId);
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

const consumeHandler = async (socket, sessionId, transportId, producerId, rtpCapabilities, callback) => {
  try {
    console.log("consume for producer:", producerId, "transport:", transportId);
    const state = roomState.get(sessionId);
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

const consumerResumeHandler = async (socket, sessionId, consumerId, callback) => {
  try {
    console.log("consumer-resume for consumer:", consumerId);
    const state = roomState.get(sessionId);
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

const getProducersHandler = async (socket, sessionId, callback) => {
  try {
    console.log("getProducers for session:", sessionId);
    const state = roomState.get(sessionId);
    callback(state ? Array.from(state.producers.keys()) : []);
  } catch (error) {
    console.error("getProducers error:", error);
    callback([]);
  }
};

const getProducerInfoHandler = async (socket, sessionId, producerId, callback) => {
  try {
    console.log("getProducerInfo for producer:", producerId);
    const state = roomState.get(sessionId);
    if (!state) return callback(null);

    const producer = state.producers.get(producerId);
    if (!producer) return callback(null);

    callback({
      id: producer.id,
      kind: producer.kind,
      userId: producer.appData?.userId,
      socketId: producer.appData?.socketId,
      source: producer.appData?.source || 'camera'
    });
  } catch (error) {
    console.error("getProducerInfo error:", error);
    callback(null);
  }
};

const consumerReadyHandler = async (socket, sessionId, consumerId, callback) => {
  try {
    console.log("consumer-ready for consumer:", consumerId);
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const consumer = state.consumers.get(consumerId);
    if (!consumer) return callback({ error: "Consumer not found" });

    callback({ success: true });
  } catch (error) {
    console.error("consumer-ready error:", error);
    callback({ error: error.message });
  }
};