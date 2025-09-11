// export const pauseAllProducers = async (sessionId, socketId, roomState) => {
//   const state = roomState.getRoom(sessionId);
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

// export const resumeAllProducers = async (sessionId, socketId, roomState) => {
//   const state = roomState.getRoom(sessionId);
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

// export const producerPauseHandler = async (socket, sessionId, producerId, roomState) => {
//   try {
//     console.log("producer-pause for producer:", producerId);
//     const state = roomState.getRoom(sessionId);
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

// export const producerResumeHandler = async (socket, sessionId, producerId, roomState) => {
//   try {
//     console.log("producer-resume for producer:", producerId);
//     const state = roomState.getRoom(sessionId);
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

// export const producerCloseHandler = async (socket, sessionId, producerId, roomState) => {
//   try {
//     console.log("producer-close for producer:", producerId);
//     const state = roomState.getRoom(sessionId);
//     if (!state) return;

//     const producer = state.producers.get(producerId);
//     if (producer) {
//       producer.close();
//       state.producers.delete(producerId);
//       console.log(`Producer ${producerId} closed and removed`);
//       socket.emit("producer-closed", { producerId });
//     }
//   } catch (error) {
//     console.error("producer-close error:", error);
//   }
// };

// export const streamerControlHandler = async (socket, data, io, roomState) => {
//   const { sessionId, status, emitEvent } = data;
//   console.log(`Streamer control request for session: ${sessionId}, status: ${status}`);
  
//   try {
//     const session = await liveSession.findOne({ sessionId });
//     if (!session) return;

//     if (status === "PAUSED") {
//       await pauseAllProducers(sessionId, socket.id, roomState);
//     } else if (status === "ACTIVE") {
//       await resumeAllProducers(sessionId, socket.id, roomState);
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