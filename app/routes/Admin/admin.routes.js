// routes/admin.routes.js
import { Router } from "express";
import * as adminController from '../../controller/Admin/admin.controller.js';
import { verifyToken, checkRole } from '../../middleware/authentication.js';
import { uploadFile } from '../../middleware/aws.s3.js';

const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];
const router = Router();

// Admin streamer management routes
router.route("/streamers")
  .get(ADMINAuth, adminController.getAllStreamers);

router.route("/streamers/stats")
  .get(ADMINAuth, adminController.getStreamerStats);

router.route("/streamers/:streamerId/approve")
  .put(ADMINAuth, adminController.approveStreamer);

router.route("/streamers/:streamerId/suspend")
  .put(ADMINAuth, adminController.suspendStreamer);

  router.route("/streamers/:streamerId/reactivate")
  .put(ADMINAuth, adminController.reactivateStreamer);

export default router;