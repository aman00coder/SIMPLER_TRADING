// controllers/liveSession/recording.controller.js (Complete Version)
import mongoose from "mongoose";
import HttpStatus from "http-status-codes";
import liveSessionModel from "../../model/liveSessions/liveeSession.model.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn } from "../../responses/message.js";
import { ROLE_MAP } from "../../constant/role.js";
import { getIO } from "../../services/socket.integrated.js";
import { generateRecordingPresignedUrl, deleteFileFromS3 } from "../../middleware/aws.s3.js";

// =====================================================
// ✅ GET RECORDING PRE-SIGNED URL (SESSION SPECIFIC)
// =====================================================
export const getRecordingPresignedUrl = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;
    const { fileName, fileType = "video/mp4", fileSize = 0 } = req.body;

    if (!sessionId || !fileName) {
      return sendErrorResponse(
        res,
        "Session ID and file name are required",
        HttpStatus.BAD_REQUEST
      );
    }

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) {
      return sendErrorResponse(res, "Live session not found", HttpStatus.NOT_FOUND);
    }

    if (session.streamerId.toString() !== userId) {
      return sendErrorResponse(
        res,
        "Only the streamer can upload recordings",
        HttpStatus.UNAUTHORIZED
      );
    }

    const presignedData = await generateRecordingPresignedUrl({
      sessionId,
      fileName,
      fileType,
      folder: "live-recordings"
    });

    return sendSuccessResponse(
      res,
      {
        sessionId,
        uploadUrl: presignedData.uploadUrl,
        fileUrl: presignedData.fileUrl,
        fileKey: presignedData.fileKey,
        fileName,
        fileType,
        fileSize
      },
      "Recording upload URL generated",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 getRecordingPresignedUrl error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to generate upload URL",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};


// =====================================================
// ✅ SAVE RECORDING METADATA TO SESSION
// =====================================================
export const saveRecordingToSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.tokenData?.userId;
        
        const {
            fileUrl,
            fileName,
            fileType = "video/mp4",
            duration = 0,
            fileSize = 0,
            s3Key = "",
            thumbnailUrl = ""
        } = req.body;

        if (!sessionId || !fileUrl || !fileName) {
            return sendErrorResponse(
                res,
                "Session ID, file URL and file name are required",
                HttpStatus.BAD_REQUEST
            );
        }

        // Find session
        const session = await liveSessionModel.findOne({ sessionId });
        if (!session) {
            return sendErrorResponse(
                res,
                "Live session not found",
                HttpStatus.NOT_FOUND
            );
        }

        // Verify user is the streamer
        if (session.streamerId.toString() !== userId) {
            return sendErrorResponse(
                res,
                "Only the streamer can save recordings",
                HttpStatus.UNAUTHORIZED
            );
        }

        // Create recording entry
        const recording = {
            fileUrl,
            fileName,
            fileType,
            duration: parseInt(duration) || 0,
            fileSize: parseInt(fileSize) || 0,
            recordedBy: userId,
            recordedAt: new Date(),
            s3Key,
            thumbnailUrl,
            status: "COMPLETED"
        };

        // Add to recordings array
        session.recordingUrl.push(recording);
        await session.save();

        // Notify via socket
        const io = getIO();
        io.to(sessionId).emit("recording_saved", {
            sessionId,
            recording: recording,
            totalRecordings: session.recordingUrl.length
        });

        return sendSuccessResponse(
            res,
            {
                sessionId: session.sessionId,
                recording: recording,
                totalRecordings: session.recordingUrl.length
            },
            "Recording saved to session successfully",
            HttpStatus.OK
        );

    } catch (error) {
        console.error("🔥 saveRecordingToSession error:", error.message);
        return sendErrorResponse(
            res,
            "Failed to save recording",
            HttpStatus.INTERNAL_SERVER_ERROR
        );
    }
};

