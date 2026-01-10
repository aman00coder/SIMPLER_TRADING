// import mongoose from "mongoose";
// import HttpStatus from "http-status-codes";
// import { v4 as uuidv4 } from "uuid";
// import liveSessionModel from "../../model/liveSessions/liveeSession.model.js";
// import whiteBoardModel from "../../model/whiteBoards/whiteBoard.model.js";
// import * as startLiveRecording from "../../services/recording/liveSessionRecording.service.js";
// import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
// import { errorEn, successEn } from "../../responses/message.js";
// import { getIO } from "../../services/socket.integrated.js";
// import { ROLE_MAP } from "../../constant/role.js";
// import { roomState } from "../../services/socketState/roomState.js";
// import { uploadToS3 } from "../../middleware/aws.s3.js";

// /**
//  * Start Live Session
//  */
// // 🔹 Helper: secure random alphanumeric roomCode
// /** Helper: Generate secure 6-char roomCode */
// const generateRoomCode = () => {
//   const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
//   return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
// };

// /** Schedule session auto-end */
// const scheduleSessionAutoEnd = (sessionId, endTime) => {
//   if (!endTime) return;
//   const delay = new Date(endTime).getTime() - Date.now();
//   if (delay <= 0) return;

//   setTimeout(async () => {
//     try {
//       const io = getIO();
//       const session = await liveSessionModel.findOne({ _id: sessionId, status: "ACTIVE" });
//       if (!session) return;

//       session.status = "ENDED";
//       session.endTime = new Date();
//       await session.save();

//       if (session.whiteboardId) {
//         await whiteBoardModel.findByIdAndUpdate(session.whiteboardId, { $set: { status: "CLOSED" } });
//       }

//       io.to(session.sessionId).emit("session_ended", {
//         sessionId: session.sessionId,
//         message: "Session automatically ended after scheduled endTime."
//       });

//       console.log(`✅ Auto-ended LiveSession: ${session.sessionId}`);
//     } catch (err) {
//       console.error("🔥 Auto-end session error:", err.message);
//     }
//   }, delay);
// };

// /** Start Live Session */
// export const startLiveSession = async (req, res) => {
//   try {
//     const io = getIO();
//     const { title, description, endTime, maxParticipants, isPrivate, courseId } = req.body;
//     const mentorId = req.tokenData?.userId;

//     if (!mentorId || !title) {
//       return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
//     }

//     // 🔹 SIMPLE VERSION: Bas course existence check karen
//     if (courseId) {
//       const course = await mongoose.model("Course").findById(courseId);
//       if (!course) {
//         return sendErrorResponse(res, "Course not found", HttpStatus.NOT_FOUND);
//       }
//       // 🔹 Ownership check REMOVE kiya - koi bhi mentor kisi bhi course ke liye session bana sakta hai
//     }

//     const roomCode = generateRoomCode();
//     const existingSession = await liveSessionModel.findOne({ roomCode, status: "ACTIVE" });
//     if (existingSession) {
//       return sendErrorResponse(res, errorEn.LIVE_SESSION_ALREADY_EXISTS, HttpStatus.CONFLICT);
//     }

//     const sessionId = uuidv4();
//     const liveSession = await liveSessionModel.create({
//       streamerId: mentorId,
//       streamerRole: ROLE_MAP.STREAMER,
//       sessionId,
//       roomCode,
//       title,
//       description: description || "",
//       courseId: courseId || null,
//       actualStartTime: new Date(),
//       endTime,
//       participants: [],
//       allowedUsers: [],
//       chatMessages: [],
//       recordingUrl: JSON.stringify([]),
//       maxParticipants: maxParticipants || 100,
//       isPrivate: isPrivate || false,
//       status: "ACTIVE",
//       totalActiveDuration: 0
//     });

//     // 🔹 Course mein bhi live session add karen (if courseId provided)
//     if (courseId) {
//       await mongoose.model("Course").findByIdAndUpdate(
//         courseId,
//         { $push: { liveSessions: liveSession._id } },
//         { new: true }
//       );
//     }

//     const whiteboard = await whiteBoardModel.create({
//       whiteboardId: uuidv4(),
//       title,
//       description: description || "",
//       createdBy: mentorId,
//       createdByRole: ROLE_MAP.STREAMER,
//       liveSessionId: liveSession._id,
//       participants: [{
//         user: mentorId,
//         role: "owner",
//         joinedAt: new Date(),
//         lastActive: new Date(),
//         cursorPosition: {}
//       }]
//     });

//     liveSession.whiteboardId = whiteboard._id;
//     await liveSession.save();

//     scheduleSessionAutoEnd(liveSession._id, endTime);

//     io.emit("session_started", {
//       sessionId,
//       mentorId,
//       title,
//       roomCode,
//       courseId: courseId || null,
//       maxParticipants,
//       whiteboardId: whiteboard._id,
//     });

//     return sendSuccessResponse(res, liveSession, successEn.LIVE_SESSION_CREATED, HttpStatus.CREATED);

