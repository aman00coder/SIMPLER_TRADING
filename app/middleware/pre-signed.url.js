import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { s3 } from "./aws.s3.js"; // reuse same S3 instance

dotenv.config();


/**
 * =========================================
 * Generate Pre-Signed URL for S3 Upload
 * =========================================
 * Used for:
 * - Course thumbnail
 * - Lecture videos
 * - Assignments / PDFs
 * - Frontend direct uploads
 */

export const generatePresignedUrl = async ({
  fileName,
  fileType,
  folder = "uploads",
  expiresIn = 300 // default 5 minutes
}) => {
  try {
    if (!fileName || !fileType) {
      throw new Error("fileName and fileType are required");
    }

    const bucketName = process.env.AWS_S3_BUCKET_NAME;
    const region = process.env.AWS_REGION;

    if (!bucketName || !region) {
      throw new Error("AWS bucket or region not configured");
    }

    // 🔒 Sanitize file name (extra safe)
    const sanitizedFileName = String(fileName)
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^\w.-]/g, "");

    // 🔑 Unique S3 object key
    const fileKey = `${folder}/${Date.now()}_${uuidv4()}_${sanitizedFileName}`;

    const params = {
      Bucket: bucketName,
      Key: fileKey,
      Expires: expiresIn,
      ContentType: fileType
    };

    // 🔐 Generate signed URL (PUT)
    const uploadUrl = await s3.getSignedUrlPromise("putObject", params);

    return {
      uploadUrl,
      fileUrl: `https://${bucketName}.s3.${region}.amazonaws.com/${fileKey}`,
      fileKey,
      expiresIn
    };

  } catch (error) {
    console.error("❌ [PreSignedURL ERROR]:", error.message);
    throw error; // bubble exact error (debug friendly)
  }
};