// =====================================================
// ✅ GET ALL RECORDINGS FOR A SESSION
// =====================================================
export const getSessionRecordings = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.tokenData?.userId;
        const userRole = req.tokenData?.role;

        if (!sessionId) {
            return sendErrorResponse(
                res,
                "Session ID is required",
                HttpStatus.BAD_REQUEST
            );
        }

        const session = await liveSessionModel
            .findOne({ sessionId })
            .populate("streamerId", "name email profilePic")
            .populate("participants", "name email")
            .lean();

        if (!session) {
            return sendErrorResponse(
                res,
                "Session not found",
                HttpStatus.NOT_FOUND
            );
        }

        // Check permissions
        const isStreamer = session.streamerId._id.toString() === userId;
        const isAdmin = userRole === ROLE_MAP.ADMIN;
        const isParticipant = session.participants.some(p => p._id.toString() === userId);

        let canViewRecordings = false;
        
        if (session.isPrivate) {
            // Private session: only streamer, admin, and participants
            canViewRecordings = isStreamer || isAdmin || isParticipant;
        } else {
            // Public session: authenticated users can view
            canViewRecordings = true;
        }

        if (!canViewRecordings) {
            return sendErrorResponse(
                res,
                "You don't have permission to view recordings for this session",
                HttpStatus.FORBIDDEN
            );
        }

        // Format response
        const response = {
            sessionId: session.sessionId,
            title: session.title,
            streamer: session.streamerId,
            roomCode: session.roomCode,
            isPrivate: session.isPrivate,
            recordings: session.recordingUrl || [],
            totalRecordings: session.recordingUrl?.length || 0,
            totalDuration: session.recordingUrl?.reduce((sum, rec) => sum + (rec.duration || 0), 0) || 0,
            permissions: {
                canUpload: isStreamer || isAdmin,
                canDelete: isStreamer || isAdmin
            }
        };

        return sendSuccessResponse(
            res,
            response,
            "Session recordings fetched successfully",
            HttpStatus.OK
        );

    } catch (error) {
        console.error("🔥 getSessionRecordings error:", error.message);
        return sendErrorResponse(
            res,
            "Failed to fetch recordings",
            HttpStatus.INTERNAL_SERVER_ERROR
        );
    }
};

