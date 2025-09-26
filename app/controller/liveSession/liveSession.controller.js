import mongoose from "mongoose";
import HttpStatus from "http-status-codes";
import { v4 as uuidv4 } from "uuid";
import liveSessionModel from "../../model/liveSessions/liveeSession.model.js";
import whiteBoardModel from "../../model/whiteBoards/whiteBoard.model.js";
import * as commonServices from "../../services/common.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { getIO } from "../../services/socket.integrated.js"; 
import { ROLE_MAP } from "../../constant/role.js";

/**
 * Start Live Session
 */
// 🔹 Helper: secure random alphanumeric roomCode
const generateRoomCode = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

// 🔹 Schedule session auto-end
const scheduleSessionAutoEnd = (sessionId, endTime) => {
  if (!endTime) return;
  const delay = new Date(endTime).getTime() - Date.now();
  if (delay <= 0) return;

  setTimeout(async () => {
    try {
      const io = getIO();
      const session = await liveSessionModel.findOne({ _id: sessionId, status: "ACTIVE" });
      if (!session) return;

      // ✅ Update session status and endTime
      session.status = "ENDED";
      session.endTime = new Date();
      await session.save();

      // ✅ Close whiteboard if exists
      if (session.whiteboardId) {
        await whiteBoardModel.findByIdAndUpdate(session.whiteboardId, { $set: { status: "CLOSED" } });
      }

      // ✅ Notify clients
      io.to(session.sessionId).emit("session_ended", {
        sessionId: session.sessionId,
        message: "Session automatically ended after scheduled endTime."
      });

      console.log(`✅ Auto-ended LiveSession: ${session.sessionId}`);
    } catch (err) {
      console.error("🔥 Auto-end session error:", err.message);
    }
  }, delay);
};

