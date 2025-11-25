// services/socketHandlers/participant.handlers.js
import { roomState } from "../socketState/roomState.js";
import { broadcastParticipantsList, safeEmit } from "../socketUtils/general.utils.js";

export const participantHandlers = (socket, io) => {
  socket.on("get_participants", (data, cb) => 
    getParticipantsHandler(socket, data.sessionId, cb)
  );
  
  socket.on("update_participant_status", (data) => 
    updateParticipantStatusHandler(socket, io, data.sessionId, data.updates)
  );
  
  socket.on("streamer_control", (data) => 
    streamerControlHandler(socket, io, data)
  );
};

const getParticipantsHandler = async (socket, sessionId, callback) => {
  try {
    console.log("getParticipants for session:", sessionId);
    const state = roomState.get(sessionId);
    if (!state) return callback([]);
    
    const participants = Array.from(state.participants.values());
    callback(participants);
  } catch (error) {
    console.error("getParticipants error:", error);
    callback([]);
  }
};

const updateParticipantStatusHandler = async (socket, io, sessionId, updates) => {
  try {
    console.log("updateParticipantStatus for session:", sessionId, "updates:", updates);
    const state = roomState.get(sessionId);
    if (!state) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    const participant = state.participants.get(meta.userId);
    if (participant) {
      // update participant object
      Object.assign(participant, updates);

      // 🔴 Old event (partial update — keep for compatibility)
      io.to(sessionId).emit("participant_updated", {
        userId: meta.userId,
        updates,
      });

      // 🟢 New event (always send full list)
      broadcastParticipantsList(io, sessionId);
    }
  } catch (error) {
    console.error("updateParticipantStatus error:", error);
  }
};

const streamerControlHandler = async (socket, io, data) => {
  const { sessionId, status, emitEvent } = data;
  console.log(`Streamer control request for session: ${sessionId}, status: ${status}`);
  
  try {
    const session = await liveSession.findOne({ sessionId });
    if (!session) return;

    if (status === "PAUSED") {
      await pauseAllProducers(sessionId, socket.id);
    } else if (status === "ACTIVE") {
      await resumeAllProducers(sessionId, socket.id);
    }

    session.status = status;
    if (status === "ACTIVE" && emitEvent === "streamer_started") {
      session.actualStartTime = new Date();
    }

    await session.save();
    io.to(sessionId).emit(emitEvent, { sessionId });
    console.log(`Session ${sessionId} ${status.toLowerCase()} by streamer`);
  } catch (err) {
    console.error("streamer_control error:", err);
    throw err;
  }
};

const pauseAllProducers = async (sessionId, socketId) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  console.log(`Pausing all producers for socket: ${socketId} in session: ${sessionId}`);
  
  for (const [producerId, producer] of state.producers) {
    if (producer.appData?.socketId === socketId) {
      try {
        await producer.pause();
        console.log(`Producer ${producerId} paused`);
        safeEmit(io, socketId, "producer-paused", { producerId });
      } catch (error) {
        console.error("Error pausing producer:", error);
      }
    }
  }
};

const resumeAllProducers = async (sessionId, socketId) => {
  const state = roomState.get(sessionId);
  if (!state) return;

  console.log(`Resuming all producers for socket: ${socketId} in session: ${sessionId}`);
  
  for (const [producerId, producer] of state.producers) {
    if (producer.appData?.socketId === socketId) {
      try {
        await producer.resume();
        console.log(`Producer ${producerId} resumed`);
        safeEmit(io, socketId, "producer-resumed", { producerId });
      } catch (error) {
        console.error("Error resuming producer:", error);
      }
    }
  }
};