// =====================================================
// ✅ GET RECORDINGS BY STREAMER (FOR DASHBOARD)
// =====================================================
export const getStreamerRecordings = async (req, res) => {
    try {
        const streamerId = req.tokenData?.userId;

        if (!streamerId) {
            return sendErrorResponse(
                res,
                "Unauthorized access",
                HttpStatus.UNAUTHORIZED
            );
        }

        // Find all sessions where user is streamer and has recordings
        const sessions = await liveSessionModel
            .find({ 
                streamerId,
                recordingUrl: { $exists: true, $ne: [] }
            })
            .populate("courseId", "title thumbnail")
            .sort({ createdAt: -1 });

        // Calculate statistics
        let totalRecordings = 0;
        let totalDuration = 0;
        let courseWiseRecordings = {};
        let recentRecordings = [];

        // Process each session
        const formattedSessions = sessions.map(session => {
            const sessionRecordings = session.recordingUrl.map(rec => ({
                recordingId: rec._id,
                fileUrl: rec.fileUrl,
                fileName: rec.fileName,
                duration: rec.duration || 0,
                recordedAt: rec.recordedAt,
                thumbnailUrl: rec.thumbnailUrl,
                fileSize: rec.fileSize || 0,
                status: rec.status || "COMPLETED"
            }));

            // Update statistics
            totalRecordings += sessionRecordings.length;
            totalDuration += sessionRecordings.reduce((sum, rec) => sum + rec.duration, 0);

            // Course-wise grouping
            if (session.courseId) {
                const courseId = session.courseId._id.toString();
                if (!courseWiseRecordings[courseId]) {
                    courseWiseRecordings[courseId] = {
                        course: session.courseId,
                        recordings: []
                    };
                }
                courseWiseRecordings[courseId].recordings.push(...sessionRecordings);
            }

            // Add to recent recordings
            recentRecordings.push(...sessionRecordings.map(rec => ({
                sessionId: session.sessionId,
                sessionTitle: session.title,
                courseTitle: session.courseId?.title || "No Course",
                ...rec
            })));

            return {
                sessionId: session.sessionId,
                sessionTitle: session.title,
                roomCode: session.roomCode,
                course: session.courseId,
                startTime: session.actualStartTime,
                endTime: session.endTime,
                status: session.status,
                totalParticipants: session.participants?.length || 0,
                recordings: sessionRecordings,
                totalRecordings: sessionRecordings.length,
                sessionDuration: sessionRecordings.reduce((sum, rec) => sum + rec.duration, 0)
            };
        });

        // Sort recent recordings by date
        recentRecordings.sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));
        recentRecordings = recentRecordings.slice(0, 20); // Last 20 recordings

        // Convert course-wise object to array
        const courseWiseArray = Object.values(courseWiseRecordings).map(courseData => ({
            courseId: courseData.course._id,
            courseTitle: courseData.course.title,
            courseThumbnail: courseData.course.thumbnail,
            totalRecordings: courseData.recordings.length,
            totalDuration: courseData.recordings.reduce((sum, rec) => sum + rec.duration, 0),
            recordings: courseData.recordings.slice(0, 5) // Show 5 per course
        }));

        return sendSuccessResponse(
            res,
            {
                // Dashboard overview
                overview: {
                    totalSessions: sessions.length,
                    totalRecordings: totalRecordings,
                    totalDuration: totalDuration,
                    totalCourses: Object.keys(courseWiseRecordings).length,
                    averageDuration: totalRecordings > 0 ? totalDuration / totalRecordings : 0
                },

                // Detailed data
                sessions: formattedSessions,
                courseWiseRecordings: courseWiseArray,
                recentRecordings: recentRecordings,

                // Statistics for charts
                statistics: {
                    recordingsByMonth: getRecordingsByMonth(sessions),
                    recordingsByCourse: getRecordingsByCourse(sessions),
                    durationDistribution: getDurationDistribution(sessions)
                }
            },
            "Streamer recordings dashboard data fetched successfully",
            HttpStatus.OK
        );

    } catch (error) {
        console.error("🔥 getStreamerRecordings error:", error.message);
        return sendErrorResponse(
            res,
            "Failed to fetch streamer recordings",
            HttpStatus.INTERNAL_SERVER_ERROR
        );
    }
};

