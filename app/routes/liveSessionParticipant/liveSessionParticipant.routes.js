import { Router } from "express";
const router = Router();
import { verifyToken, checkRole } from '../../middleware/authentication.js';
import * as liveSessionParticipantController from '../../controller/liveSessionParticipants/liveSessionParticipant.controller.js';

const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

// ===========================
// Participant Join/Leave
// ===========================
router.post(
  "/joinParticipant/:sessionId",
  ADMINSTREAMERVIEWERAuth,
  liveSessionParticipantController.joinParticipant
);

router.post(
  "/leaveParticipant/:sessionId",
  ADMINSTREAMERVIEWERAuth,
  liveSessionParticipantController.leaveParticipant
);

// ===========================
// Get Participants
// ===========================
router.get(
  "/getSessionParticipants/:sessionId",
  ADMINSTREAMERVIEWERAuth,
  liveSessionParticipantController.getSessionParticipants
);

router.get(
  "/getSingleParticipant/:sessionId/:userId",
  ADMINSTREAMERVIEWERAuth,
  liveSessionParticipantController.getSingleParticipant
);

// ===========================
// Engagement Updates
// ===========================
router.put(
  "/session/:sessionId/participant/:participantId/engagement",
  ADMINSTREAMERVIEWERAuth,  
  liveSessionParticipantController.updateEngagement
);

router.put(
  "/session/:sessionId/participant/:participantId/network",
  ADMINSTREAMERVIEWERAuth,
  liveSessionParticipantController.updateNetworkStats
);

router.put(
  "/session/:sessionId/participant/:participantId/chat",
  ADMINSTREAMERVIEWERAuth,
  liveSessionParticipantController.updateChatCount
);

// ===========================
// Moderation Actions
// ===========================
router.put(
  "/session/:sessionId/participant/:participantId/kick",
  ADMINSTREAMERAuth, // ✅ Only Admin/Streamer can kick
  liveSessionParticipantController.kickParticipant
);

router.put(
  "/session/:sessionId/participant/:participantId/toggleBanParticipant",
  ADMINSTREAMERAuth, // ✅ Only Admin/Streamer can ban
  liveSessionParticipantController.toggleBanParticipant
);

export default router;
