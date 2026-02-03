import { roomState } from "../socketState/roomState.js";
import { 
  startSpeakingDetection, 
  broadcastHandRaise,
  resetAllHandRaised 
} from "../socketUtils/general.utils.js";

export const speakingHandlers = (socket, io) => {
  // Speaking status events
  socket.on("user_speaking", (data) => 
    handleUserSpeaking(socket, io, data.sessionId, data.isSpeaking)
  );
  
  socket.on("user_stopped_speaking", (data) => 
    handleUserStoppedSpeaking(socket, io, data.sessionId)
  );
  
  // Hand raise events
  socket.on("hand_raise", (data) => 
    handleHandRaise(socket, io, data.sessionId)
  );
  
  socket.on("hand_down", (data) => 
    handleHandDown(socket, io, data.sessionId)
  );
  
  socket.on("lower_hand", (data) => 
    handleLowerHand(socket, io, data.sessionId, data.targetUserId)
  );
  
  socket.on("lower_all_hands", (data) => 
    handleLowerAllHands(socket, io, data.sessionId)
  );
};

const handleUserSpeaking = (socket, io, sessionId, isSpeaking) => {
  try {
    const state = roomState.get(sessionId);
    if (!state) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    startSpeakingDetection(io, sessionId, meta.userId, isSpeaking);
    console.log(`User ${meta.userId} is speaking in session ${sessionId}`);
  } catch (error) {
    console.error("handleUserSpeaking error:", error);
  }
};

const handleUserStoppedSpeaking = (socket, io, sessionId) => {
  try {
    const state = roomState.get(sessionId);
    if (!state) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    startSpeakingDetection(io, sessionId, meta.userId, false);
    console.log(`User ${meta.userId} stopped speaking in session ${sessionId}`);
  } catch (error) {
    console.error("handleUserStoppedSpeaking error:", error);
  }
};

const handleHandRaise = (socket, io, sessionId) => {
  try {
    const state = roomState.get(sessionId);
    if (!state) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    // Streamer cannot raise hand
    if (meta.role === 'STREAMER') return;

    broadcastHandRaise(io, sessionId, meta.userId, true);
    console.log(`User ${meta.userId} raised hand in session ${sessionId}`);
  } catch (error) {
    console.error("handleHandRaise error:", error);
  }
};

const handleHandDown = (socket, io, sessionId) => {
  try {
    const state = roomState.get(sessionId);
    if (!state) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    broadcastHandRaise(io, sessionId, meta.userId, false);
    console.log(`User ${meta.userId} lowered hand in session ${sessionId}`);
  } catch (error) {
    console.error("handleHandDown error:", error);
  }
};

const handleLowerHand = (socket, io, sessionId, targetUserId) => {
  try {
    const state = roomState.get(sessionId);
    if (!state) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    // Only streamer can lower others' hands
    if (meta.role !== 'STREAMER') return;

    broadcastHandRaise(io, sessionId, targetUserId, false);
    console.log(`Streamer lowered hand for user ${targetUserId} in session ${sessionId}`);
  } catch (error) {
    console.error("handleLowerHand error:", error);
  }
};

const handleLowerAllHands = (socket, io, sessionId) => {
  try {
    const state = roomState.get(sessionId);
    if (!state) return;

    const meta = state.sockets.get(socket.id);
    if (!meta) return;

    // Only streamer can lower all hands
    if (meta.role !== 'STREAMER') return;

    resetAllHandRaised(io, sessionId);
    console.log(`Streamer lowered all hands in session ${sessionId}`);
  } catch (error) {
    console.error("handleLowerAllHands error:", error);
  }
};