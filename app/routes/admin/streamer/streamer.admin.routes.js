import { Router } from "express";
import { verifyToken, checkRole } from "../../../middleware/authentication.js";
import {
  getAllStreamers,
    toggleStreamerStatus,
  getSingleStreamer
} from "../../../controller/Admin/streamer.admin.controller.js";

const router = Router();

router.use(verifyToken);
router.use(checkRole(["ADMIN"]));

router.get("/streamers", getAllStreamers);
router.get("/streamers/:streamerId", getSingleStreamer);
router.patch("/streamers/:streamerId/status", toggleStreamerStatus);

export default router;
