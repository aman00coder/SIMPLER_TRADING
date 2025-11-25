// services/socketHandlers/webrtc.handlers.js
import { roomState } from "../socketState/roomState.js";
import { ROLE_MAP } from "../../constant/role.js";
import { safeEmit } from "../socketUtils/general.utils.js";

export const webrtcHandlers = (socket, io) => {
  socket.on("offer", (data) => 
    offerHandler(socket, io, data.sessionId, data.targetSocketId, data.sdp)
  );
  
  socket.on("answer", (data) => 
    answerHandler(socket, io, data.sessionId, data.sdp)
  );
  
  socket.on("ice-candidate", (data) => 
    iceCandidateHandler(socket, io, data.sessionId, data.targetSocketId, data.candidate)
  );
};

const offerHandler = (socket, io, sessionId, targetSocketId, sdp) => {
  console.log(`Offer from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || state.streamerSocketId !== socket.id) return;
  safeEmit(io, targetSocketId, "offer", { from: socket.id, sdp });
};

const answerHandler = (socket, io, sessionId, sdp) => {
  console.log(`Answer from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state) return;

  const meta = state.sockets.get(socket.id);
  if (!meta || meta.role === ROLE_MAP.STREAMER) return;

  safeEmit(io, state.streamerSocketId, "answer", { from: socket.id, sdp });
};

const iceCandidateHandler = (socket, io, sessionId, targetSocketId, candidate) => {
  console.log(`ICE candidate from socket: ${socket.id} to target: ${targetSocketId}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state) return;
  safeEmit(io, targetSocketId, "ice-candidate", { from: socket.id, candidate });
};