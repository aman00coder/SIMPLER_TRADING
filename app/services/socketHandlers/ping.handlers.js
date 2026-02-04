// services/socketHandlers/ping.handlers.js

import { 
  handlePong, 
  startPingPongMonitoring,
  cleanupSocketFromRoom 
} from "../socketUtils/general.utils.js";

export const pingHandlers = (socket, io) => {
  // Pong receive handler
  socket.on("pong", (data) => {
    console.log(`🔵 Pong received from ${socket.id}:`, data);
    handlePong(socket);
    
    // Optional: ek timestamp return karo
    socket.emit("pong_ack", { 
      receivedAt: Date.now(),
      serverTime: new Date().toISOString()
    });
  });

  // Manual ping request (testing ke liye)
  socket.on("ping_request", (data) => {
    console.log(`🔵 Ping request from ${socket.id}`);
    socket.emit("ping", { 
      timestamp: Date.now(),
      sessionId: data?.sessionId,
      test: true
    });
  });

  // Connection quality check
  socket.on("connection_check", (data, callback) => {
    const checkData = {
      socketId: socket.id,
      timestamp: Date.now(),
      sessionId: socket.data?.sessionId || null,
      latency: Date.now() - (data?.sentAt || Date.now()),
      status: "healthy"
    };
    
    if (callback && typeof callback === 'function') {
      callback(checkData);
    }
  });

  // Socket disconnect pe cleanup
  socket.on("disconnect", async (reason) => {
    console.log(`🔴 Socket disconnected: ${socket.id}, reason: ${reason}`);
    
    // Ping monitoring cleanup
    if (socket.pingInterval) {
      clearInterval(socket.pingInterval);
      socket.pingInterval = null;
    }
    
    if (socket.pingTimeout) {
      clearTimeout(socket.pingTimeout);
      socket.pingTimeout = null;
    }
    
    // Regular cleanup
    await cleanupSocketFromRoom(socket, io);
  });

  // Socket error handler
  socket.on("error", (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
  });
};