// services/socketHandlers/producer.handlers.js
import { roomState } from "../socketState/roomState.js";
import { safeEmit } from "../socketUtils/general.utils.js";

export const producerHandlers = (socket, io) => {
  // Producer control events
  socket.on("producer-pause", (data) => 
    producerPauseHandler(socket, io, data.sessionId, data.producerId)
  );
  
  socket.on("producer-resume", (data) => 
    producerResumeHandler(socket, io, data.sessionId, data.producerId)
  );
  
  socket.on("producer-close", (data) => 
    producerCloseHandler(socket, io, data.sessionId, data.producerId)
  );

  // Transport produce events
  socket.on("transport-produce", (data, cb) =>
    transportProduceHandler(socket, io, data.sessionId, data.transportId, data.kind, data.rtpParameters, data.appData, cb)
  );

  // Streamer screen share audio
  socket.on("transport-produce-streamer-screen-audio", (data, cb) =>
    handleStreamerScreenShareAudio(socket, io, data.sessionId, data.transportId, data.rtpParameters, cb)
  );
};

const producerPauseHandler = async (socket, io, sessionId, producerId) => {
  try {
    console.log("producer-pause for producer:", producerId);
    const state = roomState.get(sessionId);
    if (!state) return;

    const producer = state.producers.get(producerId);
    if (producer && producer.appData?.socketId === socket.id) {
      await producer.pause();
      socket.emit("producer-paused", { producerId });
      console.log(`Producer ${producerId} paused`);
    }
  } catch (error) {
    console.error("producer-pause error:", error);
  }
};

const producerResumeHandler = async (socket, io, sessionId, producerId) => {
  try {
    console.log("producer-resume for producer:", producerId);
    const state = roomState.get(sessionId);
    if (!state) return;

    const producer = state.producers.get(producerId);
    if (producer && producer.appData?.socketId === socket.id) {
      await producer.resume();
      socket.emit("producer-resumed", { producerId });
      console.log(`Producer ${producerId} resumed`);
    }
  } catch (error) {
    console.error("producer-resume error:", error);
  }
};

const producerCloseHandler = async (socket, io, sessionId, producerId) => {
  try {
    console.log("producer-close for producer:", producerId);
    const state = roomState.get(sessionId);
    if (!state) return;

    const producer = state.producers.get(producerId);
    if (producer) {
      producer.close();
      state.producers.delete(producerId);
      console.log(`Producer ${producerId} closed and removed`);
      socket.emit("producer-closed", { 
        producerId,
        userId: producer.appData?.userId,
        source: producer.appData?.source
      });
    }
  } catch (error) {
    console.error("producer-close error:", error);
  }
};

const transportProduceHandler = async (socket, io, sessionId, transportId, kind, rtpParameters, appData, callback) => {
  try {
    console.log("transport-produce for transport:", transportId, "kind:", kind, "source:", appData?.source);
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
        source: appData?.source || 'camera',
        userId: socket.data.userId 
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

const handleStreamerScreenShareAudio = async (socket, io, sessionId, transportId, rtpParameters, callback) => {
  try {
    console.log("🎵 Streamer screen share audio for transport:", transportId);
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
        source: 'screen-audio',
        userId: socket.data.userId
      },
    });

    state.producers.set(producer.id, producer);
    
    // Notify all participants
    io.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: 'screen-audio'
    });

    callback({ id: producer.id });

    producer.on("transportclose", () => {
      console.log("Streamer screen audio producer transport closed:", producer.id);
      try {
        producer.close();
      } catch (e) {
        // ignore
      }
      state.producers.delete(producer.id);
    });

  } catch (error) {
    console.error("Streamer screen share audio error:", error);
    callback({ error: error.message });
  }
};