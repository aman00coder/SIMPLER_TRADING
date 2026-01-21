// services/socketHandlers/producer.handlers.js
import { roomState } from "../socketState/roomState.js";

export const producerHandlers = (socket, io) => {
  socket.on("producer-pause", (data) =>
    producerPauseHandler(socket, data.sessionId, data.producerId)
  );

  socket.on("producer-resume", (data) =>
    producerResumeHandler(socket, data.sessionId, data.producerId)
  );

  socket.on("producer-close", (data) =>
    producerCloseHandler(socket, data.sessionId, data.producerId)
  );

  socket.on("transport-produce", (data, cb) =>
    transportProduceHandler(
      socket,
      io,
      data.sessionId,
      data.transportId,
      data.kind,
      data.rtpParameters,
      data.appData,
      cb
    )
  );

  socket.on("transport-produce-streamer-screen-audio", (data, cb) =>
    handleStreamerScreenShareAudio(
      socket,
      io,
      data.sessionId,
      data.transportId,
      data.rtpParameters,
      cb
    )
  );
};

/* ---------------- PRODUCER HELPERS ---------------- */

const forceKeyframeCycle = async (producer) => {
  try {
    await producer.pause();
    await new Promise(r => setTimeout(r, 150));
    await producer.resume();

    // secondary attempt
    try {
      producer.requestKeyFrame();
    } catch (_) {}

    console.log("🔥 Producer keyframe cycle executed:", producer.id);
  } catch (err) {
    console.warn("⚠️ Keyframe cycle failed:", err.message);
  }
};

const producerPauseHandler = async (socket, sessionId, producerId) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  const producer = state.producers.get(producerId);
  if (producer && producer.appData?.socketId === socket.id) {
    await producer.pause();
    socket.emit("producer-paused", { producerId });
  }
};

const producerResumeHandler = async (socket, sessionId, producerId) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  const producer = state.producers.get(producerId);
  if (producer && producer.appData?.socketId === socket.id) {
    await producer.resume();

    // 🔥 force keyframe on resume
    setTimeout(() => forceKeyframeCycle(producer), 200);

    socket.emit("producer-resumed", { producerId });
  }
};

const producerCloseHandler = async (socket, sessionId, producerId) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  const producer = state.producers.get(producerId);
  if (producer) {
    producer.close();
    state.producers.delete(producerId);
    socket.emit("producer-closed", { producerId });
  }
};

const transportProduceHandler = async (
  socket,
  io,
  sessionId,
  transportId,
  kind,
  rtpParameters,
  appData,
  callback
) => {
  try {
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: {
        socketId: socket.id,
        userId: socket.data.userId,
        source: appData?.source || "camera",
      },
    });

    state.producers.set(producer.id, producer);

    // 🔥 CRITICAL FIX: force keyframe immediately
    setTimeout(() => forceKeyframeCycle(producer), 300);

    producer.on("transportclose", () => {
      producer.close();
      state.producers.delete(producer.id);
    });

    callback({ id: producer.id });

    socket.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: appData?.source || "camera",
    });

  } catch (error) {
    callback({ error: error.message });
  }
};

const handleStreamerScreenShareAudio = async (
  socket,
  io,
  sessionId,
  transportId,
  rtpParameters,
  callback
) => {
  try {
    const state = roomState.get(sessionId);
    if (!state) return callback({ error: "Session not found" });

    const transport = state.transports.get(transportId);
    if (!transport) return callback({ error: "Transport not found" });

    const producer = await transport.produce({
      kind: "audio",
      rtpParameters,
      appData: {
        socketId: socket.id,
        userId: socket.data.userId,
        source: "screen-audio",
      },
    });

    state.producers.set(producer.id, producer);

    callback({ id: producer.id });

    producer.on("transportclose", () => {
      producer.close();
      state.producers.delete(producer.id);
    });

    io.to(sessionId).emit("new-producer", {
      producerId: producer.id,
      kind: producer.kind,
      userId: socket.data.userId,
      source: "screen-audio",
    });

  } catch (error) {
    callback({ error: error.message });
  }
};
