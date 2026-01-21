// routes/liveSession/recording.routes.js
import { Router } from "express";
const router = Router();

import { verifyToken, checkRole } from "../../middleware/authentication.js";
import * as recordingController from "../../controller/recording/recording.controller.js";

const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

// ================================
// 📁 RECORDING MANAGEMENT
// ================================

// 🔹 Get pre-signed URL for recording upload
router.post(
    "/:sessionId/get-upload-url",
    STREAMERAuth,
    recordingController.getRecordingPresignedUrl
);

// 🔹 Save recording metadata after upload
router.post(
    "/:sessionId/save",
    STREAMERAuth,
    recordingController.saveRecordingToSession
);

// 🔹 Get all recordings for a session
router.get(
    "/session/:sessionId",
    ADMINSTREAMERVIEWERAuth,
    recordingController.getSessionRecordings
);

// 🔹 Get recordings by streamer (dashboard)
router.get(
    "/streamer/recordings",
    STREAMERAuth,
    recordingController.getStreamerRecordings
);

// 🔹 Get recordings by course
router.get(
    "/course/:courseId/recordings",
    ADMINSTREAMERVIEWERAuth,
    recordingController.getCourseRecordings
);

// 🔹 Delete a recording
router.delete(
    "/:sessionId/:recordingId",
    STREAMERAuth,
    recordingController.deleteRecording
);

export default router;