// =====================================================
// ✅ GET RECORDINGS BY COURSE
// =====================================================
export const getCourseRecordings = async (req, res) => {
    try {
        const { courseId } = req.params;
        const userId = req.tokenData?.userId;
        const userRole = req.tokenData?.role;

        if (!courseId) {
            return sendErrorResponse(
                res,
                "Course ID is required",
                HttpStatus.BAD_REQUEST
            );
        }

        // Verify course exists
        const Course = mongoose.model("Course");
        const course = await Course.findById(courseId)
            .populate("createdBy", "name email")
            .populate("enrolledUsers", "name email");

        if (!course) {
            return sendErrorResponse(
                res,
                "Course not found",
                HttpStatus.NOT_FOUND
            );
        }

        // Check if user has access to this course
        const isCreator = course.createdBy._id.toString() === userId;
        const isEnrolled = course.enrolledUsers.some(user => user._id.toString() === userId);
        const isAdmin = userRole === ROLE_MAP.ADMIN;

        if (!isCreator && !isEnrolled && !isAdmin) {
            return sendErrorResponse(
                res,
                "You don't have access to this course",
                HttpStatus.FORBIDDEN
            );
        }

        // Find all sessions for this course that have recordings
        const sessions = await liveSessionModel
            .find({ 
                courseId,
                recordingUrl: { $exists: true, $ne: [] }
            })
            .populate("streamerId", "name email profilePic")
            .populate("participants", "name email")
            .sort({ actualStartTime: -1 });

        // Course statistics
        let courseStatistics = {
            totalSessions: sessions.length,
            totalRecordings: 0,
            totalDuration: 0,
            totalParticipants: 0,
            averageSessionDuration: 0,
            completionRate: 0
        };

        // Process sessions and recordings
        const formattedSessions = sessions.map(session => {
            const sessionRecordings = session.recordingUrl.map(rec => ({
                recordingId: rec._id,
                fileUrl: rec.fileUrl,
                fileName: rec.fileName,
                duration: rec.duration || 0,
                recordedAt: rec.recordedAt,
                thumbnailUrl: rec.thumbnailUrl,
                fileSize: rec.fileSize || 0,
                recordedBy: rec.recordedBy
            }));

            // Update course statistics
            courseStatistics.totalRecordings += sessionRecordings.length;
            courseStatistics.totalDuration += sessionRecordings.reduce((sum, rec) => sum + rec.duration, 0);
            courseStatistics.totalParticipants += session.participants?.length || 0;

            return {
                sessionId: session.sessionId,
                sessionTitle: session.title,
                streamer: session.streamerId,
                roomCode: session.roomCode,
                startTime: session.actualStartTime,
                endTime: session.endTime,
                duration: session.duration,
                totalParticipants: session.participants?.length || 0,
                isPrivate: session.isPrivate,
                status: session.status,
                recordings: sessionRecordings,
                totalRecordings: sessionRecordings.length,
                sessionRecordingDuration: sessionRecordings.reduce((sum, rec) => sum + rec.duration, 0)
            };
        });

        // Calculate averages
        if (sessions.length > 0) {
            courseStatistics.averageSessionDuration = courseStatistics.totalDuration / courseStatistics.totalRecordings;
            courseStatistics.completionRate = (sessions.filter(s => s.status === "ENDED").length / sessions.length) * 100;
        }

        // Group recordings by streamer for the course
        const recordingsByStreamer = {};
        sessions.forEach(session => {
            const streamerId = session.streamerId._id.toString();
            if (!recordingsByStreamer[streamerId]) {
                recordingsByStreamer[streamerId] = {
                    streamer: session.streamerId,
                    totalRecordings: 0,
                    totalDuration: 0,
                    recordings: []
                };
            }
            
            session.recordingUrl.forEach(rec => {
                recordingsByStreamer[streamerId].totalRecordings++;
                recordingsByStreamer[streamerId].totalDuration += rec.duration || 0;
                recordingsByStreamer[streamerId].recordings.push({
                    sessionId: session.sessionId,
                    sessionTitle: session.title,
                    recordingId: rec._id,
                    fileUrl: rec.fileUrl,
                    fileName: rec.fileName,
                    duration: rec.duration,
                    recordedAt: rec.recordedAt
                });
            });
        });

        // Convert to array
        const streamersArray = Object.values(recordingsByStreamer).map(streamerData => ({
            streamer: streamerData.streamer,
            totalRecordings: streamerData.totalRecordings,
            totalDuration: streamerData.totalDuration,
            recordings: streamerData.recordings.slice(0, 3) // Show 3 per streamer
        }));

        return sendSuccessResponse(
            res,
            {
                courseInfo: {
                    courseId: course._id,
                    title: course.title,
                    description: course.description,
                    thumbnail: course.thumbnail,
                    category: course.category,
                    createdBy: course.createdBy,
                    totalEnrolled: course.enrolledUsers?.length || 0
                },

                courseStatistics: courseStatistics,
                
                sessions: formattedSessions,
                
                streamers: streamersArray,

                // Recent recordings (all course recordings sorted by date)
                recentRecordings: formattedSessions
                    .flatMap(session => 
                        session.recordings.map(rec => ({
                            sessionId: session.sessionId,
                            sessionTitle: session.sessionTitle,
                            streamer: session.streamer,
                            ...rec
                        }))
                    )
                    .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))
                    .slice(0, 10),

                // User-specific info
                userPermissions: {
                    isCreator: isCreator,
                    isEnrolled: isEnrolled,
                    isAdmin: isAdmin,
                    canDownload: isCreator || isAdmin,
                    canShare: true
                }
            },
            "Course recordings fetched successfully",
            HttpStatus.OK
        );

    } catch (error) {
        console.error("🔥 getCourseRecordings error:", error.message);
        return sendErrorResponse(
            res,
            "Failed to fetch course recordings",
            HttpStatus.INTERNAL_SERVER_ERROR
        );
    }
};

