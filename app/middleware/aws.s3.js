// middleware/aws.s3.js

import AWS from "aws-sdk";
import multer from "multer";
import fs from "fs";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

/**
 * ================================
 * ENV CHECK
 * ================================
 */
const requiredEnvVars = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "AWS_S3_BUCKET_NAME"
];

requiredEnvVars.forEach((key) => {
  if (!process.env[key]) {
    throw new Error(`❌ Missing environment variable: ${key}`);
  }
});

/**
 * ================================
 * S3 CONFIG
 * ================================
 */
export const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
  signatureVersion: "v4"
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;
const AWS_REGION = process.env.AWS_REGION;

/**
 * ================================
 * HELPERS
 * ================================
 */
const sanitizeFileName = (name) =>
  name.replace(/\s+/g, "_").replace(/[^\w.-]/g, "");

const getContentType = (ext) => {
  const map = {
    // Videos
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    mpg: "video/mpeg",
    // Audio
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    // Documents
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // Images
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    // Text
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json"
  };
  return map[ext.toLowerCase()] || "application/octet-stream";
};

/**
 * ============================================================
 * ✅ GENERATE DOWNLOAD PRE-SIGNED URL (ADDED)
 * ============================================================
 */
export const generateDownloadPresignedUrl = async (
  fileKey,
  expiresIn = 3600, // 1 hour default
  customFileName = null
) => {
  try {
    if (!fileKey) {
      throw new Error("File key is required");
    }

    // Decode fileKey if it's URL encoded
    const decodedKey = decodeURIComponent(fileKey);
    
    const params = {
      Bucket: BUCKET_NAME,
      Key: decodedKey,
      Expires: expiresIn,
      ResponseContentDisposition: customFileName 
        ? `attachment; filename="${customFileName}"`
        : 'attachment'
    };

    const downloadUrl = await s3.getSignedUrlPromise("getObject", params);

    return {
      url: downloadUrl,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      fileKey: decodedKey,
      bucket: BUCKET_NAME,
      region: AWS_REGION
    };

  } catch (error) {
    console.error("🔥 generateDownloadPresignedUrl error:", error.message);
    throw new Error(`Failed to generate download URL: ${error.message}`);
  }
};

/**
 * ============================================================
 * ✅ GENERATE VIEW PRE-SIGNED URL (For streaming/embedding)
 * ============================================================
 */
export const generateViewPresignedUrl = async (
  fileKey,
  expiresIn = 3600
) => {
  try {
    if (!fileKey) {
      throw new Error("File key is required");
    }

    const decodedKey = decodeURIComponent(fileKey);
    
    const params = {
      Bucket: BUCKET_NAME,
      Key: decodedKey,
      Expires: expiresIn
      // No ContentDisposition for viewing (inline)
    };

    const viewUrl = await s3.getSignedUrlPromise("getObject", params);

    return {
      url: viewUrl,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      fileKey: decodedKey
    };

  } catch (error) {
    console.error("🔥 generateViewPresignedUrl error:", error.message);
    throw new Error(`Failed to generate view URL: ${error.message}`);
  }
};

/**
 * ============================================================
 * ✅ PRE-SIGNED URL (MAIN FEATURE – COURSES / LECTURES / FILES)
 * ============================================================
 */
export const generatePresignedUrl = async ({
  fileName,
  fileType,
  folder = "uploads",
  expiresIn = 300 // 5 minutes
}) => {
  const safeName = sanitizeFileName(fileName);
  const fileKey = `${folder}/${Date.now()}_${uuidv4()}_${safeName}`;

  const params = {
    Bucket: BUCKET_NAME,
    Key: fileKey,
    Expires: expiresIn,
    ContentType: fileType,
    // Add metadata for tracking
    Metadata: {
      originalName: fileName,
      uploadedAt: new Date().toISOString(),
      folder: folder
    }
  };

  const uploadUrl = await s3.getSignedUrlPromise("putObject", params);

  return {
    uploadUrl,
    fileUrl: `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${fileKey}`,
    fileKey,
    expiresIn,
    directUrl: `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${fileKey}`,
    metadata: {
      bucket: BUCKET_NAME,
      region: AWS_REGION,
      key: fileKey
    }
  };
};

