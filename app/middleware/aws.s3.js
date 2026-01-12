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

/**
 * ================================
 * HELPERS
 * ================================
 */
const sanitizeFileName = (name) =>
  name.replace(/\s+/g, "_").replace(/[^\w.-]/g, "");

const getContentType = (ext) => {
  const map = {
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  };
  return map[ext] || "application/octet-stream";
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
    ContentType: fileType
  };

  const uploadUrl = await s3.getSignedUrlPromise("putObject", params);

  return {
    uploadUrl,
    fileUrl: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`,
    fileKey
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
  folder = "recordings"
) => {
  try {
    const ext = filePath.split(".").pop().toLowerCase();
    const contentType = getContentType(ext);

    const fileKey = `${folder}/${Date.now()}_${sanitizeFileName(
      sessionId
    )}.${ext}`;

    const params = {
      Bucket: BUCKET_NAME,
      Key: fileKey,
      Body: fs.createReadStream(filePath),
      ContentType: contentType
    };

    const result = await s3.upload(params).promise();

    return {
      fileUrl: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`,
      fileKey,
      s3Response: result
    };
  } catch (err) {
    console.error("❌ S3 Path Upload Error:", err.message);
    throw err;
  }
};

export const uploadSessionRecording = async (filePath, sessionId) => {
  return uploadToS3FromPath(filePath, sessionId, "recordings");
};

/**
 * ============================================================
 * ⚠️ LEGACY – MULTER (DO NOT USE FOR COURSES)
 * ============================================================
 */
const storage = multer.memoryStorage();
const upload = multer({ storage });

export const uploadSingleFile = (field) => upload.single(field);
export const uploadFile = (fields) => upload.fields(fields);

/**
 * ============================================================
 * DELETE FILE FROM S3
 * ============================================================
 */
export const deleteFileFromS3 = async (fileUrl) => {
  try {
    const url = new URL(fileUrl);
    const fileKey = decodeURIComponent(url.pathname.slice(1));

    await s3
      .deleteObject({
        Bucket: BUCKET_NAME,
        Key: fileKey
      })
      .promise();

    return { success: true, fileKey };
  } catch (err) {
    console.error("❌ S3 Delete Error:", err.message);
    throw err;
  }
};

/**
 * ============================================================
 * UTILITIES
 * ============================================================
 */
export const extractFileKeyFromUrl = (fileUrl) => {
  try {
    const url = new URL(fileUrl);
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
};

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
