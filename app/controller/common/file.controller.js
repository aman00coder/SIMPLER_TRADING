// controllers/common/file.controller.js

import HttpStatus from "http-status-codes";
import path from "path";
import { generatePresignedUrl } from "../../middleware/pre-signed.url.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";

// =====================================================
// HELPERS
// =====================================================
const sanitizeFileName = (fileName) => {
  const base = path.basename(fileName);
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
};

const allowedTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain"
];

// =====================================================
// Generate Single Pre-Signed URL
// =====================================================
export const getPresignedUrl = async (req, res) => {
  try {
    let { fileName, fileType, folder, fileSize } = req.body;

    if (!fileName || !fileType) {
      return sendErrorResponse(
        res,
        "fileName and fileType are required",
        HttpStatus.BAD_REQUEST
      );
    }

    if (!allowedTypes.includes(fileType)) {
      return sendErrorResponse(
        res,
        `File type not allowed: ${fileType}`,
        HttpStatus.BAD_REQUEST
      );
    }

    // 🔐 Optional size limit (example: 500MB for videos)
    if (fileSize && fileSize > 500 * 1024 * 1024) {
      return sendErrorResponse(
        res,
        "File size exceeds 500MB limit",
        HttpStatus.BAD_REQUEST
      );
    }

    // 🔒 Sanitize filename
    const safeFileName = sanitizeFileName(fileName);

    const result = await generatePresignedUrl({
      fileName: safeFileName,
      fileType,
      folder: folder || "uploads"
    });

    return sendSuccessResponse(
      res,
      {
        uploadUrl: result.uploadUrl,
        fileUrl: result.fileUrl,
        fileKey: result.fileKey,
        expiresIn: result.expiresIn
      },
      "Presigned URL generated successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ Presigned URL error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to generate presigned URL",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

// =====================================================
// Generate Multiple Pre-Signed URLs (Bulk Upload)
// =====================================================
export const getBulkPresignedUrls = async (req, res) => {
  try {
    const { files } = req.body;

    if (!Array.isArray(files) || files.length === 0) {
      return sendErrorResponse(
        res,
        "files array is required",
        HttpStatus.BAD_REQUEST
      );
    }

    if (files.length > 10) {
      return sendErrorResponse(
        res,
        "Maximum 10 files allowed per request",
        HttpStatus.BAD_REQUEST
      );
    }

    const results = await Promise.all(
      files.map(async (file) => {
        try {
          if (!file?.fileName || !file?.fileType) {
            throw new Error("fileName and fileType required");
          }

          if (!allowedTypes.includes(file.fileType)) {
            throw new Error(`File type not allowed: ${file.fileType}`);
          }

          const safeFileName = sanitizeFileName(file.fileName);

          const result = await generatePresignedUrl({
            fileName: safeFileName,
            fileType: file.fileType,
            folder: file.folder || "uploads"
          });

          return {
            originalName: file.fileName,
            uploadUrl: result.uploadUrl,
            fileUrl: result.fileUrl,
            fileKey: result.fileKey,
            expiresIn: result.expiresIn,
            success: true
          };
        } catch (err) {
          return {
            originalName: file?.fileName || null,
            success: false,
            error: err.message
          };
        }
      })
    );

    return sendSuccessResponse(
      res,
      { files: results },
      "Bulk presigned URLs generated successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ Bulk presigned URL error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to generate bulk presigned URLs",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};


// =====================================================
// Generate Pre-Signed URL for Recording Files
// =====================================================
export const getRecordingPresignedUrl = async (req, res) => {
  try {
    let { fileName, fileType, sessionId, fileSize } = req.body;

    if (!fileName || !fileType || !sessionId) {
      return sendErrorResponse(
        res,
        "fileName, fileType and sessionId are required",
        HttpStatus.BAD_REQUEST
      );
    }

    // Only allow video formats for recordings
    const recordingAllowedTypes = [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska"
    ];

    if (!recordingAllowedTypes.includes(fileType)) {
      return sendErrorResponse(
        res,
        `Recording file type not allowed: ${fileType}`,
        HttpStatus.BAD_REQUEST
      );
    }

    // 🔐 Size limit for recordings (1GB)
    if (fileSize && fileSize > 1024 * 1024 * 1024) {
      return sendErrorResponse(
        res,
        "Recording file size exceeds 1GB limit",
        HttpStatus.BAD_REQUEST
      );
    }

    // 🔒 Sanitize filename with session prefix
    const safeFileName = `recording_${sessionId}_${Date.now()}_${sanitizeFileName(fileName)}`;

    const result = await generatePresignedUrl({
      fileName: safeFileName,
      fileType,
      folder: "live-recordings" // Special folder for recordings
    });

    return sendSuccessResponse(
      res,
      {
        uploadUrl: result.uploadUrl,
        fileUrl: result.fileUrl,
        fileKey: result.fileKey,
        expiresIn: result.expiresIn,
        sessionId,
        fileName: safeFileName
      },
      "Recording upload URL generated successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ Recording Presigned URL error:", error.message);
    return sendErrorResponse(
      res,
      "Failed to generate recording upload URL",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};