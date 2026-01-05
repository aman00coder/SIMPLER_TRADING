// services/socketHandlers/chat.handlers.js
import authenticationModel from "../../model/Authentication/authentication.model.js";
import { roomState } from "../socketState/roomState.js";

export const chatHandler = (socket, io) => {
  socket.on("chat_message", async (data) => {
    const { sessionId, message } = data;
    console.log(`Chat message from socket: ${socket.id}, session: ${sessionId}`);
    
    try {
      const state = roomState.get(sessionId);
      if (!state) return;

      const meta = state.sockets.get(socket.id);
      if (!meta) return;

      const sender = await authenticationModel.findById(meta.userId).select("name");
      
      io.to(sessionId).emit("chat_message", {
        userId: meta.userId,
        name: sender?.name || "Unknown",
        message,
        socketId: socket.id,
        at: new Date(),
      });
      
      console.log(`Chat message broadcast to session: ${sessionId}`);
    } catch (err) {
      console.error("chat_message error:", err);
      throw err;
    }
  });
};