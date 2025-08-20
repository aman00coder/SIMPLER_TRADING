import mongoose from "mongoose";
import HttpStatus from "http-status-codes";
import liveSessionParticipantModel from "../../model/liveSessionParticipant/liveSessionParticipant.model.js";
import liveSessionModel from "../../model/LiveSessions/liveSession.model.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { ROLE_MAP } from "../../constant/role.js";
import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";
// ===========================
// Join Participant
// ===========================
export const joinParticipant = async (req, res) => {
    try {
        const { sessionId } = req.params;  
        const userId = req.tokenData?.userId;
        const userRole = req.tokenData?.role || ROLE_MAP.VIEWER;

        if (!sessionId || !userId) {
            return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
        }

        // ✅ Check session exists (string sessionId)
        const sessionExists = await liveSessionModel.findOne({ sessionId: sessionId });
        if (!sessionExists) {
            return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        // ✅ Check if already participant
        let participant = await liveSessionParticipantModel.findOne({ sessionId: sessionId, userId });

        if (participant) {
            if (participant.status === "LEFT") {
                // Agar pehle left tha to update karo
                participant.status = "JOINED";
                participant.joinedAt = new Date();
                participant.leftAt = null;
                participant.socketId = "backend-test";
                await participant.save();
            } else {
                return sendErrorResponse(res, "User already joined this session", HttpStatus.BAD_REQUEST);
            }
        } else {
            // ✅ Save new participant with role + info
            participant = await liveSessionParticipantModel.create({
                sessionId: sessionId,
                userId,
                role: userRole,
                socketId: "backend-test", // actual socket id runtime me dalna hoga
                status: "JOINED",
                ipAddress: req.ip,
                deviceInfo: req.headers["user-agent"]
            });
        }

        // ✅ Update session stats + participants array
        await liveSessionModel.updateOne(
            { sessionId: sessionId },
            {
                $inc: { totalJoins: 1 },
                $addToSet: { participants: userId }
            }
        );

        // ✅ Whiteboard me bhi participant add karo (agar linked hai)
        if (sessionExists.whiteboardId) {
            await whiteboardModel.findByIdAndUpdate(
                sessionExists.whiteboardId,
                {
                    $addToSet: {
                        participants: {
                            user: userId,
                            role: "editor", // ya role mapping ke hisaab se
                            joinedAt: new Date()
                        }
                    }
                }
            );
        }

        // ✅ Socket event emit (realtime notify)
        const io = req.app.get("io");
        if (io) {
            io.to(sessionId).emit("participant:joined", {
                sessionId,
                userId,
                role: participant.role,
                status: participant.status
            });
        }

        return sendSuccessResponse(res, participant, successEn.CREATED, HttpStatus.CREATED);

    } catch (error) {
        console.error("joinParticipant error:", error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};



// ===========================
// Leave Participant
// ===========================
export const leaveParticipant = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.tokenData?.userId;

        if (!sessionId || !userId) {
            return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
        }

        const participant = await liveSessionParticipantModel.findOne({ sessionId, userId });
        if (!participant) {
            return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        await liveSessionParticipantModel.deleteOne({ sessionId, userId });

        // ✅ io instance from app
        const io = req.app.get("io");
        if (io) {
            io.to(sessionId).emit("participant_left", {
                sessionId,
                userId,
                message: "Participant has left the session"
            });
        }

        return sendSuccessResponse(res, null, successEn.SESSION_LEFT, HttpStatus.OK);

    } catch (error) {
        console.error(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};


// Get All Participants (with role)
// ===========================
export const getSessionParticipants = async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    const participants = await liveSessionParticipantModel.find({ sessionId })
      .populate("userId", "name email role");

    if (!participants.length) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // Group into single object
    const response = {
      sessionId,
      participants: participants.map(p => ({
        _id: p._id,
        user: p.userId,      // populated user object
        role: p.role,
        status: p.status,
        socketId: p.socketId,
        joinedAt: p.joinedAt,
        leftAt: p.leftAt,
        ipAddress: p.ipAddress,
        deviceInfo: p.deviceInfo
      }))
    };

    return sendSuccessResponse(res, response, successEn.DATA_FOUND, HttpStatus.OK);

  } catch (error) {
    console.error(error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


// ===========================
// Get Single Participant
// ===========================
export const getSingleParticipant = async (req, res) => {
  try {
    const { sessionId, userId } = req.params;

    if (!sessionId || !userId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    // ✅ Check session exists
    const sessionExists = await liveSessionModel.findOne({ sessionId: sessionId });
    if (!sessionExists) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // ✅ Find participant
    const participant = await liveSessionParticipantModel.findOne({
      sessionId: sessionId,
      userId: userId,
    }).populate("userId", "name email role");

    if (!participant) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_PARTICIPANT_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // ✅ Structured response
    const response = {
      sessionId,
      participant: {
        _id: participant._id,
        user: participant.userId,  
        role: participant.role,
        status: participant.status,
        socketId: participant.socketId,
        joinedAt: participant.joinedAt,
        leftAt: participant.leftAt,
        ipAddress: participant.ipAddress,
        deviceInfo: participant.deviceInfo,
      },
    };

    return sendSuccessResponse(res, response, successEn.DATA_FOUND, HttpStatus.OK);

  } catch (error) {
    console.error("getSingleParticipant error:", error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};



// ===========================
// Remove Participant by SocketId (used in socket disconnect)
// ===========================
export const removeParticipantBySocket = async (socketId, io) => {
    try {
        if (!socketId) return null;

        const participant = await liveSessionParticipantModel.findOne({ socketId });
        if (!participant) return null;

        await liveSessionParticipantModel.deleteOne({ socketId });

        if (io && participant.sessionId) {
            io.to(participant.sessionId).emit("participant_left", {
                userId: participant.userId,
                sessionId: participant.sessionId,
                socketId: participant.socketId,
                message: "Participant has left the session"
            });
        }

        return participant;

    } catch (error) {
        console.error("Error removing participant by socket:", error.message);
        return null;
    }
};
