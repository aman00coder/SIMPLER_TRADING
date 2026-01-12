import { Router } from "express";
const router = Router();

import { verifyToken } from "../../middleware/authentication.js";
import {
  getPresignedUrl,
  getBulkPresignedUrls
} from "../../controller/common/file.controller.js";

/**
 * =================================================
 * FILE UPLOAD – PRE-SIGNED URL ROUTES
 * =================================================
 * Frontend will call these APIs to get S3 upload URL
 */

// 🔹 Single file pre-signed URL
router.post(
  "/presigned-url",
  verifyToken,          // 🔐 login required
  getPresignedUrl
);

// 🔹 Multiple files pre-signed URLs
router.post(
  "/presigned-url/bulk",
  verifyToken,
  getBulkPresignedUrls
);

export default router;