//   } catch (error) {
//     console.error("Start LiveSession Error:", error.message);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// export const startLiveSessionRecording = async (req, res) => {
//   try {
//     const { sessionId } = req.params;
//     const userId = req.tokenData?.userId;

//     if (!sessionId) {
//       return sendErrorResponse(res, "SessionId is required", HttpStatus.BAD_REQUEST);
//     }

//     const state = roomState.get(sessionId);
//     if (!state || !state.router) {
//       return sendErrorResponse(
//         res,
//         "Session not ready for recording",
//         HttpStatus.BAD_REQUEST
//       );
//     }

//     // 🔐 Optional: only streamer can start recording
//     if (state.createdBy?.toString() !== userId) {
//       return sendErrorResponse(res, "Unauthorized", HttpStatus.UNAUTHORIZED);
//     }

//     await startLiveRecording({
//       state,
//       router: state.router,
//       sessionId,
//     });

//     return sendSuccessResponse(
//       res,
//       null,
//       "Live session recording started successfully",
//       HttpStatus.OK
//     );

//   } catch (error) {
//     console.error("🔥 startLiveSessionRecording error:", error.message);
//     return sendErrorResponse(
//       res,
//       "Failed to start recording",
//       HttpStatus.INTERNAL_SERVER_ERROR
//     );
//   }
// };


// export const stopLiveSessionRecording = async (req, res) => {
//   try {
//     const { sessionId } = req.params;
//     const userId = req.tokenData?.userId;

//     if (!sessionId) {
//       return sendErrorResponse(res, "SessionId required", HttpStatus.BAD_REQUEST);
//     }

//     const state = roomState.get(sessionId);
//     if (!state?.recording?.ffmpegProcess) {
//       return sendErrorResponse(res, "Recording not running", HttpStatus.BAD_REQUEST);
//     }

//     // 🔐 only streamer can stop recording
//     if (state.createdBy?.toString() !== userId) {
//       return sendErrorResponse(res, "Unauthorized", HttpStatus.UNAUTHORIZED);
//     }

//     // stop ffmpeg safely
//     state.recording.ffmpegProcess.kill("SIGINT");

//     // upload after process ends
//     await uploadToS3(state.recording.filePath, sessionId);

//     // cleanup
//     state.recording.ffmpegProcess = null;
//     state.recording.videoConsumer = null;
//     state.recording.audioConsumers = [];

//     return sendSuccessResponse(
//       res,
//       null,
//       "Recording stopped & uploaded successfully",
//       HttpStatus.OK
//     );

//   } catch (error) {
//     console.error("🔥 stopLiveSessionRecording error:", error.message);
//     return sendErrorResponse(
//       res,
//       "Failed to stop recording",
//       HttpStatus.INTERNAL_SERVER_ERROR
//     );
//   }
// };

// /**
//  * ✅ Get All Live Sessions of Current User Only
//  */
// export const getAllLiveSessions = async (req, res) => {
//     try {
//         const userId = req.tokenData?.userId;
//         const userRole = req.tokenData?.role;

//         if (!userId || !userRole) {
//             return sendErrorResponse(res, "Unauthorized: missing credentials", 401);
//         }

//         let filter = {};
//         if (userRole === ROLE_MAP.STREAMER) {
//             filter.streamerId = userId;
//         } else {
//             filter.status = "ACTIVE";
//         }

//         const liveSessions = await liveSessionModel
//             .find(filter)
//             .populate("streamerId", "name email role profilePic")
//             .populate("courseId") // 🔹 SIRF YEH - sare fields automatically aa jayenge
//             .populate("participants", "name email role profilePic")
//             .populate({
//                 path: "whiteboardId",
//                 populate: { path: "participants", select: "name email role profilePic" }
//             })
//             .sort({ createdAt: -1 });

//         // 🔹 Expired sessions filter
//         const sessionsFiltered = liveSessions.map(session => {
//             const sessionObj = session.toObject();
//             if (session.status === "ENDED" || (session.endTime && new Date() > new Date(session.endTime))) {
//                 return { ...sessionObj, expired: true };
//             }
//             return sessionObj;
//         });

//         return sendSuccessResponse(
//             res,
//             sessionsFiltered,
//             userRole === ROLE_MAP.STREAMER ? "Your live sessions fetched successfully" : "All live sessions fetched successfully",
//             200
//         );

//     } catch (error) {
//         console.error("getAllLiveSessions Error:", error.message);
//         return sendErrorResponse(res, "Internal server error", 500);
//     }
// };

// // 🔹 New Controller: Get Live Sessions by Course
// export const getLiveSessionsByCourse = async (req, res) => {
//     try {
//         const { courseId } = req.params;
//         const userId = req.tokenData?.userId;

//         if (!courseId) {
//             return sendErrorResponse(res, "Course ID is required", 400);
//         }

//         // Verify user has access to this course
//         const course = await mongoose.model("Course").findOne({
//             _id: courseId,
//             $or: [
//                 { createdBy: userId }, // Course creator
//                 { enrolledUsers: userId } // Enrolled student
//             ]
//         });

