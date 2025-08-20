import mongoose from "mongoose";
import HttpStatus from "http-status-codes";
import { v4 as uuidv4 } from "uuid";
import liveSessionModel from "../../model/LiveSessions/liveSession.model.js";
import whiteBoardModel from "../../model/whiteBoards/whiteBoard.model.js";
import * as commonServices from "../../services/common.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { getIO } from "../../services/socket.webrtc.js"; 
import { ROLE_MAP } from "../../constant/role.js";


const buildUploadedFiles = (fileEntries = [], uploaderId) => {
  if (!Array.isArray(fileEntries) || fileEntries.length === 0) return [];
  return fileEntries.map((f) => ({
    fileName: f.originalname,
    fileUrl: f.location || f.path,
    fileType: f.mimetype,
    uploadedBy: uploaderId,
    uploadedAt: new Date(),
  }));
};

export const startLiveSession = async (req, res) => {
  try {
    const io = getIO(); 

    const { roomCode, title, description, endTime, maxParticipants, isPrivate } = req.body;
    const mentorId = req.tokenData?.userId;

    if (!mentorId || !roomCode || !title) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    const existingSession = await liveSessionModel.findOne({ roomCode, status: "ACTIVE" });
    if (existingSession) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_ALREADY_EXISTS, HttpStatus.BAD_REQUEST);
    }

    const whiteboard = await whiteBoardModel.create({
      whiteboardId: uuidv4(),
      title: title,
      description: description || "",
      createdBy: mentorId,
      createdByRole: ROLE_MAP.STREAMER,
      participants: [
        {
          user: mentorId,
          role: "owner",
          joinedAt: new Date(),
          lastActive: new Date(),
          cursorPosition: {}
        }
      ]
    });

    // Step 2: Save live session with linked whiteboard
    const sessionId = uuidv4();
    const dataToSave = {
      streamerId: mentorId,
      streamerRole: ROLE_MAP.STREAMER,
      sessionId,
      roomCode,
      title,
      description,
      actualStartTime: new Date(),
      endTime,
      participants: [],
      allowedUsers: [],
      whiteboardId: whiteboard._id, 
      chatMessages: [],
      recordingUrl: "",
      maxParticipants: maxParticipants || 100,
      isPrivate: isPrivate || false,
      status: "ACTIVE"
    };

    const liveSession = await commonServices.create(liveSessionModel, dataToSave);

    // Step 3: Notify socket layer
    io.emit("session_started", {
      sessionId,
      mentorId,
      title,
      roomCode,
      maxParticipants,
      whiteboardId: whiteboard._id,
    });

    return sendSuccessResponse(res, liveSession, successEn.LIVE_SESSION_CREATED, HttpStatus.CREATED);

  } catch (error) {
    console.log("Start LiveSession Error:", error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// =========================
// Pause Live Session
// =========================
export const pauseLiveSession = async (req, res) => {
  try {
    const io = getIO(); // ✅ global Socket.io instance

    const { sessionId } = req.params;
    const mentorId = req.tokenData?.userId;

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

    if (session.streamerId.toString() !== mentorId)
    return sendErrorResponse(res, "Unauthorized to pause session", HttpStatus.UNAUTHORIZED);


    session.status = "PAUSED";
    await session.save();

    // Socket emit to notify participants
    io.to(sessionId).emit("session_paused", { sessionId });

    return sendSuccessResponse(res, session, "Live session paused successfully", HttpStatus.OK);
  } catch (error) {
    console.error(error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


// =========================
// Resume Live Session
// =========================
export const resumeLiveSession = async (req, res) => {
  try {
    const io = getIO(); // ✅ global Socket.io instance

    const { sessionId } = req.params;
    const mentorId = req.tokenData?.userId;

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

    if (session.streamerId.toString() !== mentorId)
    return sendErrorResponse(res, "Unauthorized to pause session", HttpStatus.UNAUTHORIZED);

    session.status = "ACTIVE";
    await session.save();

    // Socket emit to notify participants
    io.to(sessionId).emit("session_resumed", { sessionId });

    return sendSuccessResponse(res, session, "Live session resumed successfully", HttpStatus.OK);
  } catch (error) {
    console.error(error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


// =========================
// Save Whiteboard Recording
// =========================
export const saveWhiteboardRecording = async (req, res) => {
    try {
        const { whiteboardId } = req.params;       // ✅ route param match
        const uploadedBy = req.tokenData?.userId;  // ✅ token se userId

        if (!whiteboardId) 
            return sendErrorResponse(res, "All fields required", 400);

        const whiteboard = await whiteBoardModel.findById(whiteboardId);
        if (!whiteboard) 
            return sendErrorResponse(res, "Whiteboard not found", 404);

        // ========================
        // Files from body (JSON array)
        // ========================
        const safeJsonParse = (str, defaultVal) => {
            try { return JSON.parse(str); } catch { return defaultVal; }
        };
        const filesFromBody = safeJsonParse(req.body.files, []);

        // ========================
        // Files from multer upload
        // ========================
        const buildUploadedFiles = (fileEntries = [], uploaderId) => {
            if (!Array.isArray(fileEntries) || fileEntries.length === 0) return [];
            return fileEntries.map((f) => ({
                fileName: f.originalname,
                fileUrl: f.location || f.path,
                fileType: f.mimetype,
                uploadedBy: uploaderId,
                uploadedAt: new Date(),
            }));
        };

        const uploadedFiles = [
            ...buildUploadedFiles(req.files?.recordingUrl, uploadedBy),
            ...buildUploadedFiles(req.files?.file, uploadedBy)
        ];

        // ========================
        // Merge both
        // ========================
        const mergedFiles = Array.isArray(filesFromBody) ? [...filesFromBody, ...uploadedFiles] : uploadedFiles;

        if (mergedFiles.length === 0) 
            return sendErrorResponse(res, "No files to save", 400);

        // ========================
        // Push to whiteboard recordingUrl
        // ========================
        mergedFiles.forEach(file => {
            whiteboard.recordingUrl.push({ 
                fileName: file.fileName || "unknown",
                fileUrl: file.fileUrl,
                fileType: file.fileType || "unknown",
                uploadedBy
            });
        });

        await whiteboard.save();

        return sendSuccessResponse(res, whiteboard, "Whiteboard recording saved", 200);

    } catch (error) {
        console.error("🔥 saveWhiteboardRecording error:", error.message);
        return sendErrorResponse(res, "Internal server error", 500);
    }
};



// =========================
// Get Session Analytics
// =========================
export const getSessionAnalytics = async (req, res) => {
    try {
        const { sessionId } = req.params;

        const session = await liveSessionModel.findOne({ sessionId }).populate("participants", "name email role");
        if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

        const analytics = {
            totalJoins: session.totalJoins || session.participants.length,
            peakParticipants: session.peakParticipants || session.participants.length,
            duration: session.duration || (session.endTime && session.actualStartTime ? Math.floor((session.endTime - session.actualStartTime) / 60000) : 0),
        };

        return sendSuccessResponse(res, analytics, "Session analytics fetched", HttpStatus.OK);
    } catch (error) {
        console.error(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};



export const endLiveSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;

    if (!sessionId) {
      return sendErrorResponse(res, "All fields required", 400);
    }

    const liveSession = await liveSessionModel.findOne({
      $or: [
        { sessionId: sessionId },
        { _id: mongoose.Types.ObjectId.isValid(sessionId) ? sessionId : null }
      ]
    });

    if (!liveSession) {
      return sendErrorResponse(res, "Live session not found", 404);
    }

    // ✅ Updated: streamerId used instead of mentorId
    if (liveSession.streamerId.toString() !== userId) {
      return sendErrorResponse(res, "Unauthorized to end this session", 401);
    }

    // ✅ Update session status
    liveSession.status = "ENDED";
    liveSession.endTime = new Date();
    await liveSession.save();

    // ✅ Close linked whiteboard if exists
    if (liveSession.whiteboardId) {
      await whiteBoardModel.findByIdAndUpdate(liveSession.whiteboardId, {
        $set: { status: "CLOSED" }
      });
    }

    // ✅ Emit via socket.io if instance exists
    const io = req.app.get("io");
    if (io) {
      io.to(sessionId).emit("session_ended", {
        sessionId,
        message: "Live session has ended by the mentor."
      });
    }

    // ✅ Clean up WebRTC peers
    if (global.webrtcPeers && global.webrtcPeers[sessionId]) {
      Object.values(global.webrtcPeers[sessionId]).forEach(peer => {
        try { peer.close(); } catch (e) {}
      });
      delete global.webrtcPeers[sessionId];
    }

    return sendSuccessResponse(res, liveSession, "Live session ended successfully", 200);

  } catch (error) {
    console.error("🔥 endLiveSession error:", error.message);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};



export const getAllLiveSessions = async (req, res) => {
    try {
        const liveSessions = await liveSessionModel
            .find()
            .populate("streamerId", "name email role profilePic")  // ✅ updated
            .populate("participants", "name email role profilePic") 
            .populate({
                path: "whiteboardId", 
                populate: {
                    path: "participants",
                    select: "name email role profilePic"
                }
            });
            // .populate({
            //     path: "chatMessages",
            //     populate: {
            //         path: "senderId", 
            //         select: "name email role profilePic"
            //     }
            // });

        return sendSuccessResponse(res, liveSessions, "Live sessions fetched successfully", HttpStatus.OK);
    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, "Internal server error", HttpStatus.INTERNAL_SERVER_ERROR);
    }
};


export const getSingleLiveSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!sessionId) {
            return sendErrorResponse(res, "All fields required", 400);
        }

        const liveSession = await liveSessionModel
            .findOne({ _id: sessionId })
            .populate("streamerId", "name email role profilePic") // ✅ updated
            .populate("participants", "name email role profilePic") 
            .populate("allowedUsers", "name email role profilePic")
            .populate({
                path: "whiteboardId", // ✅ Whiteboard ka data
                populate: {
                    path: "participants",
                    select: "name email role profilePic"
                }
            });
            // .populate({
            //     path: "chatMessages",
            //     populate: {
            //         path: "senderId",
            //         select: "name email role profilePic"
            //     }
            // });

        if (!liveSession) {
            return sendErrorResponse(res, "Live session not found", 404);
        }

        return sendSuccessResponse(res, liveSession, "Live session fetched successfully", 200);

    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, "Internal server error", 500);
    }
};


export const updateLiveSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const updateData = req.body;

        if (!sessionId || Object.keys(updateData).length === 0) {
            return sendErrorResponse(res, "All fields required", 400);
        }

        // 🔹 Convert participants & allowedUsers to ObjectId properly
        if (updateData.participants && Array.isArray(updateData.participants)) {
            updateData.participants = updateData.participants.map(id => new mongoose.Types.ObjectId(id));
        }

        if (updateData.allowedUsers && Array.isArray(updateData.allowedUsers)) {
            updateData.allowedUsers = updateData.allowedUsers.map(id => new mongoose.Types.ObjectId(id));
        }

        const updatedSession = await liveSessionModel
            .findOneAndUpdate(
                {
                    $or: [
                        { sessionId: sessionId },
                        { _id: mongoose.Types.ObjectId.isValid(sessionId) ? sessionId : null }
                    ]
                },
                { $set: updateData },
                { new: true }
            )
            .populate("streamerId", "name email role profilePic")
            .populate("participants", "name email role profilePic")
            .populate("allowedUsers", "name email role profilePic")
            .populate({
                path: "whiteboardId",
                populate: {
                    path: "participants",
                    select: "name email role profilePic"
                }
            });

        if (!updatedSession) {
            return sendErrorResponse(res, "Live session not found", 404);
        }

        // 🔹 Sync Whiteboard participants
        if (updateData.participants && updatedSession.whiteboardId) {
            await whiteBoardModel.findByIdAndUpdate(updatedSession.whiteboardId, {
                $addToSet: { participants: { $each: updateData.participants } }
            });
        }

        // 🔹 Emit Socket.io event
        const io = req.app.get("io");
        if (io) {
            io.to(updatedSession.roomCode).emit("liveSessionUpdated", updatedSession);
        }

        return sendSuccessResponse(res, updatedSession, "Live session updated successfully", 200);

    } catch (error) {
        console.log("🔥 updateLiveSession error:", error.message);
        return sendErrorResponse(res, "Internal server error", 500);
    }
};

export const softDeleteLiveSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!sessionId) {
            return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
        }

        const deletedSession = await liveSessionModel
            .findOneAndUpdate(
                {
                    $or: [
                        { sessionId: sessionId },
                        { _id: mongoose.Types.ObjectId.isValid(sessionId) ? sessionId : null }
                    ]
                },
                { $set: { isDeleted: true, status: "ENDED" } },
                { new: true }
            )
            .populate("mentorId", "name email role profilePic")
            .populate("participants", "name email role profilePic")
            .populate("allowedUsers", "name email role profilePic")
            .populate({
                path: "whiteboardId",
                populate: {
                    path: "participants",
                    select: "name email role profilePic"
                }
            });

        if (!deletedSession) {
            return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        // Whiteboard bhi soft delete
        if (deletedSession.whiteboardId) {
            await whiteBoardModel.findByIdAndUpdate(deletedSession.whiteboardId, {
                $set: { isDeleted: true, status: "ENDED" }
            });
        }

        // ✅ Socket emit
        const io = req.app.get("io");
        if (io) {
            io.to(deletedSession.roomCode).emit("liveSessionDeleted", deletedSession);
        }

        return sendSuccessResponse(res, deletedSession, successEn.LIVE_SESSION_DELETED, HttpStatus.OK);

    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};

export const restoreLiveSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!sessionId) {
            return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
        }

        const updatedSession = await liveSessionModel
            .findOneAndUpdate(
                {
                    $or: [
                        { sessionId: sessionId },
                        { _id: mongoose.Types.ObjectId.isValid(sessionId) ? sessionId : null }
                    ]
                },
                { $set: { isDeleted: false, status: "ACTIVE" } },
                { new: true }
            )
            .populate("mentorId", "name email role profilePic")
            .populate("participants", "name email role profilePic")
            .populate("allowedUsers", "name email role profilePic")
            .populate({
                path: "whiteboardId",
                populate: {
                    path: "participants",
                    select: "name email role profilePic"
                }
            });

        if (!updatedSession) {
            return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        // Whiteboard bhi restore
        if (updatedSession.whiteboardId) {
            await whiteBoardModel.findByIdAndUpdate(updatedSession.whiteboardId, {
                $set: { isDeleted: false, status: "ACTIVE" }
            });
        }

        // ✅ Socket emit
        const io = req.app.get("io");
        if (io) {
            io.to(updatedSession.roomCode).emit("liveSessionRestored", updatedSession);
        }

        return sendSuccessResponse(res, updatedSession, successEn.LIVE_SESSION_RESTORED, HttpStatus.OK);

    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};
