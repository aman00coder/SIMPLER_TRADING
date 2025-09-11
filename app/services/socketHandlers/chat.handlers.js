// import authenticationModel from "../../model/Authentication/authentication.model.js";

// export const chatHandler = async (socket, sessionId, message, io, roomState) => {
//   console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}`);
  
//   try {
//     const state = roomState.getRoom(sessionId);
//     if (!state) return;

//     const meta = state.sockets.get(socket.id);
//     if (!meta) return;

//     const sender = await authenticationModel.findById(meta.userId).select("name");
    
//     io.to(sessionId).emit("chat_message", {
//       userId: meta.userId,
//       name: sender?.name || "Unknown",
//       message,
//       socketId: socket.id,
//       at: new Date(),
//     });
    
//     console.log(`Chat message broadcast to session: ${sessionId}`);
//   } catch (err) {
//     console.error("chat_message error:", err);
//     throw err;
//   }
// };