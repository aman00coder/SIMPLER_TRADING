import { Router } from "express";
const router = Router();

import authenticationRoutes from "./Authentication/authentication.routes.js";
import whiteBoardRoutes from "./whiteBoard/whiteBoard.routes.js";
import liveSessionRoutes from "./liveSession/liveSession.routes.js";
import liveSessionParticipantRoutes from "./liveSessionParticipant/liveSessionParticipant.routes.js";
import livSessionWhiteBoardRoutes from "./liveSessionWhiteBoard/liveSessionWhiteBoard.routes.js";

router.use("/auth", authenticationRoutes);
router.use("/whiteboard", whiteBoardRoutes);
router.use("/liveSession", liveSessionRoutes);
router.use("/liveSessionParticipant", liveSessionParticipantRoutes);
router.use("/liveSessionWhiteboard", livSessionWhiteBoardRoutes);

export default router;


