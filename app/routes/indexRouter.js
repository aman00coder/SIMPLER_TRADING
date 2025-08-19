import { Router } from "express";
const router = Router();

import authenticationRoutes from "./Authentication/authentication.routes.js";
import whiteBoardRoutes from "./whiteBoard/whiteBoard.routes.js";
import liveSessionRoutes from "./LiveSession/liveSession.routes.js";
import liveSessionParticipantRoutes from "./liveSessionParticipant/liveSessionParticipant.routes.js";

router.use("/auth", authenticationRoutes);
router.use("/whiteboard", whiteBoardRoutes);
router.use("/liveSession", liveSessionRoutes);
router.use("/liveSessionParticipant", liveSessionParticipantRoutes);

export default router;