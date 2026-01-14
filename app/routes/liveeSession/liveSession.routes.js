// routes/liveSession/liveSession.routes.js

import { Router } from "express";
const router = Router();

import { verifyToken, checkRole } from "../../middleware/authentication.js";
import { uploadFile } from "../../middleware/aws.s3.js";
import * as liveSessionController from "../../controller/liveSession/liveSession.controller.js";

const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

// ================================
// 🎥 LIVE SESSION CORE
// ================================

// ▶️ Start Live Session (AUTO START RECORDING)
router.post(
  "/startLiveSession",
  STREAMERAuth,
  liveSessionController.startLiveSession
);

// ⏸ Pause Live Session (recording continues)
router.post(
  "/pauseLiveSession/:sessionId",
  STREAMERAuth,
  liveSessionController.pauseLiveSession
);

// ▶️ Resume Live Session
router.post(
  "/resumeLiveSession/:sessionId",
  STREAMERAuth,
  liveSessionController.resumeLiveSession
);

// ⏹ End Live Session (STOP RECORDING + UPLOAD TO S3)
router.post(
  "/endLiveSession/:sessionId",
  STREAMERAuth,
  liveSessionController.endLiveSession
);

// ================================
// 🎬 RECORDING (OPTIONAL MANUAL CONTROL)
// ================================

// ▶️ Start Recording manually (if needed)
router.post(
  "/startRecording/:sessionId",
  STREAMERAuth,
  liveSessionController.startLiveSessionRecording
);

// ⏹ Stop Recording manually
router.post(
  "/stopRecording/:sessionId",
  STREAMERAuth,
  liveSessionController.stopLiveSessionRecording
);

router.get(
  "/getLatestRecordingUrl/:sessionId",
  STREAMERAuth,
  liveSessionController.getLatestRecordingUrl
)
// ================================
// 📊 RECORDINGS MANAGEMENT
// ================================

// 📁 Get all recordings of a specific live session
router.get(
  "/:sessionId/recordings",
  ADMINSTREAMERVIEWERAuth,
  liveSessionController.getLiveSessionRecordings
);

// 📁 Get all recordings of current streamer (dashboard)
router.get(
  "/my/recordings",
  STREAMERAuth,
  liveSessionController.getMyLiveSessionRecordings
);

// 🗑 Delete a specific recording from session
router.delete(
  "/:sessionId/recordings/:recordingIndex",
  STREAMERAuth,
  liveSessionController.deleteSessionRecording
);

// ================================
// 📊 ANALYTICS & FETCH
// ================================

router.get(
  "/getSessionAnalytics/:sessionId",
  ADMINSTREAMERVIEWERAuth,
  liveSessionController.getSessionAnalytics
);

router.get(
  "/getAllLiveSessions",
  ADMINSTREAMERVIEWERAuth,
  liveSessionController.getAllLiveSessions
);

router.get(
  "/getLiveSessionsByCourse/:courseId",
  ADMINSTREAMERVIEWERAuth,
  liveSessionController.getLiveSessionsByCourse
);

router.get(
  "/getSingleLiveSession/:sessionId",
  ADMINSTREAMERVIEWERAuth,
  liveSessionController.getSingleLiveSession
);

// ================================
// 🛠 SESSION MANAGEMENT
// ================================

router.patch(
  "/updateLiveSession/:sessionId",
  ADMINSTREAMERAuth,
  liveSessionController.updateLiveSession
);

router.delete(
  "/softDeleteLiveSession/:sessionId",
  ADMINSTREAMERAuth,
  liveSessionController.softDeleteLiveSession
);

router.patch(
  "/restoreLiveSession/:sessionId",
  ADMINSTREAMERAuth,
  liveSessionController.restoreLiveSession
);

// ================================
// 🧾 WHITEBOARD RECORDING (AS IS)
// ================================

router.post(
  "/saveWhiteboardRecording/:whiteboardId",
  ADMINSTREAMERAuth,
  uploadFile([
    { name: "recordingUrl", maxCount: 10 },
    { name: "file", maxCount: 10 }
  ]),
  liveSessionController.saveWhiteboardRecording
);

export default router;