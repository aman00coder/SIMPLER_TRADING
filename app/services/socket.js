import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import liveSessionParticipant from "../model/liveSessionParticipant/liveSessionParticipant.model.js";
import liveSession from "../model/liveSessions/liveeSession.model.js"

export default function setupSocket(server) {
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        }
    });

    io.on("connection", (socket) => {
        console.log("New client connected:", socket.id);

        // =========================
        // Join Room
        // =========================
        socket.on("join_room", async ({ token, sessionId }) => {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                const userId = decoded.userId;

                // Check if session exists
                const sessionExists = await liveSession.findById(sessionId);
                if (!sessionExists) {
                    return socket.emit("error_message", "Session not found");
                }

                // Check if already joined
                const alreadyJoined = await liveSessionParticipant.findOne({ sessionId, userId });
                if (alreadyJoined) {
                    return socket.emit("error_message", "User already joined this session");
                }

                // Add participant
                await liveSessionParticipant.create({
                    sessionId,
                    userId,
                    socketId: socket.id
                });

                socket.join(sessionId);
                console.log(`User ${userId} joined session ${sessionId}`);

                // Notify room
                io.to(sessionId).emit("user_joined", { userId });

            } catch (error) {
                console.error("Join room error:", error.message);
                socket.emit("error_message", "Invalid token or session.");
            }
        });

        // =========================
        // Leave Room
        // =========================
        socket.on("leave_room", async ({ sessionId, userId }) => {
            try {
                await liveSessionParticipant.deleteOne({ sessionId, userId });
                socket.leave(sessionId);
                io.to(sessionId).emit("user_left", { userId });
                console.log(`User ${userId} left session ${sessionId}`);
            } catch (error) {
                console.error("Leave room error:", error.message);
            }
        });

        // =========================
        // Disconnect
        // =========================
        socket.on("disconnect", async () => {
            try {
                const participant = await liveSessionParticipant.findOne({ socketId: socket.id });
                if (participant) {
                    const { sessionId, userId } = participant;
                    await liveSessionParticipant.deleteOne({ socketId: socket.id });
                    io.to(sessionId).emit("user_left", { userId });
                    console.log(`User ${userId} disconnected from session ${sessionId}`);
                }
            } catch (error) {
                console.error("Disconnect error:", error.message);
            }
        });
    });

    return io;
}
