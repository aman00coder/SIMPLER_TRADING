// routes/liveSession/recording.routes.js
import { Router } from "express";
const router = Router();

import { verifyToken, checkRole } from "../../middleware/authentication.js";
import * as recordingController from "../../controller/recording/recording.controller.js"; // ✅ Path corrected

const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];
const ANYAUTH = [verifyToken]; // Any authenticated user

// ================================
// 📁 RECORDING UPLOAD & DOWNLOAD
// ================================

// ✅ 1. Get upload URL for manual recording upload
router.post(
    "/:sessionId/upload-url",
    ADMINSTREAMERAuth,
    recordingController.getRecordingPresignedUrl
);

// ✅ 2. Save manually uploaded recording metadata
router.post(
    "/:sessionId/save",
    ADMINSTREAMERAuth,
    recordingController.saveRecordingToSession
);

// ✅ 3. Get download URL for a recording
router.get(
    "/:sessionId/:recordingId/download",
    ANYAUTH,
    recordingController.getRecordingDownloadUrl
);

// ================================
// 📁 RECORDING MANAGEMENT
// ================================

// ✅ 4. Update recording metadata
router.patch(
    "/:sessionId/:recordingId/metadata",
    ADMINSTREAMERAuth,
    recordingController.updateRecordingMetadata
);

// ✅ 5. Get recording analytics
router.get(
    "/:sessionId/:recordingId/analytics",
    ADMINSTREAMERAuth,
    recordingController.getRecordingAnalytics
);

// ✅ 6. Search recordings across all sessions
router.get(
    "/search",
    ANYAUTH,
    recordingController.searchRecordings
);

// ✅ 7. Bulk recording operations
router.post(
    "/bulk-operations",
    ADMINSTREAMERAuth,
    recordingController.bulkRecordingOperations
);

// ================================
// ❌ REMOVED ROUTES (Moved to liveSession.routes.js)
// ================================
/*
NOTE: The following routes have been REMOVED because:
1. They already exist in liveSession.controller.js
2. They are session-related, not recording-specific

REMOVED:
1. GET /session/:sessionId  ➡️ Use GET /live-sessions/:sessionId/recordings-detailed
2. GET /streamer/recordings ➡️ Use GET /live-sessions/my/recordings  
3. GET /course/:courseId/recordings ➡️ Use GET /live-sessions/course/:courseId/recordings
4. DELETE /:sessionId/:recordingId ➡️ Use DELETE /live-sessions/:sessionId/recordings/:recordingId
*/

export default router;