//         if (!course) {
//             return sendErrorResponse(res, "Course not found or access denied", 404);
//         }

//         const liveSessions = await liveSessionModel
//             .find({ courseId, status: { $in: ["ACTIVE", "SCHEDULED"] } })
//             .populate("streamerId", "name email role profilePic")
//             .populate("courseId", "title thumbnail category")
//             .populate("participants", "name email role profilePic")
//             .sort({ actualStartTime: -1 });

//         return sendSuccessResponse(res, liveSessions, "Course live sessions fetched successfully", 200);

//     } catch (error) {
//         console.error("getLiveSessionsByCourse Error:", error.message);
//         return sendErrorResponse(res, "Internal server error", 500);
//     }
// };

// /** Pause Live Session */
// export const pauseLiveSession = async (req, res) => {
//   try {
//     const io = getIO();
//     const { sessionId } = req.params;
//     const mentorId = req.tokenData?.userId;

//     if (!sessionId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

//     const session = await liveSessionModel.findOne({ sessionId });
//     if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
//     if (session.streamerId.toString() !== mentorId) return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.UNAUTHORIZED);

//     if (session.actualStartTime) session.totalActiveDuration += Math.floor((Date.now() - session.actualStartTime.getTime()) / 1000);
//     session.status = "PAUSED";
//     await session.save();

//     io.to(sessionId).emit("session_paused", { sessionId });
//     return sendSuccessResponse(res, session, "Live session paused successfully", HttpStatus.OK);
//   } catch (error) {
//     console.error("pauseLiveSession Error:", error.message);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // =========================
// // Resume Live Session

// export const resumeLiveSession = async (req, res) => {
//   try {
//     const io = getIO();
//     const { sessionId } = req.params;
//     const mentorId = req.tokenData?.userId;

//     if (!sessionId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

//     const session = await liveSessionModel.findOne({ sessionId });
//     if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
//     if (session.streamerId.toString() !== mentorId) return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.UNAUTHORIZED);

//     session.status = "ACTIVE";
//     session.actualStartTime = new Date();
//     await session.save();

//     io.to(sessionId).emit("session_resumed", { sessionId });
//     return sendSuccessResponse(res, session, "Live session resumed successfully", HttpStatus.OK);
//   } catch (error) {
//     console.error("resumeLiveSession Error:", error.message);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // =========================
// // Save Whiteboard Recording
// // =========================
// /** Save Whiteboard Recording */
// export const saveWhiteboardRecording = async (req, res) => {
//   try {
//     const { whiteboardId } = req.params;
//     const uploadedBy = req.tokenData?.userId;

//     if (!whiteboardId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

//     const whiteboard = await whiteBoardModel.findById(whiteboardId);
//     if (!whiteboard) return sendErrorResponse(res, errorEn.WHITEBOARD_NOT_FOUND, HttpStatus.NOT_FOUND);

//     const safeJsonParse = (str, defaultVal) => {
//       try { return JSON.parse(str); } catch { return defaultVal; }
//     };
//     const filesFromBody = safeJsonParse(req.body.files, []);

//     const buildUploadedFiles = (fileEntries = [], uploaderId) => {
//       if (!Array.isArray(fileEntries) || fileEntries.length === 0) return [];
//       return fileEntries.map(f => ({
//         fileName: f.originalname,
//         fileUrl: f.location || f.path,
//         fileType: f.mimetype,
//         uploadedBy: uploaderId,
//         uploadedAt: new Date(),
//       }));
//     };

//     const uploadedFiles = [
//       ...buildUploadedFiles(req.files?.recordingUrl, uploadedBy),
//       ...buildUploadedFiles(req.files?.file, uploadedBy)
//     ];

//     const mergedFiles = Array.isArray(filesFromBody) ? [...filesFromBody, ...uploadedFiles] : uploadedFiles;
//     if (mergedFiles.length === 0) return sendErrorResponse(res, errorEn.NO_FILES, HttpStatus.BAD_REQUEST);

//     mergedFiles.forEach(file => whiteboard.recordingUrl.push({
//       fileName: file.fileName || "unknown",
//       fileUrl: file.fileUrl,
//       fileType: file.fileType || "unknown",
//       uploadedBy
//     }));

//     await whiteboard.save();
//     return sendSuccessResponse(res, whiteboard, successEn.WHITEBOARD_RECORDING_SAVED, HttpStatus.OK);

//   } catch (error) {
//     console.error("saveWhiteboardRecording error:", error.message);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // =========================
// // Get Session Analytics
// // =========================
// export const getSessionAnalytics = async (req, res) => {
//     try {
//         const { sessionId } = req.params;

//         const session = await liveSessionModel.findOne({ sessionId }).populate("participants", "name email role");
//         if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

//         const analytics = {
//             totalJoins: session.totalJoins || session.participants.length,
//             peakParticipants: session.peakParticipants || session.participants.length,
//             duration: session.duration || (session.endTime && session.actualStartTime ? Math.floor((session.endTime - session.actualStartTime) / 60000) : 0),
//         };