/**
 * ============================================================
 * ✅ SERVER SIDE UPLOAD (FFMPEG / RECORDINGS ONLY)
 * ============================================================
 */
export const uploadToS3FromPath = async (
  filePath,
  sessionId,
  folder = "recordings",
  customMetadata = {}
) => {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const ext = filePath.split(".").pop().toLowerCase();
    const contentType = getContentType(ext);
    const fileSize = fs.statSync(filePath).size;

    const fileKey = `${folder}/${Date.now()}_${sanitizeFileName(sessionId)}.${ext}`;

    const params = {
      Bucket: BUCKET_NAME,
      Key: fileKey,
      Body: fs.createReadStream(filePath),
      ContentType: contentType,
      ContentLength: fileSize,
      Metadata: {
        sessionId: sessionId,
        originalPath: filePath,
        uploadedAt: new Date().toISOString(),
        fileSize: fileSize.toString(),
        ...customMetadata
      }
    };

    const result = await s3.upload(params).promise();

    // Generate download URL
    const downloadUrl = await generateDownloadPresignedUrl(fileKey, 3600);

    return {
      fileUrl: `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${fileKey}`,
      fileKey,
      fileSize,
      contentType,
      downloadUrl: downloadUrl.url,
      s3Response: result,
      metadata: {
        bucket: BUCKET_NAME,
        region: AWS_REGION,
        etag: result.ETag,
        versionId: result.VersionId
      }
    };
  } catch (err) {
    console.error("❌ S3 Path Upload Error:", err.message);
    throw err;
  }
};

export const uploadSessionRecording = async (filePath, sessionId, metadata = {}) => {
  return uploadToS3FromPath(filePath, sessionId, "recordings", {
    type: "live-recording",
    sessionId: sessionId,
    ...metadata
  });
};

/**
 * ============================================================
 * ⚠️ LEGACY – MULTER (DO NOT USE FOR COURSES)
 * ============================================================
 */
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB max
    files: 10 // Max 10 files
  }
});

export const uploadSingleFile = (field) => upload.single(field);
export const uploadFile = (fields) => upload.fields(fields);

/**
 * ============================================================
 * DELETE FILE FROM S3
 * ============================================================
 */
export const deleteFileFromS3 = async (fileUrl) => {
  try {
    let fileKey;
    
    if (fileUrl.startsWith('http')) {
      // Extract key from URL
      const url = new URL(fileUrl);
      fileKey = decodeURIComponent(url.pathname.slice(1));
    } else {
      // Assume it's already a key
      fileKey = decodeURIComponent(fileUrl);
    }

    if (!fileKey) {
      throw new Error("Invalid file URL or key");
    }

    const result = await s3
      .deleteObject({
        Bucket: BUCKET_NAME,
        Key: fileKey
      })
      .promise();

    console.log(`✅ Deleted from S3: ${fileKey}`);
    
    return { 
      success: true, 
      fileKey,
      deletedAt: new Date(),
      s3Response: result
    };
  } catch (err) {
    console.error("❌ S3 Delete Error:", err.message);
    throw err;
  }
};

/**
 * ============================================================
 * BULK DELETE FILES
 * ============================================================
 */
