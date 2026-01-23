// controllers/liveSession/recording.controller.js (Optimized Version)
import mongoose from "mongoose";
import HttpStatus from "http-status-codes";
import liveSessionModel from "../../model/liveSessions/liveeSession.model.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn } from "../../responses/message.js";
import { ROLE_MAP } from "../../constant/role.js";
import { getIO } from "../../services/socket.integrated.js";
import { generateRecordingPresignedUrl, deleteFileFromS3, generateDownloadPresignedUrl } from "../../middleware/aws.s3.js";

// =====================================================
// ✅ UPLOAD RECORDING FUNCTIONS (Unique to this controller)
// =====================================================

/**
 * ✅ GET RECORDING UPLOAD PRE-SIGNED URL (SESSION SPECIFIC)
 * This is for manually uploading recordings after session ends
 */
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

    // Check permissions - only streamer or admin can upload recordings
    const isStreamer = session.streamerId.toString() === userId;
    const isAdmin = req.tokenData?.role === ROLE_MAP.ADMIN;

    if (!isStreamer && !isAdmin) {
      return sendErrorResponse(
        res,
        "Only the streamer or admin can upload recordings",
        HttpStatus.UNAUTHORIZED
      );
    }

    // Validate file type for recordings
    const allowedRecordingTypes = [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska",
      "video/x-msvideo",
      "video/ogg"
    ];

    if (!allowedRecordingTypes.includes(fileType)) {
      return sendErrorResponse(
        res,
        `Recording file type not allowed: ${fileType}. Allowed: ${allowedRecordingTypes.join(", ")}`,
        HttpStatus.BAD_REQUEST
      );
    }

    // Size limit (2GB max for recordings)
    const MAX_RECORDING_SIZE = 2 * 1024 * 1024 * 1024; // 2GB
    if (fileSize && fileSize > MAX_RECORDING_SIZE) {
      return sendErrorResponse(
        res,
        `Recording file size exceeds ${MAX_RECORDING_SIZE / (1024*1024*1024)}GB limit`,
        HttpStatus.BAD_REQUEST
      );
    }

    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const uniqueFileName = `${sessionId}_${timestamp}_${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    const presignedData = await generateRecordingPresignedUrl({
      sessionId,
      fileName: uniqueFileName,
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
        fileName: uniqueFileName,
        originalFileName: fileName,
        fileType,
        fileSize,
        expiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour
        metadata: {
          sessionId,
          uploadedBy: userId,
          uploadType: "manual"
        }
      },
      "Recording upload URL generated successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 getRecordingPresignedUrl error:", error.message);
    return sendErrorResponse(
      res,
      `Failed to generate upload URL: ${error.message}`,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

/**
 * ✅ SAVE MANUALLY UPLOADED RECORDING METADATA
 * This is for saving recordings uploaded via presigned URL
 */
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
      thumbnailUrl = "",
      recordingTitle = "",
      description = ""
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

    // Verify user permissions
    const isStreamer = session.streamerId.toString() === userId;
    const isAdmin = req.tokenData?.role === ROLE_MAP.ADMIN;

    if (!isStreamer && !isAdmin) {
      return sendErrorResponse(
        res,
        "Only the streamer or admin can save recordings",
        HttpStatus.UNAUTHORIZED
      );
    }

    // Validate file URL belongs to this session
    if (!fileUrl.includes(sessionId) && !s3Key.includes(sessionId)) {
      console.warn(`⚠️ File URL/S3Key doesn't match sessionId: ${sessionId}`);
    }

    // Create comprehensive recording entry
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
      title: recordingTitle || fileName.replace(/\.[^/.]+$/, ""), // Remove extension
      description: description || "",
      status: "COMPLETED",
      uploadType: "manual",
      views: 0,
      downloads: 0,
      lastAccessed: null,
      tags: ["manual-upload"],
      metadata: {
        originalFileName: fileName,
        sessionId: sessionId,
        streamerId: session.streamerId,
        roomCode: session.roomCode
      }
    };

    // Add to recordings array
    session.recordingUrl.push(recording);
    await session.save();

    // Update session statistics
    await liveSessionModel.findByIdAndUpdate(
      session._id,
      {
        $inc: {
          totalRecordingDuration: recording.duration,
          totalRecordingSize: recording.fileSize
        },
        $set: {
          lastRecordingAt: new Date(),
          hasRecordings: true
        }
      }
    );

    // Notify via socket
    const io = getIO();
    io.to(sessionId).emit("recording_added", {
      sessionId,
      recording: recording,
      totalRecordings: session.recordingUrl.length,
      addedBy: userId,
      timestamp: new Date()
    });

    return sendSuccessResponse(
      res,
      {
        sessionId: session.sessionId,
        sessionTitle: session.title,
        recording: recording,
        totalRecordings: session.recordingUrl.length,
        sessionRecordingsCount: session.recordingUrl.length,
        uploadStatus: "SUCCESS"
      },
      "Recording saved to session successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 saveRecordingToSession error:", error.message);
    return sendErrorResponse(
      res,
      `Failed to save recording: ${error.message}`,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

// =====================================================
// ✅ RECORDING MANAGEMENT FUNCTIONS (Unique Features)
// =====================================================

/**
 * ✅ GET RECORDING DOWNLOAD URL (Presigned URL for secure download)
 */
export const getRecordingDownloadUrl = async (req, res) => {
  try {
    const { sessionId, recordingId } = req.params;
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    if (!sessionId || !recordingId) {
      return sendErrorResponse(
        res,
        "Session ID and Recording ID required",
        HttpStatus.BAD_REQUEST
      );
    }

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) {
      return sendErrorResponse(res, "Session not found", HttpStatus.NOT_FOUND);
    }

    // Find the recording
    const recording = (session.recordingUrl || []).find(
      rec => rec._id?.toString() === recordingId || 
             rec.fileUrl?.includes(recordingId) ||
             rec.s3Key?.includes(recordingId)
    );

    if (!recording) {
      return sendErrorResponse(res, "Recording not found", HttpStatus.NOT_FOUND);
    }

    // Check permissions
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

    // Generate presigned download URL
    let downloadUrl = recording.fileUrl;
    let expiresIn = 3600; // 1 hour
    
    if (recording.s3Key) {
      try {
        const presignedData = await generateDownloadPresignedUrl(recording.s3Key, expiresIn);
        downloadUrl = presignedData.url;
        expiresIn = presignedData.expiresIn;
      } catch (s3Error) {
        console.warn("⚠️ Failed to generate presigned download URL, using direct URL:", s3Error.message);
      }
    }

    // Update download count
    const recordingIndex = session.recordingUrl.findIndex(
      r => r._id?.toString() === recording._id?.toString()
    );

    if (recordingIndex !== -1) {
      session.recordingUrl[recordingIndex].downloads = (session.recordingUrl[recordingIndex].downloads || 0) + 1;
      session.recordingUrl[recordingIndex].lastAccessed = new Date();
      await session.save();
    }

    return sendSuccessResponse(
      res,
      {
        downloadUrl,
        fileName: recording.fileName,
        fileSize: recording.fileSize || 0,
        duration: recording.duration || 0,
        expiresIn: expiresIn,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
        recordingId: recording._id || recordingId,
        sessionId: sessionId,
        permissions: {
          canDownload: true,
          canShare: true,
          expiresIn: expiresIn
        }
      },
      "Download URL generated successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 getRecordingDownloadUrl error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to generate download URL",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

/**
 * ✅ UPDATE RECORDING METADATA
 * Allows updating title, description, tags, etc.
 */
export const updateRecordingMetadata = async (req, res) => {
  try {
    const { sessionId, recordingId } = req.params;
    const userId = req.tokenData?.userId;
    const updates = req.body;

    if (!sessionId || !recordingId || Object.keys(updates).length === 0) {
      return sendErrorResponse(
        res,
        "Session ID, Recording ID and update data required",
        HttpStatus.BAD_REQUEST
      );
    }

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) {
      return sendErrorResponse(res, "Session not found", HttpStatus.NOT_FOUND);
    }

    // Check if user is authorized (streamer or admin)
    const isStreamer = session.streamerId.toString() === userId;
    const isAdmin = req.tokenData?.role === ROLE_MAP.ADMIN;

    if (!isStreamer && !isAdmin) {
      return sendErrorResponse(
        res,
        "Only the streamer or admin can update recording metadata",
        HttpStatus.UNAUTHORIZED
      );
    }

    // Find recording index
    const recordingIndex = session.recordingUrl.findIndex(
      rec => rec._id?.toString() === recordingId
    );

    if (recordingIndex === -1) {
      return sendErrorResponse(res, "Recording not found", HttpStatus.NOT_FOUND);
    }

    // Allowed fields to update
    const allowedUpdates = [
      'title', 'description', 'tags', 'thumbnailUrl', 
      'duration', 'fileSize', 'status', 'isPublic'
    ];

    // Filter updates to only allowed fields
    const filteredUpdates = {};
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) {
        filteredUpdates[`recordingUrl.$.${key}`] = updates[key];
      }
    });

    if (Object.keys(filteredUpdates).length === 0) {
      return sendErrorResponse(
        res,
        "No valid fields to update",
        HttpStatus.BAD_REQUEST
      );
    }

    // Update the recording
    const updatedSession = await liveSessionModel.findOneAndUpdate(
      { 
        sessionId,
        "recordingUrl._id": recordingId 
      },
      { 
        $set: filteredUpdates,
        $set: { "recordingUrl.$.updatedAt": new Date() }
      },
      { new: true }
    );

    if (!updatedSession) {
      return sendErrorResponse(res, "Failed to update recording", HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Find the updated recording
    const updatedRecording = updatedSession.recordingUrl.find(
      rec => rec._id?.toString() === recordingId
    );

    return sendSuccessResponse(
      res,
      {
        sessionId,
        recordingId,
        updatedFields: Object.keys(updates).filter(key => allowedUpdates.includes(key)),
        recording: updatedRecording,
        updatedAt: new Date()
      },
      "Recording metadata updated successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 updateRecordingMetadata error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to update recording metadata",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

/**
 * ✅ SEARCH RECORDINGS
 * Advanced search across all recordings
 */
export const searchRecordings = async (req, res) => {
  try {
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;
    const {
      query = "",
      sessionId,
      courseId,
      fromDate,
      toDate,
      minDuration,
      maxDuration,
      tags = [],
      page = 1,
      limit = 20,
      sortBy = "uploadedAt",
      sortOrder = "desc"
    } = req.query;

    // Build search query
    let searchQuery = { recordingUrl: { $exists: true, $ne: [] } };
    
    // Role-based filtering
    if (userRole === ROLE_MAP.STREAMER) {
      searchQuery.streamerId = userId;
    } else if (userRole === ROLE_MAP.VIEWER) {
      // Viewers can only see public sessions or sessions they participated in
      searchQuery.$or = [
        { isPrivate: false },
        { participants: userId }
      ];
    }

    // Additional filters
    if (sessionId) searchQuery.sessionId = sessionId;
    if (courseId) searchQuery.courseId = courseId;
    
    // Date filter
    if (fromDate || toDate) {
      searchQuery.createdAt = {};
      if (fromDate) searchQuery.createdAt.$gte = new Date(fromDate);
      if (toDate) searchQuery.createdAt.$lte = new Date(toDate);
    }

    // Get sessions with recordings
    const sessions = await liveSessionModel
      .find(searchQuery)
      .populate("streamerId", "name email profilePic")
      .populate("courseId", "title thumbnail")
      .lean();

    // Extract and filter recordings
    let allRecordings = [];
    
    sessions.forEach(session => {
      (session.recordingUrl || []).forEach(rec => {
        const recordingData = {
          ...rec,
          sessionId: session.sessionId,
          sessionTitle: session.title,
          streamer: session.streamerId,
          course: session.courseId,
          roomCode: session.roomCode,
          isPrivate: session.isPrivate,
          sessionCreatedAt: session.createdAt
        };
        allRecordings.push(recordingData);
      });
    });

    // Apply search filters
    let filteredRecordings = allRecordings.filter(rec => {
      // Text search
      const searchText = query.toLowerCase();
      const matchesText = !query || 
        (rec.title && rec.title.toLowerCase().includes(searchText)) ||
        (rec.description && rec.description.toLowerCase().includes(searchText)) ||
        (rec.fileName && rec.fileName.toLowerCase().includes(searchText)) ||
        (rec.sessionTitle && rec.sessionTitle.toLowerCase().includes(searchText));

      // Duration filter
      const matchesDuration = (!minDuration || rec.duration >= parseInt(minDuration)) &&
                             (!maxDuration || rec.duration <= parseInt(maxDuration));

      // Tags filter
      const matchesTags = tags.length === 0 || 
                         (rec.tags && tags.some(tag => rec.tags.includes(tag)));

      return matchesText && matchesDuration && matchesTags;
    });

    // Sort recordings
    const sortField = sortBy === "uploadedAt" ? "recordedAt" : sortBy;
    filteredRecordings.sort((a, b) => {
      const aValue = a[sortField] || 0;
      const bValue = b[sortField] || 0;
      
      if (sortOrder === "asc") {
        return aValue > bValue ? 1 : -1;
      } else {
        return aValue < bValue ? 1 : -1;
      }
    });

    // Pagination
    const total = filteredRecordings.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedRecordings = filteredRecordings.slice(startIndex, endIndex);

    // Calculate statistics
    const statistics = {
      totalRecordings: total,
      totalSessions: sessions.length,
      totalDuration: filteredRecordings.reduce((sum, rec) => sum + (rec.duration || 0), 0),
      averageDuration: total > 0 ? filteredRecordings.reduce((sum, rec) => sum + (rec.duration || 0), 0) / total : 0
    };

    return sendSuccessResponse(
      res,
      {
        recordings: paginatedRecordings,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / parseInt(limit)),
          hasNextPage: endIndex < total,
          hasPrevPage: page > 1
        },
        statistics,
        filters: {
          query,
          sessionId,
          courseId,
          fromDate,
          toDate,
          minDuration,
          maxDuration,
          tags,
          sortBy,
          sortOrder
        }
      },
      "Recordings search completed successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 searchRecordings error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to search recordings",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

/**
 * ✅ GET RECORDING ANALYTICS
 * Detailed analytics for a specific recording
 */
export const getRecordingAnalytics = async (req, res) => {
  try {
    const { sessionId, recordingId } = req.params;
    const userId = req.tokenData?.userId;

    if (!sessionId || !recordingId) {
      return sendErrorResponse(res, "Session ID and Recording ID required", HttpStatus.BAD_REQUEST);
    }

    const session = await liveSessionModel.findOne({ sessionId });
    if (!session) {
      return sendErrorResponse(res, "Session not found", HttpStatus.NOT_FOUND);
    }

    // Find the recording
    const recording = (session.recordingUrl || []).find(
      rec => rec._id?.toString() === recordingId
    );

    if (!recording) {
      return sendErrorResponse(res, "Recording not found", HttpStatus.NOT_FOUND);
    }

    // Check if user is authorized (streamer or admin)
    const isStreamer = session.streamerId.toString() === userId;
    const isAdmin = req.tokenData?.role === ROLE_MAP.ADMIN;

    if (!isStreamer && !isAdmin) {
      return sendErrorResponse(
        res,
        "Only the streamer or admin can view recording analytics",
        HttpStatus.FORBIDDEN
      );
    }

    // Generate analytics data
    const analytics = {
      basic: {
        fileName: recording.fileName,
        fileSize: recording.fileSize || 0,
        duration: recording.duration || 0,
        uploadedAt: recording.recordedAt,
        uploadType: recording.uploadType || "auto",
        status: recording.status || "COMPLETED"
      },
      engagement: {
        views: recording.views || 0,
        downloads: recording.downloads || 0,
        lastAccessed: recording.lastAccessed,
        averageWatchTime: 0, // This would come from a separate analytics service
        completionRate: 0
      },
      performance: {
        storageCost: calculateStorageCost(recording.fileSize),
        bandwidthUsed: calculateBandwidthUsed(recording.views || 0, recording.fileSize),
        uploadSpeed: 0 // This would come from upload metrics
      },
      metadata: {
        tags: recording.tags || [],
        description: recording.description || "",
        thumbnail: recording.thumbnailUrl || "",
        s3Key: recording.s3Key || ""
      },
      sessionContext: {
        sessionTitle: session.title,
        streamer: session.streamerId,
        roomCode: session.roomCode,
        participantCount: session.participants?.length || 0,
        sessionDuration: session.duration || 0
      }
    };

    return sendSuccessResponse(
      res,
      {
        sessionId,
        recordingId,
        analytics,
        timestamp: new Date()
      },
      "Recording analytics fetched successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("🔥 getRecordingAnalytics error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to fetch recording analytics",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

/**
 * ✅ BULK RECORDING OPERATIONS
 * Perform operations on multiple recordings
 */
export const bulkRecordingOperations = async (req, res) => {
  try {
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;
    const { operation, recordingIds, metadata } = req.body;

    if (!operation || !Array.isArray(recordingIds) || recordingIds.length === 0) {
      return sendErrorResponse(
        res,
        "Operation type and recording IDs are required",
        HttpStatus.BAD_REQUEST
      );
    }

    // Validate operation
    const allowedOperations = ['delete', 'update', 'archive', 'publish'];
    if (!allowedOperations.includes(operation)) {
      return sendErrorResponse(
        res,
        `Invalid operation. Allowed: ${allowedOperations.join(', ')}`,
        HttpStatus.BAD_REQUEST
      );
    }

    // For delete operation, check permissions and process
    if (operation === 'delete') {
      if (recordingIds.length > 50) {
        return sendErrorResponse(
          res,
          "Cannot delete more than 50 recordings at once",
          HttpStatus.BAD_REQUEST
        );
      }

      let deletedCount = 0;
      let failedCount = 0;
      const results = [];

      for (const recId of recordingIds) {
        try {
          // Extract sessionId and recordingId from combined ID or separate logic
          // This depends on your ID format
          const session = await liveSessionModel.findOne({
            "recordingUrl._id": recId
          });

          if (!session) {
            results.push({ recordingId: recId, success: false, error: "Not found" });
            failedCount++;
            continue;
          }

          // Check permissions
          const isStreamer = session.streamerId.toString() === userId;
          const isAdmin = userRole === ROLE_MAP.ADMIN;

          if (!isStreamer && !isAdmin) {
            results.push({ recordingId: recId, success: false, error: "Unauthorized" });
            failedCount++;
            continue;
          }

          // Find and delete recording
          const recordingIndex = session.recordingUrl.findIndex(
            rec => rec._id?.toString() === recId
          );

          if (recordingIndex === -1) {
            results.push({ recordingId: recId, success: false, error: "Recording not found" });
            failedCount++;
            continue;
          }

          const recordingToDelete = session.recordingUrl[recordingIndex];

          // Delete from S3
          if (recordingToDelete.fileUrl) {
            try {
              await deleteFileFromS3(recordingToDelete.fileUrl);
            } catch (s3Error) {
              console.warn(`⚠️ S3 delete failed for ${recId}:`, s3Error.message);
            }
          }

          // Remove from array
          session.recordingUrl.splice(recordingIndex, 1);
          await session.save();

          results.push({ 
            recordingId: recId, 
            success: true, 
            fileName: recordingToDelete.fileName 
          });
          deletedCount++;

        } catch (error) {
          results.push({ recordingId: recId, success: false, error: error.message });
          failedCount++;
        }
      }

      return sendSuccessResponse(
        res,
        {
          operation: 'delete',
          totalRequested: recordingIds.length,
          deleted: deletedCount,
          failed: failedCount,
          results: results,
          summary: {
            successRate: (deletedCount / recordingIds.length) * 100
          }
        },
        `Bulk delete completed: ${deletedCount} deleted, ${failedCount} failed`,
        HttpStatus.OK
      );
    }

    // Add other operations (update, archive, publish) here...

    return sendErrorResponse(
      res,
      "Operation not implemented yet",
      HttpStatus.NOT_IMPLEMENTED
    );

  } catch (error) {
    console.error("🔥 bulkRecordingOperations error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to perform bulk operation",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

// =====================================================
// ✅ HELPER FUNCTIONS (Optimized)
// =====================================================

// Helper: Calculate storage cost (simplified)
const calculateStorageCost = (fileSizeInBytes) => {
  const sizeInGB = fileSizeInBytes / (1024 * 1024 * 1024);
  const costPerGBPerMonth = 0.023; // Example: AWS S3 standard storage cost
  return {
    perMonth: sizeInGB * costPerGBPerMonth,
    perYear: sizeInGB * costPerGBPerMonth * 12,
    sizeGB: sizeInGB.toFixed(3)
  };
};

// Helper: Calculate bandwidth used
const calculateBandwidthUsed = (views, fileSizeInBytes) => {
  const sizeInGB = fileSizeInBytes / (1024 * 1024 * 1024);
  return {
    totalGB: (views * sizeInGB).toFixed(3),
    estimatedCost: (views * sizeInGB * 0.09).toFixed(2) // Example: $0.09 per GB
  };
};

// Helper: Validate recording file
const validateRecordingFile = (file) => {
  const errors = [];
  
  if (!file.fileName) errors.push("File name is required");
  if (!file.fileType) errors.push("File type is required");
  
  const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
  if (!allowedTypes.includes(file.fileType)) {
    errors.push(`File type ${file.fileType} not allowed. Allowed: ${allowedTypes.join(', ')}`);
  }
  
  if (file.fileSize && file.fileSize > 2 * 1024 * 1024 * 1024) {
    errors.push("File size exceeds 2GB limit");
  }
  
  return {
    isValid: errors.length === 0,
    errors: errors
  };
};

// =====================================================
// ✅ NOTE: REMOVED DUPLICATE FUNCTIONS
// =====================================================
/*
The following functions have been REMOVED because they already exist 
in the liveSession.controller.js with better implementations:

1. getSessionRecordings() - Use getAllRecordingsDetailed() from liveSession.controller
2. getStreamerRecordings() - Use getMyLiveSessionRecordings() from liveSession.controller  
3. getCourseRecordings() - Already exists in liveSession.controller
4. deleteRecording() - Use deleteSessionRecording() from liveSession.controller

This controller now focuses ONLY on unique recording features:
- Upload management (presigned URLs)
- Download URLs
- Metadata updates
- Search functionality
- Analytics
- Bulk operations
*/

export default {
  getRecordingPresignedUrl,
  saveRecordingToSession,
  getRecordingDownloadUrl,
  updateRecordingMetadata,
  searchRecordings,
  getRecordingAnalytics,
  bulkRecordingOperations
};