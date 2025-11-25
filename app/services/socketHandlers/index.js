// services/socketHandlers/index.js
import { roomJoinHandler } from "./room.handlers.js";
import { chatHandler } from "./chat.handlers.js";
import { producerHandlers } from "./producer.handlers.js";
import { consumerHandlers } from "./consumer.handlers.js";
import { screenShareHandlers } from "./screenShare.handlers.js";
import { participantHandlers } from "./participant.handlers.js";
import { whiteboardHandlers } from "./whiteboard.handlers.js";
import { webrtcHandlers } from "./webrtc.handlers.js";
import { permissionHandlers } from "./permission.handlers.js";

import { cleanupSocketFromRoom } from "../socketUtils/general.utils.js";
import { setGlobalIO } from "../socketUtils/general.utils.js";  // ✅ GLOBAL IO SETTER

let mediasoupWorker;

export const setupSocketHandlers = (io, worker) => {
  // ✅ GLOBAL IO STORE
  setGlobalIO(io);

  // ✅ Store Mediasoup Worker
  mediasoupWorker = worker;

  io.on("connection", (socket) => {
    console.log("New client connected:", socket.id);

    // 👉 Pass only socket + io (globalIO will be used inside utilities)
    roomJoinHandler(socket, io, mediasoupWorker);
    chatHandler(socket, io);
    producerHandlers(socket, io);
    consumerHandlers(socket, io);
    screenShareHandlers(socket, io);
    participantHandlers(socket, io);
    whiteboardHandlers(socket, io);
    webrtcHandlers(socket, io);
    permissionHandlers(socket, io);

    // 🔥 cleanup now uses GLOBAL IO inside general.utils.js
    socket.on("disconnect", () => cleanupSocketFromRoom(socket));
  });
};

// ⚡ Export worker getter
export const getMediasoupWorker = () => mediasoupWorker;