export const bulkDeleteFromS3 = async (fileKeys) => {
  try {
    if (!Array.isArray(fileKeys) || fileKeys.length === 0) {
      throw new Error("File keys array is required");
    }

    // Max 1000 objects per delete request (AWS limit)
    const chunks = [];
    for (let i = 0; i < fileKeys.length; i += 1000) {
      chunks.push(fileKeys.slice(i, i + 1000));
    }

    const results = [];

    for (const chunk of chunks) {
      const deleteParams = {
        Bucket: BUCKET_NAME,
        Delete: {
          Objects: chunk.map(key => ({ Key: key })),
          Quiet: false // Return errors
        }
      };

      const result = await s3.deleteObjects(deleteParams).promise();
      results.push(result);
    }

    const deleted = results.flatMap(r => r.Deleted || []);
    const errors = results.flatMap(r => r.Errors || []);

    return {
      success: errors.length === 0,
      deletedCount: deleted.length,
      errorCount: errors.length,
      deleted: deleted,
      errors: errors,
      totalRequested: fileKeys.length
    };

  } catch (err) {
    console.error("❌ Bulk Delete Error:", err.message);
    throw err;
  }
};

/**
 * ============================================================
 * ✅ PRE-SIGNED URL FOR FFMPEG RECORDINGS
 * ============================================================
 */
export const generateRecordingPresignedUrl = async ({
  sessionId,
  fileName,
  fileType = "video/mp4",
  folder = "live-recordings",
  expiresIn = 3600, // 1 hour for recordings
  metadata = {}
}) => {
  try {
    if (!sessionId || !fileName) {
      throw new Error("sessionId and fileName are required");
    }

    const safeName = sanitizeFileName(fileName);
    const timestamp = Date.now();
    const uniqueId = uuidv4().slice(0, 8);
    const fileKey = `${folder}/${sessionId}/${timestamp}_${uniqueId}_${safeName}`;

    const params = {
      Bucket: BUCKET_NAME,
      Key: fileKey,
      Expires: expiresIn,
      ContentType: fileType,
      // Add comprehensive metadata
      Metadata: {
        sessionId: sessionId,
        originalName: fileName,
        uploadedAt: new Date().toISOString(),
        source: "live-recording",
        uploadType: "manual",
        ...metadata
      }
    };

    const uploadUrl = await s3.getSignedUrlPromise("putObject", params);

    // Also generate download URL for later use
    const downloadUrl = await generateDownloadPresignedUrl(fileKey, 3600 * 24 * 7); // 7 days

    return {
      uploadUrl,
      fileUrl: `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${fileKey}`,
      fileKey,
      expiresIn,
      downloadUrl: downloadUrl.url,
      directUrl: `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${fileKey}`,
      metadata: {
        bucket: BUCKET_NAME,
        region: AWS_REGION,
        key: fileKey,
        sessionId,
        timestamp
      }
    };
  } catch (error) {
    console.error("❌ Recording Presigned URL Error:", error.message);
    throw error;
  }
};

/**
 * ============================================================
 * ✅ GET FILE METADATA/INFO
 * ============================================================
 */
export const getFileInfo = async (fileKey) => {
  try {
    const decodedKey = decodeURIComponent(fileKey);
    
    const headData = await s3
      .headObject({
        Bucket: BUCKET_NAME,
        Key: decodedKey
      })
      .promise();

    const url = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${decodedKey}`;
    const downloadUrl = await generateDownloadPresignedUrl(decodedKey, 3600);

    return {
      exists: true,
      key: decodedKey,
      url: url,
      downloadUrl: downloadUrl.url,
      size: headData.ContentLength,
      contentType: headData.ContentType,
      lastModified: headData.LastModified,
      metadata: headData.Metadata,
      etag: headData.ETag,
      storageClass: headData.StorageClass,
      expires: headData.Expires
    };
  } catch (err) {
    if (err.code === "NotFound") {
      return { exists: false, key: fileKey };
    }
    throw err;
  }
};

/**
 * ============================================================
 * ✅ COPY/MOVE FILE IN S3
 * ============================================================
 */
export const copyFileInS3 = async (sourceKey, destinationKey, deleteSource = false) => {
  try {
    const copyParams = {
      Bucket: BUCKET_NAME,
      CopySource: `/${BUCKET_NAME}/${encodeURIComponent(sourceKey)}`,
      Key: destinationKey
    };

    await s3.copyObject(copyParams).promise();

    if (deleteSource) {
      await deleteFileFromS3(sourceKey);
    }

    const newUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${destinationKey}`;

    return {
      success: true,
      sourceKey,
      destinationKey,
      newUrl,
      copiedAt: new Date()
    };
  } catch (err) {
    console.error("❌ S3 Copy Error:", err.message);
    throw err;
  }
};

