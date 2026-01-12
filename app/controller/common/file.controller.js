// controllers/common/file.controller.js

import HttpStatus from "http-status-codes";
import { generatePresignedUrl } from "../../middleware/pre-signed.url.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";

/**
 * =================================================
 * Generate Single Pre-Signed URL
 * =================================================
 */
export const getPresignedUrl = async (req, res) => {
  try {
    const { fileName, fileType, folder } = req.body;

    // Basic validation
    if (!fileName || !fileType) {
      return sendErrorResponse(
        res,
        "fileName and fileType are required",
        HttpStatus.BAD_REQUEST
      );
    }

    // Allowed MIME types
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

    if (!allowedTypes.includes(fileType)) {
      return sendErrorResponse(
        res,
        `File type not allowed: ${fileType}`,
        HttpStatus.BAD_REQUEST
      );
    }

    // Generate signed URL
    const result = await generatePresignedUrl({
      fileName,
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

/**
 * =================================================
 * Generate Multiple Pre-Signed URLs (Bulk Upload)
 * =================================================
 */
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
          if (!file.fileName || !file.fileType) {
            throw new Error("fileName and fileType required");
          }

          const result = await generatePresignedUrl({
            fileName: file.fileName,
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
            originalName: file?.fileName,
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