// =====================================================
// ✅ DELETE RECORDING
// =====================================================
export const deleteRecording = async (req, res) => {
    try {
        const { sessionId, recordingId } = req.params;
        const userId = req.tokenData?.userId;

        if (!sessionId || !recordingId) {
            return sendErrorResponse(
                res,
                "Session ID and Recording ID required",
                HttpStatus.BAD_REQUEST
            );
        }

        const session = await liveSessionModel.findOne({ sessionId });
        if (!session) {
            return sendErrorResponse(
                res,
                "Session not found",
                HttpStatus.NOT_FOUND
            );
        }

        // Check if user is streamer
        if (session.streamerId.toString() !== userId) {
            return sendErrorResponse(
                res,
                "Only the streamer can delete recordings",
                HttpStatus.UNAUTHORIZED
            );
        }

        // Find recording index
        const recordingIndex = session.recordingUrl.findIndex(
            rec => rec._id.toString() === recordingId
        );

        if (recordingIndex === -1) {
            return sendErrorResponse(
                res,
                "Recording not found in session",
                HttpStatus.NOT_FOUND
            );
        }

        const recordingToDelete = session.recordingUrl[recordingIndex];

        // Delete from S3
        if (recordingToDelete.fileUrl) {
            try {
                await deleteFileFromS3(recordingToDelete.fileUrl);
            } catch (s3Error) {
                console.warn("⚠️ S3 delete warning:", s3Error.message);
            }
        }

        // Remove from array
        session.recordingUrl.splice(recordingIndex, 1);
        await session.save();

        return sendSuccessResponse(
            res,
            {
                deletedRecording: recordingToDelete,
                remainingRecordings: session.recordingUrl.length
            },
            "Recording deleted successfully",
            HttpStatus.OK
        );

    } catch (error) {
        console.error("🔥 deleteRecording error:", error.message);
        return sendErrorResponse(
            res,
            "Failed to delete recording",
            HttpStatus.INTERNAL_SERVER_ERROR
        );
    }
};

// =====================================================
// ✅ HELPER FUNCTIONS
// =====================================================

// Helper: Get recordings grouped by month
const getRecordingsByMonth = (sessions) => {
    const monthlyData = {};
    
    sessions.forEach(session => {
        session.recordingUrl.forEach(rec => {
            const date = new Date(rec.recordedAt);
            const monthYear = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            
            if (!monthlyData[monthYear]) {
                monthlyData[monthYear] = {
                    count: 0,
                    duration: 0
                };
            }
            
            monthlyData[monthYear].count++;
            monthlyData[monthYear].duration += rec.duration || 0;
        });
    });

    // Convert to array and sort
    return Object.entries(monthlyData)
        .map(([month, data]) => ({
            month,
            count: data.count,
            duration: data.duration
        }))
        .sort((a, b) => a.month.localeCompare(b.month));
};

// Helper: Get recordings grouped by course
const getRecordingsByCourse = (sessions) => {
    const courseData = {};
    
    sessions.forEach(session => {
        const courseName = session.courseId?.title || "No Course";
        
        if (!courseData[courseName]) {
            courseData[courseName] = {
                count: 0,
                duration: 0
            };
        }
        
        courseData[courseName].count += session.recordingUrl.length;
        courseData[courseName].duration += session.recordingUrl.reduce(
            (sum, rec) => sum + (rec.duration || 0), 0
        );
    });

    return Object.entries(courseData).map(([course, data]) => ({
        course,
        count: data.count,
        duration: data.duration
    }));
};

// Helper: Get duration distribution
const getDurationDistribution = (sessions) => {
    const distribution = {
        short: 0,    // < 5 min
        medium: 0,   // 5-30 min
        long: 0,     // 30-60 min
        extraLong: 0 // > 60 min
    };
    
    sessions.forEach(session => {
        session.recordingUrl.forEach(rec => {
            const duration = rec.duration || 0;
            const minutes = duration / 60;
            
            if (minutes < 5) distribution.short++;
            else if (minutes < 30) distribution.medium++;
            else if (minutes < 60) distribution.long++;
            else distribution.extraLong++;
        });
    });
    
    return distribution;
};