//         return sendSuccessResponse(res, analytics, "Session analytics fetched", HttpStatus.OK);
//     } catch (error) {
//         console.error(error.message);
//         return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//     }
// };


// export const endLiveSession = async (req, res) => {
//   try {
//     const io = getIO();
//     const { sessionId } = req.params;
//     const userId = req.tokenData?.userId;

//     if (!sessionId) {
//       return sendErrorResponse(res, "All fields required", 400);
//     }

//     const liveSession = await liveSessionModel.findOne({ sessionId });
//     if (!liveSession) {
//       return sendErrorResponse(res, "Live session not found", 404);
//     }

//     if (liveSession.streamerId.toString() !== userId) {
//       return sendErrorResponse(res, "Unauthorized to end this session", 401);
//     }

//     // Final duration update
//     if (liveSession.actualStartTime) {
//       liveSession.totalActiveDuration += Math.floor((Date.now() - liveSession.actualStartTime.getTime()) / 1000);
//     }

//     liveSession.status = "ENDED";
//     liveSession.endTime = new Date();
//     await liveSession.save();

//     if (liveSession.whiteboardId) {
//       await whiteBoardModel.findByIdAndUpdate(liveSession.whiteboardId, {
//         $set: { status: "CLOSED" }
//       });
//     }

//     io.to(sessionId).emit("session_ended", {
//       sessionId,
//       message: "Live session has ended by the mentor."
//     });

//     // ✅ mediasoup transports cleanup
//     if (global.mediasoupRouters && global.mediasoupRouters[sessionId]) {
//       try { await global.mediasoupRouters[sessionId].close(); } catch {}
//       delete global.mediasoupRouters[sessionId];
//     }

//     return sendSuccessResponse(res, liveSession, "Live session ended successfully", 200);

//   } catch (error) {
//     console.error("🔥 endLiveSession error:", error.message);
//     return sendErrorResponse(res, "Internal server error", 500);
//   }
// };


// export const getSingleLiveSession = async (req, res) => {
//     try {
//         const { sessionId } = req.params;
//         if (!sessionId) {
//             return sendErrorResponse(res, "All fields required", 400);
//         }

//         const liveSession = await liveSessionModel
//             .findOne({ sessionId })
//             .populate("streamerId", "name email role profilePic")
//             .populate("courseId") // 🔹 SIRF YEH - sare course fields automatically aa jayenge
//             .populate("participants", "name email role profilePic")
//             .populate("allowedUsers", "name email role profilePic")
//             .populate({
//                 path: "whiteboardId",
//                 populate: { path: "participants", select: "name email role profilePic" }
//             })
//             .populate({
//                 path: "chatMessages",
//                 populate: { path: "senderId", select: "name email role profilePic" }
//             });

//         if (!liveSession) {
//             return sendErrorResponse(res, "Live session not found", 404);
//         }

//         // 🔹 Session expired check
//         if (liveSession.status === "ENDED" || (liveSession.endTime && new Date() > new Date(liveSession.endTime))) {
//             return sendErrorResponse(res, "This session has expired", 410); // 410 = Gone
//         }

//         return sendSuccessResponse(res, liveSession, "Live session fetched successfully", 200);

//     } catch (error) {
//         console.log(error.message);
//         return sendErrorResponse(res, "Internal server error", 500);
//     }
// };


// export const updateLiveSession = async (req, res) => {
//   try {
//     const { sessionId } = req.params;
//     const updateData = req.body;

//     if (!sessionId || Object.keys(updateData).length === 0) {
//       return sendErrorResponse(res, "All fields required", 400);
//     }

//     // Convert participants & allowedUsers to ObjectId
//     if (updateData.participants && Array.isArray(updateData.participants)) {
//       updateData.participants = updateData.participants.map(id => new mongoose.Types.ObjectId(id));
//     }

//     if (updateData.allowedUsers && Array.isArray(updateData.allowedUsers)) {
//       updateData.allowedUsers = updateData.allowedUsers.map(id => new mongoose.Types.ObjectId(id));
//     }

//     const updatedSession = await liveSessionModel
//       .findOneAndUpdate(
//         { sessionId },
//         { $set: updateData },
//         { new: true }
//       )
//       .populate("streamerId", "name email role profilePic")
//       .populate("participants", "name email role profilePic")
//       .populate("allowedUsers", "name email role profilePic")
//       .populate({
//         path: "whiteboardId",
//         populate: { path: "participants", select: "name email role profilePic" }
//       });

//     if (!updatedSession) return sendErrorResponse(res, "Live session not found", 404);

//     // Sync Whiteboard participants
//     if (updateData.participants && updatedSession.whiteboardId) {
//       await whiteBoardModel.findByIdAndUpdate(updatedSession.whiteboardId, {
//         $addToSet: { participants: { $each: updateData.participants } }
//       });
//     }

