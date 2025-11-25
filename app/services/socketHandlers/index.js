// services/socketHandlers/index.js
import { roomJoinHandler } from "./room.handlers.js";
import { chatHandler } from "./chat.handlers.js";
import { producerHandlers } from "./producer.handlers.js";
import { consumerHandlers } from "./consumer.handlers.js";
import { screenShareHandlers } from "./screenShare.handlers.js";
import { participantHandlers } from "./participant.handlers.js";
import { whiteboardHandlers } from "./whiteboard.handlers.js"; 
import { permissionHandlers } from "./permission.handlers.js";
import { cleanupSocketFromRoom } from "../socketUtils/general.utils.js";

export const setupSocketHandlers = (io, mediasoupWorker) => {
  io.on("connection", (socket) => {
    console.log("New client connected:", socket.id);

    roomJoinHandler(socket, io);
    chatHandler(socket, io);
    producerHandlers(socket, io);
    consumerHandlers(socket, io);
    screenShareHandlers(socket, io);
    participantHandlers(socket, io);
    whiteboardHandlers(socket, io);
    permissionHandlers(socket, io);

    socket.on("disconnect", () => cleanupSocketFromRoom(socket));
  });
};