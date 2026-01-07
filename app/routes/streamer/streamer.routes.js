// routes/streamer.routes.js
import { Router } from "express";
import * as streamerController from '../../controller/Streamer/streamer.controller.js';
import { verifyToken, checkRole } from '../../middleware/authentication.js';
import { uploadFile } from '../../middleware/aws.s3.js';
// You'll need to create authentication middleware
// import { authenticate, isStreamer } from '../middleware/auth.js';



const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];

const router = Router();

// Streamer profile routes
router.route("/profile")
  .get(ADMINSTREAMERAuth, streamerController.getStreamerProfile)
  .put(ADMINSTREAMERAuth, streamerController.updateStreamerProfile);

router.route("/request-verification")
  .post( streamerController.requestStreamerVerification);

router.route("/dashboard")
  .get(STREAMERAuth, streamerController.getStreamerDashboard);

export default router;

