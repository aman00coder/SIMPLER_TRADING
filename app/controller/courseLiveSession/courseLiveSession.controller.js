import { v4 as uuidv4 } from "uuid";
import mongoose from "mongoose";
import LiveSession from "../../model/liveSessions/liveeSession.model.js";
import courseModel from "../../model/course/course.model.js";
import { ROLE_MAP } from "../../constant/role.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";

// Helper functions
const generateRoomCode = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

const generateJoinLink = (sessionId, roomCode) => {
  // Aapka frontend URL
  return `/${sessionId}/${roomCode}`;
};


// controller/courseLiveSession/courseLiveSession.controller.js
export const checkUserEnrollment = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    // Validation
    if (!sessionId) {
      return sendErrorResponse(res, "Session ID is required", 400);
    }

    if (!userId) {
      return sendErrorResponse(res, "User ID not found in token", 401);
    }

    // Step 1: Find live session to get course ID
    const liveSession = await LiveSession.findOne({
      $or: [
        { sessionId: sessionId },
        { roomCode: sessionId }
      ]
    }).select("courseId title streamerId description duration maxParticipants status startTime");

    if (!liveSession) {
      return sendSuccessResponse(res, {
        success: false,
        isEnrolled: false,
        message: "Live session not found",
        sessionExists: false
      }, "Session not found", 200);
    }

    // Step 2: Find the course WITH COMPLETE DETAILS
    const course = await courseModel.findById(liveSession.courseId)
      .select("title description thumbnail price category level duration rating enrolledUsers createdBy isActive language tags lectures")
      .populate("createdBy", "name email profilePic");

    if (!course) {
      return sendSuccessResponse(res, {
        success: false,
        isEnrolled: false,
        message: "Course not found",
        sessionExists: true,
        courseExists: false,
        sessionId: liveSession.sessionId,
        sessionTitle: liveSession.title
      }, "Course not found", 200);
    }

    // Step 3: Check enrollment and permissions
    const enrollment = course.enrolledUsers.find(
      enrollment => enrollment.user.toString() === userId
    );
    
    const isEnrolled = !!enrollment;
    const isCreator = course.createdBy._id.toString() === userId;
    const isStreamer = liveSession.streamerId.toString() === userId;
    const isAdmin = userRole === ROLE_MAP.ADMIN;
    
    const hasAccess = isEnrolled || isCreator || isStreamer || isAdmin;
    const courseActive = course.isActive !== false;

    // Step 4: Prepare detailed course information
    const courseDetails = {
      courseId: course._id,
      title: course.title,
      description: course.description,
      thumbnail: course.thumbnail,
      price: course.price,
      category: course.category,
      level: course.level,
      duration: course.duration,
      rating: course.rating,
      language: course.language,
      tags: course.tags || [],
      isActive: course.isActive,
      creator: {
        id: course.createdBy._id,
        name: course.createdBy.name,
        email: course.createdBy.email,
        profilePic: course.createdBy.profilePic
      },
      enrolledCount: course.enrolledUsers.length,
      lectureCount: course.lectures?.length || 0,
      totalDuration: course.duration || 0,
      isFree: course.price === 0
    };

    // Step 5: Prepare session information
    const sessionDetails = {
      sessionId: liveSession.sessionId,
      sessionTitle: liveSession.title,
      sessionDescription: liveSession.description || "",
      roomCode: liveSession.roomCode,
      status: liveSession.status,
      duration: liveSession.duration || 60,
      maxParticipants: liveSession.maxParticipants || 100,
      startTime: liveSession.startTime,
      isPrivate: liveSession.isPrivate || false
    };

    // Step 6: Prepare enrollment details if enrolled
    let enrollmentDetails = null;
    if (enrollment) {
      enrollmentDetails = {
        enrolledAt: enrollment.enrolledAt,
        progress: enrollment.progress || 0,
        completedLectures: enrollment.completedLectures?.length || 0,
        lastAccessed: enrollment.lastAccessed
      };
    }

    // Step 7: Prepare response
    const response = {
      success: true,
      isEnrolled,
      isCreator,
      isStreamer,
      isAdmin,
      hasAccess,
      courseActive,
      sessionExists: true,
      courseExists: true,
      sessionDetails,
      courseDetails,
      enrollmentDetails,
      userId: userId,
      userRole: userRole,
      timestamp: new Date()
    };

    // Step 8: Add appropriate message
    if (!hasAccess) {
      response.message = "You are not enrolled in this course";
      response.suggestedAction = "enroll";
    } else if (isEnrolled) {
      response.message = "You are enrolled in this course";
      response.suggestedAction = "join";
    } else if (isCreator) {
      response.message = "You are the course creator";
      response.suggestedAction = "join";
    } else if (isStreamer) {
      response.message = "You are the session streamer";
      response.suggestedAction = "stream";
    } else if (isAdmin) {
      response.message = "You have admin access";
      response.suggestedAction = "join";
    }

    return sendSuccessResponse(res, response, response.message, 200);

  } catch (error) {
    console.error("🔥 checkUserEnrollment error:", error);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

export const createCourseLiveSession = async (req, res) => {
  try {
    const {
      title,
      description,
      courseId,
      duration = 60,
      maxParticipants = 100,
      scheduledStartTime // 👈 FRONTEND se aa raha hoga
    } = req.body;

    const streamerId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    // Validate
    if (!title || !courseId || !scheduledStartTime) {
      return sendErrorResponse(res, "Title, Course ID & Scheduled Start Time are required", 400);
    }

    // Check course exists
    const course = await courseModel.findById(courseId);
    if (!course) {
      return sendErrorResponse(res, "Course not found", 404);
    }

    // IDs
    const sessionId = uuidv4();
    const roomCode = generateRoomCode();
    const joinLink = generateJoinLink(sessionId, roomCode);

    // -------------------------------------------------------------------------------------
    // 🔹 STEP 1: Create Live Session Document
    // -------------------------------------------------------------------------------------
    const newLiveSession = new LiveSession({
      sessionId,
      roomCode,
      title,
      description: description || "",
      courseId,
      streamerId,
      joinLink,
      duration,
      maxParticipants,
      status: "ACTIVE", 
      scheduledStartTime: new Date(scheduledStartTime), 
      actualStartTime: null, 
      participants: [],
      allowedUsers: [],
      bannedParticipants: [],
      streamerRole: ROLE_MAP.STREAMER,
      isRecordingEnabled: false,
      isChatEnabled: true,
      isWhiteboardEnabled: true,
      totalJoins: 0,
      peakParticipants: 0
    });

    await newLiveSession.save();

    // -------------------------------------------------------------------------------------
    // 🔹 STEP 2: Course ke andar Live Class add karna
    // -------------------------------------------------------------------------------------
    const liveClassData = {
      sessionId: sessionId,
      sessionTitle: title,
      joinLink: joinLink,
      roomCode: roomCode,
      scheduleAt: new Date(scheduledStartTime), // 👈 Yahi karna important tha
      duration: duration,
      mentor: streamerId,
      mentorName: req.tokenData?.name || "Instructor",
      description: description || "",
      status: "SCHEDULED",
      maxParticipants: maxParticipants,
      currentParticipants: 0,
      isPrivate: false,
      chatEnabled: true,
      whiteboardEnabled: true,
      thumbnail: "",
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await courseModel.findByIdAndUpdate(
      courseId,
      { $push: { liveClasses: liveClassData } },
      { new: true }
    );

    // -------------------------------------------------------------------------------------
    // RESPONSE
    // -------------------------------------------------------------------------------------
    return sendSuccessResponse(
      res,
      {
        success: true,
        message: "Live session scheduled successfully",
        data: {
          session: newLiveSession,
          courseLinked: true,
          joinLink: joinLink
        }
      },
      "Session created successfully",
      201
    );

  } catch (error) {
    console.error("🔥 createCourseLiveSession error:", error);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};


// ✅ JOIN PARTICIPANT (Existing logic copy with LiveSession)
export const joinCourseLiveSession = async (req, res) => {
  try {
    const { sessionId, roomCode } = req.params;
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    if (!sessionId || !roomCode) {
      return sendErrorResponse(res, "Session ID and Room Code are required", 400);
    }

    // Find session - Now using LiveSession model
    const liveSession = await LiveSession.findOne({
      $or: [
        { sessionId: sessionId },
        { roomCode: roomCode }
      ]
    }).populate("streamerId", "name email profilePic");

    if (!liveSession) {
      return sendErrorResponse(res, "Live session not found", 404);
    }

    // Check session status
    if (liveSession.status !== "LIVE") {
      return sendErrorResponse(res, `Session is ${liveSession.status.toLowerCase()}`, 400);
    }

    // Check if user is enrolled in course
    const course = await courseModel.findById(liveSession.courseId);
    const isEnrolled = course.enrolledUsers.some(e => e.user.toString() === userId);
    const isCreator = course.createdBy.toString() === userId;
    const isAdmin = userRole === ROLE_MAP.ADMIN;

    if (!isEnrolled && !isCreator && !isAdmin) {
      return sendErrorResponse(res, "You must be enrolled in the course to join", 403);
    }

    // Check max participants
    if (liveSession.participants.length >= liveSession.maxParticipants) {
      return sendErrorResponse(res, "Session is full", 400);
    }

    // Check if user is banned
    if (liveSession.bannedParticipants.includes(userId)) {
      return sendErrorResponse(res, "You are banned from this session", 403);
    }

    // Add participant if not already joined
    const participantAlreadyJoined = liveSession.participants.some(
      participant => participant.toString() === userId
    );
    
    if (!participantAlreadyJoined) {
      liveSession.participants.push(userId);
      liveSession.totalJoins += 1;
      
      // Update peak participants
      if (liveSession.participants.length > liveSession.peakParticipants) {
        liveSession.peakParticipants = liveSession.participants.length;
      }
      
      await liveSession.save();
    }

    // Update course live class participant count
    await courseModel.findOneAndUpdate(
      { 
        _id: liveSession.courseId,
        "liveClasses.sessionId": liveSession.sessionId
      },
      {
        $inc: { "liveClasses.$.currentParticipants": 1 }
      }
    );

    // Get user details
    const user = await mongoose.model("User").findById(userId).select("name email profilePic");

    // Socket notification (if socket setup)
    const io = req.app.get("io");
    if (io) {
      io.to(liveSession.sessionId).emit("participant_joined", {
        sessionId: liveSession.sessionId,
        userId: userId,
        userName: user?.name,
        timestamp: new Date()
      });
    }

    // Response with session details
    return sendSuccessResponse(res, {
      success: true,
      message: "Joined live session successfully",
      data: {
        session: {
          sessionId: liveSession.sessionId,
          title: liveSession.title,
          streamer: liveSession.streamerId,
          joinLink: liveSession.joinLink,
          courseId: liveSession.courseId,
          courseTitle: course?.title,
          participantsCount: liveSession.participants.length,
          maxParticipants: liveSession.maxParticipants,
          isChatEnabled: liveSession.isChatEnabled,
          isWhiteboardEnabled: liveSession.isWhiteboardEnabled
        },
        user: {
          id: userId,
          name: user?.name,
          role: userRole
        }
      }
    }, "Joined successfully", 200);

  } catch (error) {
    console.error("🔥 joinCourseLiveSession error:", error);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

// ✅ LEAVE SESSION
export const leaveCourseLiveSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;

    const liveSession = await LiveSession.findOne({ sessionId });
    
    if (!liveSession) {
      return sendErrorResponse(res, "Live session not found", 404);
    }

    // Remove participant
    const participantIndex = liveSession.participants.findIndex(
      participant => participant.toString() === userId
    );
    
    if (participantIndex !== -1) {
      liveSession.participants.splice(participantIndex, 1);
      await liveSession.save();
    }

    // Update course live class participant count
    if (liveSession.courseId) {
      await courseModel.findOneAndUpdate(
        { 
          _id: liveSession.courseId,
          "liveClasses.sessionId": sessionId
        },
        {
          $inc: { "liveClasses.$.currentParticipants": -1 }
        }
      );
    }

    // Socket notification
    const io = req.app.get("io");
    if (io) {
      io.to(sessionId).emit("participant_left", {
        sessionId: sessionId,
        userId: userId,
        timestamp: new Date()
      });
    }

    return sendSuccessResponse(res, {
      success: true,
      message: "Left session successfully"
    }, "Left session", 200);

  } catch (error) {
    console.error("🔥 leaveCourseLiveSession error:", error);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

// ✅ END SESSION
export const endCourseLiveSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    const liveSession = await LiveSession.findOne({ sessionId });
    
    if (!liveSession) {
      return sendErrorResponse(res, "Live session not found", 404);
    }

    // Check permissions
    const isStreamer = liveSession.streamerId.toString() === userId;
    const isAdmin = userRole === ROLE_MAP.ADMIN;
    
    if (!isStreamer && !isAdmin) {
      return sendErrorResponse(res, "Only the streamer or admin can end the session", 403);
    }

    // Update LiveSession
    liveSession.status = "ENDED";
    liveSession.endTime = new Date();
    
    // Calculate duration
    if (liveSession.actualStartTime) {
      const durationMs = new Date() - liveSession.actualStartTime;
      liveSession.duration = Math.floor(durationMs / (1000 * 60)); // Convert to minutes
    }
    
    await liveSession.save();

    // Update course live class
    if (liveSession.courseId) {
      await courseModel.findOneAndUpdate(
        { 
          _id: liveSession.courseId,
          "liveClasses.sessionId": sessionId
        },
        {
          $set: { 
            "liveClasses.$.status": "ENDED",
            "liveClasses.$.endTime": new Date()
          }
        }
      );
    }

    // Socket notification
    const io = req.app.get("io");
    if (io) {
      io.to(sessionId).emit("session_ended", {
        sessionId: sessionId,
        endedBy: userId,
        timestamp: new Date()
      });
    }

    return sendSuccessResponse(res, {
      success: true,
      message: "Session ended successfully",
      data: {
        sessionId: sessionId,
        endedAt: new Date(),
        duration: liveSession.duration,
        participantsCount: liveSession.participants.length
      }
    }, "Session ended", 200);

  } catch (error) {
    console.error("🔥 endCourseLiveSession error:", error);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

// ✅ GET SESSION DETAILS
export const getCourseLiveSession = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const liveSession = await LiveSession.findOne({ sessionId })
      .populate("streamerId", "name email profilePic")
      .populate("participants", "name email profilePic");

    if (!liveSession) {
      return sendErrorResponse(res, "Live session not found", 404);
    }

    let courseData = null;
    if (liveSession.courseId) {
      courseData = await courseModel.findById(liveSession.courseId)
        .select("title thumbnail category");
    }

    return sendSuccessResponse(res, {
      success: true,
      data: {
        session: liveSession,
        course: courseData
      }
    }, "Session details retrieved", 200);

  } catch (error) {
    console.error("🔥 getCourseLiveSession error:", error);
    return sendErrorResponse(res, "Internal server error", 500);
  }
};