/**
 * ============================================================
 * ✅ LIST FILES IN FOLDER
 * ============================================================
 */
export const listFilesInFolder = async (folder, maxKeys = 1000) => {
  try {
    const params = {
      Bucket: BUCKET_NAME,
      Prefix: folder,
      MaxKeys: maxKeys
    };

    const data = await s3.listObjectsV2(params).promise();

    const files = (data.Contents || []).map(item => ({
      key: item.Key,
      size: item.Size,
      lastModified: item.LastModified,
      storageClass: item.StorageClass,
      url: `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${item.Key}`
    }));

    return {
      folder,
      files,
      count: files.length,
      isTruncated: data.IsTruncated,
      nextContinuationToken: data.NextContinuationToken
    };
  } catch (err) {
    console.error("❌ List Files Error:", err.message);
    throw err;
  }
};

/**
 * ============================================================
 * ✅ CHECK FILE EXISTS
 * ============================================================
 */
export const checkFileExistsInS3 = async (fileKey) => {
  try {
    await s3
      .headObject({
        Bucket: BUCKET_NAME,
        Key: fileKey
      })
      .promise();
    return true;
  } catch (err) {
    if (err.code === "NotFound") return false;
    throw err;
  }
};

/**
 * ============================================================
 * ✅ EXTRACT FILE KEY FROM URL
 * ============================================================
 */
export const extractFileKeyFromUrl = (fileUrl) => {
  try {
    if (!fileUrl) return null;
    
    if (fileUrl.startsWith(`https://${BUCKET_NAME}.s3.`)) {
      const url = new URL(fileUrl);
      return decodeURIComponent(url.pathname.slice(1));
    }
    
    // Try to parse as URL
    try {
      const url = new URL(fileUrl);
      return decodeURIComponent(url.pathname.slice(1));
    } catch {
      // If it's not a valid URL, assume it's already a key
      return decodeURIComponent(fileUrl);
    }
  } catch {
    return null;
  }
};

/**
 * ============================================================
 * ✅ GENERATE PUBLIC URL (No signature - for public files)
 * ============================================================
 */
export const generatePublicUrl = (fileKey) => {
  return `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${encodeURIComponent(fileKey)}`;
};

/**
 * ============================================================
 * ✅ GENERATE EMBED URL (For video/audio players)
 * ============================================================
 */
export const generateEmbedUrl = async (fileKey, expiresIn = 86400) => {
  try {
    const info = await getFileInfo(fileKey);
    
    if (!info.exists) {
      throw new Error("File not found");
    }

    const isVideo = info.contentType?.startsWith('video/');
    const isAudio = info.contentType?.startsWith('audio/');
    const isImage = info.contentType?.startsWith('image/');

    let embedUrl;
    
    if (isVideo || isAudio) {
      // For media files, use view URL (inline)
      const viewData = await generateViewPresignedUrl(fileKey, expiresIn);
      embedUrl = viewData.url;
    } else {
      // For other files, use download URL
      const downloadData = await generateDownloadPresignedUrl(fileKey, expiresIn);
      embedUrl = downloadData.url;
    }

    return {
      url: embedUrl,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      contentType: info.contentType,
      fileType: isVideo ? 'video' : isAudio ? 'audio' : isImage ? 'image' : 'document',
      size: info.size,
      supportsEmbed: isVideo || isAudio || isImage
    };
  } catch (error) {
    console.error("🔥 generateEmbedUrl error:", error.message);
    throw error;
  }
};