//     // Socket emit
//     const io = req.app.get("io");
//     if (io) io.to(updatedSession.roomCode).emit("liveSessionUpdated", updatedSession);

//     return sendSuccessResponse(res, updatedSession, "Live session updated successfully", 200);
//   } catch (error) {
//     console.log("🔥 updateLiveSession error:", error.message);
//     return sendErrorResponse(res, "Internal server error", 500);
//   }
// };

// // 🔹 Soft delete live session
// export const softDeleteLiveSession = async (req, res) => {
//   try {
//     const { sessionId } = req.params;
//     if (!sessionId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

//     const deletedSession = await liveSessionModel
//       .findOneAndUpdate(
//         { sessionId },
//         { $set: { isDeleted: true, status: "ENDED" } },
//         { new: true }
//       )
//       .populate("streamerId", "name email role profilePic")
//       .populate("participants", "name email role profilePic")
//       .populate("allowedUsers", "name email role profilePic")
//       .populate({
//         path: "whiteboardId",
//         populate: { path: "participants", select: "name email role profilePic" }
//       });

//     if (!deletedSession) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

//     if (deletedSession.whiteboardId) {
//       await whiteBoardModel.findByIdAndUpdate(deletedSession.whiteboardId, {
//         $set: { isDeleted: true, status: "ENDED" }
//       });
//     }

//     const io = req.app.get("io");
//     if (io) io.to(deletedSession.roomCode).emit("liveSessionDeleted", deletedSession);

//     return sendSuccessResponse(res, deletedSession, successEn.LIVE_SESSION_DELETED, HttpStatus.OK);
//   } catch (error) {
//     console.log(error.message);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // 🔹 Restore live session
// export const restoreLiveSession = async (req, res) => {
//   try {
//     const { sessionId } = req.params;
//     if (!sessionId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

//     const updatedSession = await liveSessionModel
//       .findOneAndUpdate(
//         { sessionId },
//         { $set: { isDeleted: false, status: "ACTIVE" } },
//         { new: true }
//       )
//       .populate("streamerId", "name email role profilePic")
//       .populate("participants", "name email role profilePic")
//       .populate("allowedUsers", "name email role profilePic")
//       .populate({
//         path: "whiteboardId",
//         populate: { path: "participants", select: "name email role profilePic" }
//       });

//     if (!updatedSession) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

//     if (updatedSession.whiteboardId) {
//       await whiteBoardModel.findByIdAndUpdate(updatedSession.whiteboardId, {
//         $set: { isDeleted: false, status: "ACTIVE" }
//       });
//     }

//     const io = req.app.get("io");
//     if (io) io.to(updatedSession.roomCode).emit("liveSessionRestored", updatedSession);

//     return sendSuccessResponse(res, updatedSession, successEn.LIVE_SESSION_RESTORED, HttpStatus.OK);
//   } catch (error) {
//     console.log(error.message);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };












import mongoose from "mongoose";
import HttpStatus from "http-status-codes";
import { v4 as uuidv4 } from "uuid";
import liveSessionModel from "../../model/liveSessions/liveeSession.model.js";
import whiteBoardModel from "../../model/whiteBoards/whiteBoard.model.js";
import * as startLiveRecording from "../../services/recording/liveSessionRecording.service.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { getIO } from "../../services/socket.integrated.js"; 
import { ROLE_MAP } from "../../constant/role.js";
import { roomState } from "../../services/socketState/roomState.js";
import { uploadSessionRecording, deleteFileFromS3 } from "../../middleware/aws.s3.js";

/**
 * Start Live Session
 */
// 🔹 Helper: secure random alphanumeric roomCode
/** Helper: Generate secure 6-char roomCode */
const generateRoomCode = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

