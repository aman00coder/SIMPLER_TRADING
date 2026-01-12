import { Router } from "express";
const router = Router();

import authenticationRoutes from "./Authentication/authentication.routes.js";
import whiteBoardRoutes from "./whiteBoard/whiteBoard.routes.js";
import liveSessionRoutes from "./liveeSession/liveSession.routes.js";
import liveSessionParticipantRoutes from "./liveSessionParticipant/liveSessionParticipant.routes.js";
import livSessionWhiteBoardRoutes from "./liveSessionWhiteBoard/liveSessionWhiteBoard.routes.js";
import liveChatRoutes from "./liveChat/liveChat.routes.js"
import courseRoutes from "./course/course.routes.js"
import courseLiveSessionRoutes from "./courseLiveSession/courseLiveSession.routes.js"
import adminRoutes from "./Admin/admin.routes.js"
// import streamerRoutes from "./streamer/streamer.routes.js"


router.use("/auth", authenticationRoutes);
router.use("/whiteboard", whiteBoardRoutes);
router.use("/liveSession", liveSessionRoutes);
router.use("/liveSessionParticipant", liveSessionParticipantRoutes);
router.use("/liveSessionWhiteboard", livSessionWhiteBoardRoutes);
router.use("/liveChat", liveChatRoutes);
router.use("/course", courseRoutes);
router.use("/courseLiveSession", courseLiveSessionRoutes);
router.use("/admin", adminRoutes);
// router.use("/streamer", streamerRoutes);


export default router;