// ✅ Start Live Session
export const startLiveSession = async (req, res) => {
  try {
    const io = getIO(); 
    const { title, description, endTime, maxParticipants, isPrivate } = req.body;
    const mentorId = req.tokenData?.userId;

    if (!mentorId || !title) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    const roomCode = generateRoomCode();
    const existingSession = await liveSessionModel.findOne({ roomCode, status: "ACTIVE" });
    if (existingSession) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_ALREADY_EXISTS, HttpStatus.BAD_REQUEST);
    }

    const sessionId = uuidv4();
    const liveSession = await liveSessionModel.create({
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
      chatMessages: [],
      recordingUrl: "",
      maxParticipants: maxParticipants || 100,
      isPrivate: isPrivate || false,
      status: "ACTIVE",
      totalActiveDuration: 0
    });

    const whiteboard = await whiteBoardModel.create({
      whiteboardId: uuidv4(),
      title,
      description: description || "",
      createdBy: mentorId,
      createdByRole: ROLE_MAP.STREAMER,
      liveSessionId: liveSession._id,
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

    liveSession.whiteboardId = whiteboard._id;
    await liveSession.save();

    // 🔹 Schedule auto-end
    scheduleSessionAutoEnd(liveSession._id, endTime);

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
    console.error("Start LiveSession Error:", error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

/**
 * ✅ Get All Live Sessions of Current User Only
 */
export const getAllLiveSessions = async (req, res) => {
  try {
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role; // assume token me role bhi stored hai

    if (!userId) {
      return sendErrorResponse(res, "Unauthorized: userId missing", HttpStatus.UNAUTHORIZED);
    }

    let filter = {};

    // ✅ agar streamer hai toh apne sessions hi dekhe
    if (userRole === "STREAMER") {
      filter.streamerId = userId;
    } else {
      // ✅ viewer ya user sab active sessions dekhe
      filter.status = "ACTIVE";
    }

    const liveSessions = await liveSessionModel
      .find(filter)
      .populate("streamerId", "name email role profilePic")
      .populate("participants", "name email role profilePic")
      .populate({
        path: "whiteboardId",
        populate: {
          path: "participants",
          select: "name email role profilePic"
        }
      });

    return sendSuccessResponse(
      res,
      liveSessions,
      userRole === "STREAMER" ? "Your live sessions fetched successfully" : "All live sessions fetched successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("getAllLiveSessions Error:", error.message);
    return sendErrorResponse(res, "Internal server error", HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// =========================
// Pause Live Session
// =========================
export const pauseLiveSession = async (req, res) => {
  try {
    const io = getIO();
    const { sessionId } = req.params;
    const mentorId = req.tokenData?.userId;

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

    if (session.streamerId.toString() !== mentorId)
      return sendErrorResponse(res, "Unauthorized to pause session", HttpStatus.UNAUTHORIZED);

    // Update active duration
    if (session.actualStartTime) {
      session.totalActiveDuration += Math.floor((Date.now() - session.actualStartTime.getTime()) / 1000);
    }

    session.status = "PAUSED";
    await session.save();

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
    const io = getIO();
    const { sessionId } = req.params;
    const mentorId = req.tokenData?.userId;

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

    if (session.streamerId.toString() !== mentorId)
      return sendErrorResponse(res, "Unauthorized to resume session", HttpStatus.UNAUTHORIZED);

    session.status = "ACTIVE";
    session.actualStartTime = new Date(); // reset
    await session.save();

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
    const io = getIO();
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;

    if (!sessionId) {
      return sendErrorResponse(res, "All fields required", 400);
    }

    const liveSession = await liveSessionModel.findOne({ sessionId });
    if (!liveSession) {
      return sendErrorResponse(res, "Live session not found", 404);
    }

    if (liveSession.streamerId.toString() !== userId) {
      return sendErrorResponse(res, "Unauthorized to end this session", 401);
    }

    // Final duration update
    if (liveSession.actualStartTime) {
      liveSession.totalActiveDuration += Math.floor((Date.now() - liveSession.actualStartTime.getTime()) / 1000);
    }

    liveSession.status = "ENDED";
    liveSession.endTime = new Date();
    await liveSession.save();

    if (liveSession.whiteboardId) {
      await whiteBoardModel.findByIdAndUpdate(liveSession.whiteboardId, {
        $set: { status: "CLOSED" }
      });
    }

    io.to(sessionId).emit("session_ended", {
      sessionId,
      message: "Live session has ended by the mentor."
    });

    // ✅ mediasoup transports cleanup
    if (global.mediasoupRouters && global.mediasoupRouters[sessionId]) {
      try { await global.mediasoupRouters[sessionId].close(); } catch {}
      delete global.mediasoupRouters[sessionId];
    }

    return sendSuccessResponse(res, liveSession, "Live session ended successfully", 200);

  } catch (error) {
    console.error("🔥 endLiveSession error:", error.message);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};





export const getSingleLiveSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!sessionId) {
            return sendErrorResponse(res, "All fields required", 400);
        }

        const liveSession = await liveSessionModel
            .findOne({ sessionId }) // ✅ fixed here
            .populate("streamerId", "name email role profilePic")
            .populate("participants", "name email role profilePic")
            .populate("allowedUsers", "name email role profilePic")
            .populate({
                path: "whiteboardId",
                populate: {
                    path: "participants",
                    select: "name email role profilePic"
                }
            })
            .populate({
                path: "chatMessages",
                populate: {
                    path: "senderId",
                    select: "name email role profilePic"
                }
            });

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

    // Convert participants & allowedUsers to ObjectId
    if (updateData.participants && Array.isArray(updateData.participants)) {
      updateData.participants = updateData.participants.map(id => new mongoose.Types.ObjectId(id));
    }

    if (updateData.allowedUsers && Array.isArray(updateData.allowedUsers)) {
      updateData.allowedUsers = updateData.allowedUsers.map(id => new mongoose.Types.ObjectId(id));
    }

    const updatedSession = await liveSessionModel
      .findOneAndUpdate(
        { sessionId },
        { $set: updateData },
        { new: true }
      )
      .populate("streamerId", "name email role profilePic")
      .populate("participants", "name email role profilePic")
      .populate("allowedUsers", "name email role profilePic")
      .populate({
        path: "whiteboardId",
        populate: { path: "participants", select: "name email role profilePic" }
      });

    if (!updatedSession) return sendErrorResponse(res, "Live session not found", 404);

    // Sync Whiteboard participants
    if (updateData.participants && updatedSession.whiteboardId) {
      await whiteBoardModel.findByIdAndUpdate(updatedSession.whiteboardId, {
        $addToSet: { participants: { $each: updateData.participants } }
      });
    }

    // Socket emit
    const io = req.app.get("io");
    if (io) io.to(updatedSession.roomCode).emit("liveSessionUpdated", updatedSession);

    return sendSuccessResponse(res, updatedSession, "Live session updated successfully", 200);
  } catch (error) {
    console.log("🔥 updateLiveSession error:", error.message);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

// 🔹 Soft delete live session
export const softDeleteLiveSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

    const deletedSession = await liveSessionModel
      .findOneAndUpdate(
        { sessionId },
        { $set: { isDeleted: true, status: "ENDED" } },
        { new: true }
      )
      .populate("streamerId", "name email role profilePic")
      .populate("participants", "name email role profilePic")
      .populate("allowedUsers", "name email role profilePic")
      .populate({
        path: "whiteboardId",
        populate: { path: "participants", select: "name email role profilePic" }
      });

    if (!deletedSession) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

    if (deletedSession.whiteboardId) {
      await whiteBoardModel.findByIdAndUpdate(deletedSession.whiteboardId, {
        $set: { isDeleted: true, status: "ENDED" }
      });
    }

    const io = req.app.get("io");
    if (io) io.to(deletedSession.roomCode).emit("liveSessionDeleted", deletedSession);

    return sendSuccessResponse(res, deletedSession, successEn.LIVE_SESSION_DELETED, HttpStatus.OK);
  } catch (error) {
    console.log(error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// 🔹 Restore live session
export const restoreLiveSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

    const updatedSession = await liveSessionModel
      .findOneAndUpdate(
        { sessionId },
        { $set: { isDeleted: false, status: "ACTIVE" } },
        { new: true }
      )
      .populate("streamerId", "name email role profilePic")
      .populate("participants", "name email role profilePic")
      .populate("allowedUsers", "name email role profilePic")
      .populate({
        path: "whiteboardId",
        populate: { path: "participants", select: "name email role profilePic" }
      });

    if (!updatedSession) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

    if (updatedSession.whiteboardId) {
      await whiteBoardModel.findByIdAndUpdate(updatedSession.whiteboardId, {
        $set: { isDeleted: false, status: "ACTIVE" }
      });
    }

    const io = req.app.get("io");
    if (io) io.to(updatedSession.roomCode).emit("liveSessionRestored", updatedSession);

    return sendSuccessResponse(res, updatedSession, successEn.LIVE_SESSION_RESTORED, HttpStatus.OK);
  } catch (error) {
    console.log(error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};