/** Schedule session auto-end */
const scheduleSessionAutoEnd = (sessionId, endTime) => {
  if (!endTime) return;
  const delay = new Date(endTime).getTime() - Date.now();
  if (delay <= 0) return;

  setTimeout(async () => {
    try {
      const io = getIO();
      const session = await liveSessionModel.findOne({ _id: sessionId, status: "ACTIVE" });
      if (!session) return;

      session.status = "ENDED";
      session.endTime = new Date();
      await session.save();

      if (session.whiteboardId) {
        await whiteBoardModel.findByIdAndUpdate(session.whiteboardId, { $set: { status: "CLOSED" } });
      }

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

/** Start Live Session */
export const startLiveSession = async (req, res) => {
  try {
    const io = getIO(); 
    const { title, description, endTime, maxParticipants, isPrivate, courseId } = req.body;
    const mentorId = req.tokenData?.userId;

    if (!mentorId || !title) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    // 🔹 SIMPLE VERSION: Bas course existence check karen
    if (courseId) {
      const course = await mongoose.model("Course").findById(courseId);
      if (!course) {
        return sendErrorResponse(res, "Course not found", HttpStatus.NOT_FOUND);
      }
      // 🔹 Ownership check REMOVE kiya - koi bhi mentor kisi bhi course ke liye session bana sakta hai
    }

    const roomCode = generateRoomCode();
    const existingSession = await liveSessionModel.findOne({ roomCode, status: "ACTIVE" });
    if (existingSession) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_ALREADY_EXISTS, HttpStatus.CONFLICT);
    }

    const sessionId = uuidv4();
    const joinLink = `${process.env.FRONTEND_URL}/live/${roomCode}`; // ✅ Join link generate
    
    const liveSession = await liveSessionModel.create({
      streamerId: mentorId,
      streamerRole: ROLE_MAP.STREAMER,
      sessionId,
      roomCode,
      joinLink, // ✅ Join link save
      title,
      description: description || "",
      courseId: courseId || null,
      actualStartTime: new Date(),
      endTime,
      participants: [],
      allowedUsers: [],
      chatMessages: [],
      recordingUrl: [], // ✅ Now an empty array instead of string
      maxParticipants: maxParticipants || 100,
      isPrivate: isPrivate || false,
      status: "ACTIVE",
      totalActiveDuration: 0
    });

    // 🔹 Course mein bhi live session add karen (if courseId provided)
    if (courseId) {
      await mongoose.model("Course").findByIdAndUpdate(
        courseId,
        { $push: { liveSessions: liveSession._id } },
        { new: true }
      );
    }

    const whiteboard = await whiteBoardModel.create({
      whiteboardId: uuidv4(),
      title,
      description: description || "",
      createdBy: mentorId,
      createdByRole: ROLE_MAP.STREAMER,
      liveSessionId: liveSession._id,
      participants: [{
        user: mentorId,
        role: "owner",
        joinedAt: new Date(),
        lastActive: new Date(),
        cursorPosition: {}
      }]
    });

    liveSession.whiteboardId = whiteboard._id;
    await liveSession.save();

    scheduleSessionAutoEnd(liveSession._id, endTime);

    io.emit("session_started", {
      sessionId,
      mentorId,
      title,
      roomCode,
      courseId: courseId || null,
      maxParticipants,
      whiteboardId: whiteboard._id,
      joinLink // ✅ Join link emit
    });

    return sendSuccessResponse(res, liveSession, successEn.LIVE_SESSION_CREATED, HttpStatus.CREATED);

  } catch (error) {
    console.error("Start LiveSession Error:", error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


export const startLiveSessionRecording = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;

    if (!sessionId) {
      return sendErrorResponse(res, "SessionId is required", HttpStatus.BAD_REQUEST);
    }

    const state = roomState.get(sessionId);
    if (!state || !state.router) {
      return sendErrorResponse(
        res,
        "Session not ready for recording",
        HttpStatus.BAD_REQUEST
      );
    }

    // 🔐 Optional: only streamer can start recording
    if (state.createdBy?.toString() !== userId) {
      return sendErrorResponse(res, "Unauthorized", HttpStatus.UNAUTHORIZED);
    }

    await startLiveRecording({
      state,
      router: state.router,
      sessionId,
    });

    return sendSuccessResponse(
      res,
      null,
      "Live session recording started successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 startLiveSessionRecording error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to start recording",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

export const stopLiveSessionRecording = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;

    if (!sessionId) {
      return sendErrorResponse(res, "SessionId required", HttpStatus.BAD_REQUEST);
    }

    const state = roomState.get(sessionId);
    if (!state?.recording?.ffmpegProcess) {
      return sendErrorResponse(res, "Recording not running", HttpStatus.BAD_REQUEST);
    }

    // 🔐 only streamer can stop recording
    if (state.createdBy?.toString() !== userId) {
      return sendErrorResponse(res, "Unauthorized", HttpStatus.UNAUTHORIZED);
    }

    // Calculate recording duration
    const recordingStartTime = state.recording.startTime || new Date();
    const recordingDuration = Math.floor((Date.now() - recordingStartTime) / 1000); // seconds

    // stop ffmpeg safely
    state.recording.ffmpegProcess.kill("SIGINT");

    // wait for file to be finalized
    await new Promise(resolve => setTimeout(resolve, 2000));

    // upload to S3
    const uploadResult = await uploadSessionRecording(state.recording.filePath, sessionId);

    // ✅ DB में recording details save करें
    const uploadedRecording = {
      fileUrl: uploadResult.fileUrl,
      fileName: `${sessionId}_${Date.now()}.mp4`,
      fileType: "video/mp4",
      recordedAt: new Date(),
      duration: recordingDuration,
      recordedBy: userId
    };

    // 🔹 DB me push karo
    await liveSessionModel.findOneAndUpdate(
      { sessionId },
      {
        $push: { recordingUrl: uploadedRecording }
      }
    );

    // cleanup
    state.recording.ffmpegProcess = null;
    state.recording.videoConsumer = null;
    state.recording.audioConsumers = [];

    return sendSuccessResponse(
      res,
      uploadedRecording,
      "Recording stopped & uploaded successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 stopLiveSessionRecording error:", error.message);
    
    // Rollback cleanup
    const state = roomState.get(sessionId);
    if (state?.recording?.ffmpegProcess) {
      state.recording.ffmpegProcess = null;
      state.recording.videoConsumer = null;
      state.recording.audioConsumers = [];
    }
    
    return sendErrorResponse(
      res,
      "Failed to stop recording",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

/**
 * ✅ Get All Live Sessions of Current User Only
 */
export const getAllLiveSessions = async (req, res) => {
    try {
        const userId = req.tokenData?.userId;
        const userRole = req.tokenData?.role;

        if (!userId || !userRole) {
            return sendErrorResponse(res, "Unauthorized: missing credentials", 401);
        }

        let filter = {};
        if (userRole === ROLE_MAP.STREAMER) {
            filter.streamerId = userId;
        } else {
            filter.status = "ACTIVE";
        }

        const liveSessions = await liveSessionModel
            .find(filter)
            .populate("streamerId", "name email role profilePic")
            .populate("courseId")
            .populate("participants", "name email role profilePic")
            .populate({
                path: "whiteboardId",
                populate: { path: "participants", select: "name email role profilePic" }
            })
            .sort({ createdAt: -1 });

        // 🔹 Expired sessions filter
        const sessionsFiltered = liveSessions.map(session => {
            const sessionObj = session.toObject();
            if (session.status === "ENDED" || (session.endTime && new Date() > new Date(session.endTime))) {
                return { ...sessionObj, expired: true };
            }
            return sessionObj;
        });

        return sendSuccessResponse(
            res,
            sessionsFiltered,
            userRole === ROLE_MAP.STREAMER ? "Your live sessions fetched successfully" : "All live sessions fetched successfully",
            200
        );

    } catch (error) {
        console.error("getAllLiveSessions Error:", error.message);
        return sendErrorResponse(res, "Internal server error", 500);
    }
};

/**
 * ✅ Get Live Session Recordings
 */
export const getLiveSessionRecordings = async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return sendErrorResponse(res, "SessionId required", 400);
    }

    const session = await liveSessionModel
      .findOne({ sessionId })
      .select("recordingUrl title streamerId status sessionId roomCode")
      .populate("streamerId", "name email role profilePic");

    if (!session) {
      return sendErrorResponse(res, "Live session not found", 404);
    }

    return sendSuccessResponse(
      res,
      {
        sessionId,
        title: session.title,
        streamer: session.streamerId,
        status: session.status,
        roomCode: session.roomCode,
        recordings: session.recordingUrl || []
      },
      "Live session recordings fetched successfully",
      200
    );

  } catch (error) {
    console.error("🔥 getLiveSessionRecordings error:", error.message);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

/**
 * ✅ Get All Recordings of Streamer
 */
export const getMyLiveSessionRecordings = async (req, res) => {
  try {
    const userId = req.tokenData?.userId;

    const sessions = await liveSessionModel
      .find({ 
        streamerId: userId, 
        recordingUrl: { $exists: true, $ne: [] } 
      })
      .select("sessionId title recordingUrl createdAt roomCode")
      .sort({ createdAt: -1 });

    // Format the response
    const formattedResponse = sessions.map(session => ({
      sessionId: session.sessionId,
      title: session.title,
      roomCode: session.roomCode,
      createdAt: session.createdAt,
      recordings: session.recordingUrl,
      totalRecordings: session.recordingUrl?.length || 0
    }));

    return sendSuccessResponse(
      res,
      formattedResponse,
      "Your live session recordings fetched successfully",
      200
    );

  } catch (error) {
    console.error("🔥 getMyLiveSessionRecordings error:", error.message);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

// 🔹 New Controller: Get Live Sessions by Course
export const getLiveSessionsByCourse = async (req, res) => {
    try {
        const { courseId } = req.params;
        const userId = req.tokenData?.userId;

        if (!courseId) {
            return sendErrorResponse(res, "Course ID is required", 400);
        }

        // Verify user has access to this course
        const course = await mongoose.model("Course").findOne({
            _id: courseId,
            $or: [
                { createdBy: userId }, // Course creator
                { enrolledUsers: userId } // Enrolled student
            ]
        });

        if (!course) {
            return sendErrorResponse(res, "Course not found or access denied", 404);
        }

        const liveSessions = await liveSessionModel
            .find({ courseId, status: { $in: ["ACTIVE", "SCHEDULED"] } })
            .populate("streamerId", "name email role profilePic")
            .populate("courseId", "title thumbnail category")
            .populate("participants", "name email role profilePic")
            .sort({ actualStartTime: -1 });

        return sendSuccessResponse(res, liveSessions, "Course live sessions fetched successfully", 200);

    } catch (error) {
        console.error("getLiveSessionsByCourse Error:", error.message);
        return sendErrorResponse(res, "Internal server error", 500);
    }
};

/** Pause Live Session */
export const pauseLiveSession = async (req, res) => {
  try {
    const io = getIO();
    const { sessionId } = req.params;
    const mentorId = req.tokenData?.userId;

    if (!sessionId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
    if (session.streamerId.toString() !== mentorId) return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.UNAUTHORIZED);

    if (session.actualStartTime) session.totalActiveDuration += Math.floor((Date.now() - session.actualStartTime.getTime()) / 1000);
    session.status = "PAUSED";
    await session.save();

    io.to(sessionId).emit("session_paused", { sessionId });
    return sendSuccessResponse(res, session, "Live session paused successfully", HttpStatus.OK);
  } catch (error) {
    console.error("pauseLiveSession Error:", error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// =========================
// Resume Live Session
export const resumeLiveSession = async (req, res) => {
  try {
    const io = getIO();
    const { sessionId } = req.params;
    const mentorId = req.tokenData?.userId;

    if (!sessionId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
    if (session.streamerId.toString() !== mentorId) return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.UNAUTHORIZED);

    session.status = "ACTIVE";
    session.actualStartTime = new Date();
    await session.save();

    io.to(sessionId).emit("session_resumed", { sessionId });
    return sendSuccessResponse(res, session, "Live session resumed successfully", HttpStatus.OK);
  } catch (error) {
    console.error("resumeLiveSession Error:", error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// =========================
// Save Whiteboard Recording
// =========================
/** Save Whiteboard Recording */
export const saveWhiteboardRecording = async (req, res) => {
  try {
    const { whiteboardId } = req.params;
    const uploadedBy = req.tokenData?.userId;

    if (!whiteboardId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

    const whiteboard = await whiteBoardModel.findById(whiteboardId);
    if (!whiteboard) return sendErrorResponse(res, errorEn.WHITEBOARD_NOT_FOUND, HttpStatus.NOT_FOUND);

    const safeJsonParse = (str, defaultVal) => {
      try { return JSON.parse(str); } catch { return defaultVal; }
    };
    const filesFromBody = safeJsonParse(req.body.files, []);

    const buildUploadedFiles = (fileEntries = [], uploaderId) => {
      if (!Array.isArray(fileEntries) || fileEntries.length === 0) return [];
      return fileEntries.map(f => ({
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

    const mergedFiles = Array.isArray(filesFromBody) ? [...filesFromBody, ...uploadedFiles] : uploadedFiles;
    if (mergedFiles.length === 0) return sendErrorResponse(res, errorEn.NO_FILES, HttpStatus.BAD_REQUEST);

    mergedFiles.forEach(file => whiteboard.recordingUrl.push({ 
      fileName: file.fileName || "unknown",
      fileUrl: file.fileUrl,
      fileType: file.fileType || "unknown",
      uploadedBy
    }));

    await whiteboard.save();
    return sendSuccessResponse(res, whiteboard, successEn.WHITEBOARD_RECORDING_SAVED, HttpStatus.OK);

  } catch (error) {
    console.error("saveWhiteboardRecording error:", error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
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
            totalRecordings: session.recordingUrl?.length || 0,
            totalRecordingDuration: session.recordingUrl?.reduce((total, rec) => total + (rec.duration || 0), 0) || 0
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
            .findOne({ sessionId })
            .populate("streamerId", "name email role profilePic")
            .populate("courseId")
            .populate("participants", "name email role profilePic")
            .populate("allowedUsers", "name email role profilePic")
            .populate({
                path: "whiteboardId",
                populate: { path: "participants", select: "name email role profilePic" }
            })
            .populate({
                path: "chatMessages",
                populate: { path: "senderId", select: "name email role profilePic" }
            });

        if (!liveSession) {
            return sendErrorResponse(res, "Live session not found", 404);
        }

        // 🔹 Session expired check
        if (liveSession.status === "ENDED" || (liveSession.endTime && new Date() > new Date(liveSession.endTime))) {
            return sendErrorResponse(res, "This session has expired", 410); // 410 = Gone
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

// 🔹 Delete a specific recording from session
export const deleteSessionRecording = async (req, res) => {
  try {
    const { sessionId, recordingIndex } = req.params;
    const userId = req.tokenData?.userId;

    if (!sessionId || recordingIndex === undefined) {
      return sendErrorResponse(res, "SessionId and recording index required", 400);
    }

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) {
      return sendErrorResponse(res, "Live session not found", 404);
    }

    // Check if user is streamer
    if (session.streamerId.toString() !== userId) {
      return sendErrorResponse(res, "Unauthorized to delete recording", 401);
    }

    // Check if recording exists at index
    if (!session.recordingUrl || session.recordingUrl.length <= recordingIndex) {
      return sendErrorResponse(res, "Recording not found", 404);
    }

    const recordingToDelete = session.recordingUrl[recordingIndex];
    
    // Delete from S3
    await deleteFileFromS3(recordingToDelete.fileUrl);
    
    // Remove from array
    session.recordingUrl.splice(recordingIndex, 1);
    await session.save();

    return sendSuccessResponse(
      res,
      { deletedRecording: recordingToDelete },
      "Recording deleted successfully",
      200
    );

  } catch (error) {
    console.error("🔥 deleteSessionRecording error:", error.message);
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