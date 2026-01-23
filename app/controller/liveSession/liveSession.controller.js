// controller/common/file.controller.js
import mongoose from "mongoose";
import HttpStatus from "http-status-codes";
import { v4 as uuidv4 } from "uuid";
import liveSessionModel from "../../model/liveSessions/liveeSession.model.js";
import whiteBoardModel from "../../model/whiteBoards/whiteBoard.model.js";
import { startLiveRecording } from "../../services/recording/liveSessionRecording.service.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { getIO } from "../../services/socket.integrated.js";
import { ROLE_MAP } from "../../constant/role.js";
import { roomState } from "../../services/socketState/roomState.js";
import { waitForFFmpegExit } from "../../services/recording/ffmpegRunner.js";
import { deleteFileFromS3 } from "../../middleware/aws.s3.js"; // ✅ ADD THIS IMPORT

// =====================================================
// HELPERS
// =====================================================
const generateRoomCode = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
};

const scheduleSessionAutoEnd = (sessionId, endTime) => {
  if (!endTime) return;
  const delay = new Date(endTime).getTime() - Date.now();
  if (delay <= 0) return;

  setTimeout(async () => {
    try {
      const io = getIO();
      const session = await liveSessionModel.findOne({
        _id: sessionId,
        status: "ACTIVE"
      });
      if (!session) return;

      session.status = "ENDED";
      session.endTime = new Date();
      await session.save();

      if (session.whiteboardId) {
        await whiteBoardModel.findByIdAndUpdate(
          session.whiteboardId,
          { $set: { status: "CLOSED" } }
        );
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

// =====================================================
// START LIVE SESSION
// =====================================================
export const startLiveSession = async (req, res) => {
  try {
    const io = getIO();
    const { title, description, endTime, maxParticipants, isPrivate, courseId } =
      req.body;
    const mentorId = req.tokenData?.userId;

    if (!mentorId || !title) {
      return sendErrorResponse(
        res,
        errorEn.ALL_FIELDS_REQUIRED,
        HttpStatus.BAD_REQUEST
      );
    }

    if (courseId) {
      const course = await mongoose.model("Course").findById(courseId);
      if (!course) {
        return sendErrorResponse(res, "Course not found", HttpStatus.NOT_FOUND);
      }
    }

    const roomCode = generateRoomCode();
    const sessionId = uuidv4();
    const joinLink = `${process.env.FRONTEND_URL}/live/${roomCode}`;

    const liveSession = await liveSessionModel.create({
      streamerId: mentorId,
      streamerRole: ROLE_MAP.STREAMER,
      sessionId,
      roomCode,
      joinLink,
      title,
      description: description || "",
      courseId: courseId || null,
      actualStartTime: new Date(),
      endTime,
      participants: [],
      allowedUsers: [],
      chatMessages: [],
      recordingUrl: [],
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

    scheduleSessionAutoEnd(liveSession._id, endTime);

    io.emit("session_started", {
      sessionId,
      mentorId,
      title,
      roomCode,
      courseId: courseId || null,
      maxParticipants,
      whiteboardId: whiteboard._id,
      joinLink
    });

    return sendSuccessResponse(
      res,
      liveSession,
      successEn.LIVE_SESSION_CREATED,
      HttpStatus.CREATED
    );
  } catch (error) {
    console.error("Start LiveSession Error:", error.message);
    return sendErrorResponse(
      res,
      errorEn.INTERNAL_SERVER_ERROR,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

// =====================================================
// START RECORDING
// =====================================================
export const startLiveSessionRecording = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;

    if (!sessionId) {
      return sendErrorResponse(
        res,
        "SessionId is required",
        HttpStatus.BAD_REQUEST
      );
    }

    const state = roomState.get(sessionId);
    if (!state || !state.router) {
      return sendErrorResponse(
        res,
        "Session not ready for recording",
        HttpStatus.BAD_REQUEST
      );
    }

    if (state.createdBy?.toString() !== userId) {
      return sendErrorResponse(res, "Unauthorized", HttpStatus.UNAUTHORIZED);
    }

    if (state.recording?.active) {
      return sendErrorResponse(
        res,
        "Recording already running",
        HttpStatus.BAD_REQUEST
      );
    }

    // ✅ CORRECT VIDEO CHECK (FIX)
    const hasVideoProducer = Array.from(state.producers?.values() || []).some(
      (p) => p.kind === "video" && !p.closed
    );

    if (!hasVideoProducer) {
      return sendErrorResponse(
        res,
        "Video is not live yet. Please turn on camera.",
        HttpStatus.BAD_REQUEST
      );
    }

    console.log("🎬 Starting live session recording...");

    const recordingState = await startLiveRecording({
      state,
      router: state.router,
      sessionId
    });

    return sendSuccessResponse(
      res,
      {
        sessionId,
        startTime: recordingState.startTime,
        active: recordingState.active
      },
      "Live session recording started successfully",
      HttpStatus.OK
    );
  } catch (error) {
    console.error("🔥 startLiveSessionRecording error:", error.message);
    return sendErrorResponse(
      res,
      `Failed to start recording: ${error.message}`,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

// =====================================================
// STOP RECORDING (UPDATED – DB SAVE FIXED)
// =====================================================
export const stopLiveSessionRecording = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const state = roomState.get(sessionId);

    if (!state || !state.recording || !state.recording.ffmpegProcess) {
      return sendErrorResponse(
        res,
        "No active recording found",
        HttpStatus.BAD_REQUEST
      );
    }

    const recording = state.recording;

    // 🔒 Prevent double stop
    if (!recording.active) {
      return sendErrorResponse(
        res,
        "Recording already stopped",
        HttpStatus.BAD_REQUEST
      );
    }

    console.log("🛑 Stopping live recording...");

    // 🔥 Mark inactive early
    recording.active = false;

    // 1️⃣ Stop FFmpeg gracefully
    try {
      if (!recording.ffmpegProcess.killed) {
        recording.ffmpegProcess.kill("SIGINT");
        await waitForFFmpegExit(recording.ffmpegProcess);
      }
    } catch (err) {
      console.warn("⚠️ FFmpeg stop warning:", err.message);
    }

    // 2️⃣ Close mediasoup resources
    try { recording.videoConsumer?.close(); } catch {}
    if (Array.isArray(recording.audioConsumers)) {
      recording.audioConsumers.forEach((c) => {
        try { c.close(); } catch {}
      });
    }

    try { recording.videoTransport?.close(); } catch {}
    if (Array.isArray(recording.audioTransports)) {
      recording.audioTransports.forEach((t) => {
        try { t.close(); } catch {}
      });
    }

    // 3️⃣ Wait for upload result (S3 upload)
    let uploadResult = null;
    try {
      if (recording.recordingPromise) {
        uploadResult = await recording.recordingPromise;
      }
    } catch (err) {
      console.error("🔥 Upload failed:", err.message);
    }

    // 4️⃣ ✅ SAVE RECORDING INTO DB (🔥 MAIN FIX 🔥)
    if (uploadResult?.fileUrl) {
      await liveSessionModel.findOneAndUpdate(
        { sessionId },
        {
          $push: {
            recordingUrl: {
              fileUrl: uploadResult.fileUrl,
              fileKey: uploadResult.fileKey || null,
              uploadedAt: new Date(),
              duration: uploadResult.duration || 0, // ✅ ADD DURATION
              fileSize: uploadResult.fileSize || 0, // ✅ ADD FILE SIZE
              status: "COMPLETED" // ✅ ADD STATUS
            }
          }
        }
      );
    }

    // 5️⃣ Reset recording state
    state.recording = {
      active: false,
      videoTransport: null,
      audioTransports: [],
      videoConsumer: null,
      audioConsumers: [],
      recordingPromise: null,
      startTime: null,
      ffmpegProcess: null,
      filePath: null
    };

    // 6️⃣ Emit socket event
    const io = getIO();
    io.to(sessionId).emit("recording_stopped", {
      sessionId,
      recordingUrl: uploadResult?.fileUrl || null,
      status: uploadResult?.fileUrl ? "SAVED" : "FAILED"
    });

    return sendSuccessResponse(
      res,
      {
        sessionId,
        recordingUrl: uploadResult?.fileUrl || null,
        duration: uploadResult?.duration || 0,
        fileSize: uploadResult?.fileSize || 0
      },
      uploadResult?.fileUrl
        ? "Recording stopped and saved successfully"
        : "Recording stopped but upload failed",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 stopLiveSessionRecording error:", error.message);
    return sendErrorResponse(
      res,
      error.message,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

// =====================================================
// ✅ GET ALL RECORDINGS WITH DETAILS (NEW & IMPROVED)
// =====================================================
export const getAllRecordingsDetailed = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    if (!sessionId) {
      return sendErrorResponse(res, "SessionId required", HttpStatus.BAD_REQUEST);
    }

    const session = await liveSessionModel
      .findOne({ sessionId })
      .populate("streamerId", "name email role profilePic")
      .populate("participants", "name email role profilePic")
      .lean();

    if (!session) {
      return sendErrorResponse(res, "Session not found", HttpStatus.NOT_FOUND);
    }

    // 🔐 Permission Check
    const isStreamer = session.streamerId._id.toString() === userId;
    const isAdmin = userRole === ROLE_MAP.ADMIN;
    const isParticipant = session.participants?.some(p => p._id.toString() === userId);

    let canViewRecordings = false;
    
    if (session.isPrivate) {
      // Private session: only streamer, admin, and participants
      canViewRecordings = isStreamer || isAdmin || isParticipant;
    } else {
      // Public session: all authenticated users
      canViewRecordings = true;
    }

    if (!canViewRecordings) {
      return sendErrorResponse(
        res,
        "You don't have permission to view recordings for this session",
        HttpStatus.FORBIDDEN
      );
    }

    // Format recordings with more details
    const formattedRecordings = (session.recordingUrl || []).map((rec, index) => ({
      recordingId: rec._id || `rec-${index}`,
      fileUrl: rec.fileUrl,
      fileName: rec.fileName || `recording-${index + 1}.mp4`,
      fileType: rec.fileType || "video/mp4",
      duration: rec.duration || 0,
      fileSize: rec.fileSize || 0,
      uploadedAt: rec.uploadedAt || rec.recordedAt || new Date(),
      status: rec.status || "COMPLETED",
      thumbnailUrl: rec.thumbnailUrl || "",
      s3Key: rec.fileKey || rec.s3Key || ""
    }));

    // Calculate statistics
    const statistics = {
      totalRecordings: formattedRecordings.length,
      totalDuration: formattedRecordings.reduce((sum, rec) => sum + (rec.duration || 0), 0),
      totalSize: formattedRecordings.reduce((sum, rec) => sum + (rec.fileSize || 0), 0),
      averageDuration: formattedRecordings.length > 0 
        ? Math.round(formattedRecordings.reduce((sum, rec) => sum + (rec.duration || 0), 0) / formattedRecordings.length)
        : 0
    };

    // Group by date
    const recordingsByDate = {};
    formattedRecordings.forEach(rec => {
      const date = new Date(rec.uploadedAt).toISOString().split('T')[0];
      if (!recordingsByDate[date]) {
        recordingsByDate[date] = [];
      }
      recordingsByDate[date].push(rec);
    });

    return sendSuccessResponse(
      res,
      {
        sessionId: session.sessionId,
        title: session.title,
        streamer: session.streamerId,
        status: session.status,
        roomCode: session.roomCode,
        isPrivate: session.isPrivate,
        createdAt: session.createdAt,
        
        // Recordings Data
        recordings: formattedRecordings,
        
        // Statistics
        statistics: statistics,
        
        // Grouped Data
        recordingsByDate: recordingsByDate,
        
        // User Permissions
        permissions: {
          canView: canViewRecordings,
          canDownload: isStreamer || isAdmin,
          canDelete: isStreamer || isAdmin,
          canShare: true
        },
        
        // Pagination Info
        pagination: {
          total: formattedRecordings.length,
          page: 1,
          limit: formattedRecordings.length,
          totalPages: 1
        }
      },
      "Session recordings fetched successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 getAllRecordingsDetailed error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to fetch recordings",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

// =====================================================
// ✅ GET LATEST RECORDING URL (IMPROVED)
// =====================================================
export const getLatestRecordingUrl = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;

    if (!sessionId) {
      return sendErrorResponse(res, "SessionId required", HttpStatus.BAD_REQUEST);
    }

    const session = await liveSessionModel
      .findOne({ sessionId })
      .select("recordingUrl title sessionId streamerId isPrivate status")
      .populate("streamerId", "name email")
      .lean();

    if (!session) {
      return sendErrorResponse(res, "Session not found", HttpStatus.NOT_FOUND);
    }

    // Check if session is private and user is authorized
    if (session.isPrivate && session.streamerId._id.toString() !== userId) {
      return sendErrorResponse(
        res,
        "You don't have permission to access this recording",
        HttpStatus.FORBIDDEN
      );
    }

    // Sort recordings by upload date (newest first)
    const sortedRecordings = (session.recordingUrl || [])
      .filter(rec => rec.fileUrl && rec.status !== "FAILED")
      .sort((a, b) => new Date(b.uploadedAt || b.recordedAt || 0) - new Date(a.uploadedAt || a.recordedAt || 0));

    const latestRecording = sortedRecordings.length > 0 ? sortedRecordings[0] : null;

    return sendSuccessResponse(
      res,
      {
        sessionId: session.sessionId,
        title: session.title,
        sessionStatus: session.status,
        hasRecordings: sortedRecordings.length > 0,
        
        latestRecording: latestRecording ? {
          fileUrl: latestRecording.fileUrl,
          fileName: latestRecording.fileName || "latest-recording.mp4",
          duration: latestRecording.duration || 0,
          fileSize: latestRecording.fileSize || 0,
          uploadedAt: latestRecording.uploadedAt || latestRecording.recordedAt,
          status: latestRecording.status || "COMPLETED"
        } : null,
        
        allRecordingsCount: sortedRecordings.length,
        totalDuration: sortedRecordings.reduce((sum, rec) => sum + (rec.duration || 0), 0)
      },
      latestRecording 
        ? "Latest recording fetched successfully" 
        : "No recordings found for this session",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 getLatestRecordingUrl error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to fetch recording URL",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

// =====================================================
// ✅ GET ALL LIVE SESSIONS (IMPROVED)
// =====================================================
export const getAllLiveSessions = async (req, res) => {
  try {
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;
    const { 
      page = 1, 
      limit = 10, 
      status, 
      courseId,
      withRecordings = false 
    } = req.query;

    if (!userId || !userRole) {
      return sendErrorResponse(res, "Unauthorized: missing credentials", 401);
    }

    let filter = {};
    
    // Role-based filtering
    if (userRole === ROLE_MAP.STREAMER) {
      filter.streamerId = userId;
    } else {
      filter.status = "ACTIVE";
    }

    // Additional filters
    if (status) filter.status = status;
    if (courseId) filter.courseId = courseId;
    if (withRecordings === 'true') {
      filter.recordingUrl = { $exists: true, $ne: [] };
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const liveSessions = await liveSessionModel
      .find(filter)
      .populate("streamerId", "name email role profilePic")
      .populate("courseId", "title thumbnail")
      .populate("participants", "name email role profilePic")
      .populate({
        path: "whiteboardId",
        populate: { path: "participants", select: "name email role profilePic" }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const totalSessions = await liveSessionModel.countDocuments(filter);

    // Format response with recording info
    const sessionsFiltered = liveSessions.map(session => {
      const sessionObj = session.toObject();
      
      // Check if session expired
      const isExpired = session.status === "ENDED" || 
                       (session.endTime && new Date() > new Date(session.endTime));
      
      // Recording statistics
      const recordingStats = {
        hasRecordings: session.recordingUrl?.length > 0,
        totalRecordings: session.recordingUrl?.length || 0,
        totalDuration: session.recordingUrl?.reduce((sum, rec) => sum + (rec.duration || 0), 0) || 0,
        latestRecording: session.recordingUrl?.length > 0 
          ? session.recordingUrl[session.recordingUrl.length - 1]
          : null
      };

      return { 
        ...sessionObj, 
        expired: isExpired,
        recordingStats,
        canAccess: userRole === ROLE_MAP.STREAMER || 
                  session.streamerId._id.toString() === userId ||
                  !session.isPrivate
      };
    });

    return sendSuccessResponse(
      res,
      {
        sessions: sessionsFiltered,
        pagination: {
          total: totalSessions,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(totalSessions / parseInt(limit)),
          hasNextPage: (parseInt(page) * parseInt(limit)) < totalSessions,
          hasPrevPage: parseInt(page) > 1
        },
        filters: {
          status,
          courseId,
          withRecordings,
          userRole
        }
      },
      userRole === ROLE_MAP.STREAMER 
        ? "Your live sessions fetched successfully" 
        : "All live sessions fetched successfully",
      200
    );

  } catch (error) {
    console.error("getAllLiveSessions Error:", error.message);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

// =====================================================
// ✅ GET LIVE SESSION RECORDINGS (IMPROVED)
// =====================================================
export const getLiveSessionRecordings = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    if (!sessionId) {
      return sendErrorResponse(res, "SessionId required", 400);
    }

    const session = await liveSessionModel
      .findOne({ sessionId })
      .select("recordingUrl title streamerId status sessionId roomCode isPrivate courseId participants")
      .populate("streamerId", "name email role profilePic")
      .populate("courseId", "title thumbnail")
      .populate("participants", "name email")
      .lean();

    if (!session) {
      return sendErrorResponse(res, "Live session not found", 404);
    }

    // Permission check
    const isStreamer = session.streamerId._id.toString() === userId;
    const isAdmin = userRole === ROLE_MAP.ADMIN;
    const isParticipant = session.participants?.some(p => p._id.toString() === userId);

    let canViewRecordings = false;
    
    if (session.isPrivate) {
      canViewRecordings = isStreamer || isAdmin || isParticipant;
    } else {
      canViewRecordings = true;
    }

    if (!canViewRecordings) {
      return sendErrorResponse(
        res,
        "You don't have permission to view recordings for this session",
        HttpStatus.FORBIDDEN
      );
    }

    // Format recordings
    const formattedRecordings = (session.recordingUrl || []).map((rec, index) => ({
      recordingId: rec._id || `rec-${index}`,
      fileUrl: rec.fileUrl,
      fileName: rec.fileName || `recording-${index + 1}.mp4`,
      duration: rec.duration || 0,
      fileSize: rec.fileSize || 0,
      uploadedAt: rec.uploadedAt || rec.recordedAt,
      status: rec.status || "COMPLETED",
      thumbnailUrl: rec.thumbnailUrl || "",
      s3Key: rec.fileKey || rec.s3Key || ""
    }));

    // Sort by date (newest first)
    formattedRecordings.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    return sendSuccessResponse(
      res,
      {
        sessionId: session.sessionId,
        title: session.title,
        streamer: session.streamerId,
        course: session.courseId,
        status: session.status,
        roomCode: session.roomCode,
        isPrivate: session.isPrivate,
        totalParticipants: session.participants?.length || 0,
        
        recordings: formattedRecordings,
        totalRecordings: formattedRecordings.length,
        totalDuration: formattedRecordings.reduce((sum, rec) => sum + (rec.duration || 0), 0),
        
        permissions: {
          canView: canViewRecordings,
          canDownload: isStreamer || isAdmin,
          canDelete: isStreamer || isAdmin,
          isStreamer: isStreamer,
          isAdmin: isAdmin,
          isParticipant: isParticipant
        },
        
        metadata: {
          createdAt: session.createdAt,
          lastRecording: formattedRecordings.length > 0 ? formattedRecordings[0].uploadedAt : null
        }
      },
      "Live session recordings fetched successfully",
      200
    );

  } catch (error) {
    console.error("🔥 getLiveSessionRecordings error:", error.message);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

// =====================================================
// ✅ GET ALL RECORDINGS OF STREAMER (IMPROVED)
// =====================================================
export const getMyLiveSessionRecordings = async (req, res) => {
  try {
    const userId = req.tokenData?.userId;
    const { 
      page = 1, 
      limit = 10, 
      courseId,
      sortBy = "newest",
      fromDate,
      toDate 
    } = req.query;

    if (!userId) {
      return sendErrorResponse(res, "Unauthorized", 401);
    }

    let filter = { 
      streamerId: userId, 
      recordingUrl: { $exists: true, $ne: [] } 
    };

    // Additional filters
    if (courseId) filter.courseId = courseId;
    
    // Date filter
    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) filter.createdAt.$gte = new Date(fromDate);
      if (toDate) filter.createdAt.$lte = new Date(toDate);
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Sort options
    let sortOption = { createdAt: -1 };
    if (sortBy === "oldest") sortOption = { createdAt: 1 };
    if (sortBy === "title") sortOption = { title: 1 };

    const sessions = await liveSessionModel
      .find(filter)
      .select("sessionId title recordingUrl createdAt roomCode courseId duration endTime")
      .populate("courseId", "title thumbnail")
      .sort(sortOption)
      .skip(skip)
      .limit(parseInt(limit));

    const totalSessions = await liveSessionModel.countDocuments(filter);

    // Calculate total statistics
    let totalStats = {
      totalRecordings: 0,
      totalDuration: 0,
      totalSize: 0,
      sessionsWithRecordings: 0
    };

    // Format the response
    const formattedResponse = sessions.map(session => {
      const sessionRecordings = (session.recordingUrl || []).map(rec => ({
        recordingId: rec._id,
        fileUrl: rec.fileUrl,
        fileName: rec.fileName || "recording.mp4",
        duration: rec.duration || 0,
        fileSize: rec.fileSize || 0,
        uploadedAt: rec.uploadedAt || rec.recordedAt,
        status: rec.status || "COMPLETED",
        thumbnailUrl: rec.thumbnailUrl || ""
      }));

      // Update total stats
      totalStats.totalRecordings += sessionRecordings.length;
      totalStats.totalDuration += sessionRecordings.reduce((sum, rec) => sum + (rec.duration || 0), 0);
      totalStats.totalSize += sessionRecordings.reduce((sum, rec) => sum + (rec.fileSize || 0), 0);
      totalStats.sessionsWithRecordings++;

      return {
        sessionId: session.sessionId,
        title: session.title,
        roomCode: session.roomCode,
        course: session.courseId,
        createdAt: session.createdAt,
        duration: session.duration,
        endTime: session.endTime,
        recordings: sessionRecordings,
        totalRecordings: sessionRecordings.length,
        sessionDuration: sessionRecordings.reduce((sum, rec) => sum + (rec.duration || 0), 0),
        hasRecordings: sessionRecordings.length > 0
      };
    });

    // Calculate averages
    const averages = {
      recordingsPerSession: totalStats.sessionsWithRecordings > 0 
        ? Math.round(totalStats.totalRecordings / totalStats.sessionsWithRecordings) 
        : 0,
      averageDuration: totalStats.totalRecordings > 0 
        ? Math.round(totalStats.totalDuration / totalStats.totalRecordings) 
        : 0
    };

    return sendSuccessResponse(
      res,
      {
        sessions: formattedResponse,
        
        // Statistics
        statistics: totalStats,
        averages: averages,
        
        // Pagination
        pagination: {
          total: totalSessions,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(totalSessions / parseInt(limit)),
          hasNextPage: (parseInt(page) * parseInt(limit)) < totalSessions,
          hasPrevPage: parseInt(page) > 1
        },
        
        // Filters applied
        filters: {
          courseId,
          sortBy,
          fromDate,
          toDate
        }
      },
      "Your live session recordings fetched successfully",
      200
    );

  } catch (error) {
    console.error("🔥 getMyLiveSessionRecordings error:", error.message);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

// =====================================================
// ✅ GET RECORDING BY ID (NEW FUNCTION)
// =====================================================
export const getRecordingById = async (req, res) => {
  try {
    const { sessionId, recordingId } = req.params;
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    if (!sessionId || !recordingId) {
      return sendErrorResponse(res, "Session ID and Recording ID required", 400);
    }

    const session = await liveSessionModel
      .findOne({ sessionId })
      .populate("streamerId", "name email profilePic")
      .lean();

    if (!session) {
      return sendErrorResponse(res, "Session not found", 404);
    }

    // Find the specific recording
    const recording = (session.recordingUrl || []).find(
      rec => rec._id?.toString() === recordingId || 
             rec.fileUrl?.includes(recordingId)
    );

    if (!recording) {
      return sendErrorResponse(res, "Recording not found", 404);
    }

    // Permission check
    const isStreamer = session.streamerId._id.toString() === userId;
    const isAdmin = userRole === ROLE_MAP.ADMIN;
    const isParticipant = session.participants?.some(p => p.toString() === userId);

    let canAccess = false;
    
    if (session.isPrivate) {
      canAccess = isStreamer || isAdmin || isParticipant;
    } else {
      canAccess = true;
    }

    if (!canAccess) {
      return sendErrorResponse(
        res,
        "You don't have permission to access this recording",
        HttpStatus.FORBIDDEN
      );
    }

    // Format recording response
    const formattedRecording = {
      recordingId: recording._id || recordingId,
      fileUrl: recording.fileUrl,
      fileName: recording.fileName || "recording.mp4",
      fileType: recording.fileType || "video/mp4",
      duration: recording.duration || 0,
      fileSize: recording.fileSize || 0,
      uploadedAt: recording.uploadedAt || recording.recordedAt,
      status: recording.status || "COMPLETED",
      thumbnailUrl: recording.thumbnailUrl || "",
      s3Key: recording.fileKey || recording.s3Key || "",
      
      // Session info
      sessionInfo: {
        sessionId: session.sessionId,
        title: session.title,
        streamer: session.streamerId,
        roomCode: session.roomCode,
        isPrivate: session.isPrivate
      },
      
      // Permissions
      permissions: {
        canDownload: isStreamer || isAdmin,
        canDelete: isStreamer || isAdmin,
        canShare: true
      },
      
      // Analytics (if available)
      analytics: {
        views: recording.views || 0,
        downloads: recording.downloads || 0,
        lastAccessed: recording.lastAccessed
      }
    };

    return sendSuccessResponse(
      res,
      formattedRecording,
      "Recording fetched successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 getRecordingById error:", error.message);
    return sendErrorResponse(res, "Failed to fetch recording", HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// 🔹 Get Live Sessions by Course (SAME - NO CHANGE NEEDED)
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

// 🔹 Pause Live Session (SAME - NO CHANGE NEEDED)
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
// Resume Live Session (SAME - NO CHANGE NEEDED)
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
// Save Whiteboard Recording (SAME - NO CHANGE NEEDED)
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
// Get Session Analytics (SAME - NO CHANGE NEEDED)
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

// 🔹 Delete a specific recording from session (IMPROVED)
export const deleteSessionRecording = async (req, res) => {
  try {
    const { sessionId, recordingId } = req.params; // Changed from recordingIndex to recordingId
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    if (!sessionId || !recordingId) {
      return sendErrorResponse(res, "SessionId and Recording ID required", 400);
    }

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) {
      return sendErrorResponse(res, "Live session not found", 404);
    }

    // Check if user is authorized
    const isStreamer = session.streamerId.toString() === userId;
    const isAdmin = userRole === ROLE_MAP.ADMIN;

    if (!isStreamer && !isAdmin) {
      return sendErrorResponse(res, "Unauthorized to delete recording", 401);
    }

    // Find recording index by ID
    const recordingIndex = session.recordingUrl.findIndex(
      rec => rec._id?.toString() === recordingId || 
             rec.fileUrl?.includes(recordingId)
    );

    if (recordingIndex === -1) {
      return sendErrorResponse(res, "Recording not found", 404);
    }

    const recordingToDelete = session.recordingUrl[recordingIndex];
    
    // Delete from S3
    if (recordingToDelete.fileUrl) {
      try {
        await deleteFileFromS3(recordingToDelete.fileUrl);
        console.log(`✅ Deleted recording from S3: ${recordingToDelete.fileUrl}`);
      } catch (s3Error) {
        console.warn("⚠️ S3 delete warning:", s3Error.message);
        // Continue even if S3 delete fails
      }
    }

    // Remove from array
    session.recordingUrl.splice(recordingIndex, 1);
    await session.save();

    // Emit socket event
    const io = getIO();
    io.to(sessionId).emit("recording_deleted", {
      sessionId,
      recordingId: recordingId,
      remainingCount: session.recordingUrl.length
    });

    return sendSuccessResponse(
      res,
      { 
        deletedRecording: {
          id: recordingId,
          fileName: recordingToDelete.fileName,
          fileUrl: recordingToDelete.fileUrl
        },
        remainingRecordings: session.recordingUrl.length
      },
      "Recording deleted successfully",
      200
    );

  } catch (error) {
    console.error("🔥 deleteSessionRecording error:", error.message);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

// 🔹 Soft delete live session (SAME - NO CHANGE NEEDED)
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

// 🔹 Restore live session (SAME - NO CHANGE NEEDED)
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

// =====================================================
// ✅ DOWNLOAD RECORDING (NEW FUNCTION)
// =====================================================
export const downloadRecording = async (req, res) => {
  try {
    const { sessionId, recordingId } = req.params;
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    if (!sessionId || !recordingId) {
      return sendErrorResponse(res, "Session ID and Recording ID required", 400);
    }

    const session = await liveSessionModel.findOne({ sessionId }).lean();
    if (!session) {
      return sendErrorResponse(res, "Session not found", 404);
    }

    // Find the recording
    const recording = (session.recordingUrl || []).find(
      rec => rec._id?.toString() === recordingId || 
             rec.fileUrl?.includes(recordingId)
    );

    if (!recording || !recording.fileUrl) {
      return sendErrorResponse(res, "Recording not found", 404);
    }

    // Permission check
    const isStreamer = session.streamerId.toString() === userId;
    const isAdmin = userRole === ROLE_MAP.ADMIN;
    const isParticipant = session.participants?.some(p => p.toString() === userId);

    let canDownload = false;
    
    if (session.isPrivate) {
      canDownload = isStreamer || isAdmin || isParticipant;
    } else {
      canDownload = isStreamer || isAdmin; // Public session: only streamer/admin can download
    }

    if (!canDownload) {
      return sendErrorResponse(
        res,
        "You don't have permission to download this recording",
        HttpStatus.FORBIDDEN
      );
    }

    // Generate download URL (presigned URL for S3)
    // Note: You need to implement generateDownloadUrl in your S3 service
    const downloadUrl = recording.fileUrl; // Direct URL or generate presigned URL
    
    // Update download count
    await liveSessionModel.findOneAndUpdate(
      { sessionId, "recordingUrl._id": recording._id },
      { $inc: { "recordingUrl.$.downloads": 1 } }
    );

    return sendSuccessResponse(
      res,
      {
        downloadUrl,
        fileName: recording.fileName || "recording.mp4",
        fileSize: recording.fileSize || 0,
        duration: recording.duration || 0,
        expiresIn: 3600 // 1 hour
      },
      "Download URL generated successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 downloadRecording error:", error.message);
    return sendErrorResponse(res, "Failed to generate download URL", HttpStatus.INTERNAL_SERVER_ERROR);
  }
};