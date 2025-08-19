import { Router } from "express";
const router = Router()
import { verifyToken, checkRole } from '../../middleware/authentication.js';
import { uploadFile } from '../../middleware/aws.s3.js';
import * as liveSessionController from '../../controller/liveSession/liveSession.controller.js';


const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1,2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

router.route("/startLiveSession").post(
    ADMINSTREAMERAuth,
    liveSessionController.startLiveSession
)
router.route("/pauseLiveSession/:sessionId").post(
    ADMINSTREAMERAuth,
    liveSessionController.pauseLiveSession
)
router.route("/resumeLiveSession/:sessionId").post(
    ADMINSTREAMERAuth,
    liveSessionController.resumeLiveSession
)
router.route("/saveWhiteboardRecording/:whiteboardId").post(
    ADMINSTREAMERAuth,    uploadFile([
    { name: "recordingUrl", maxCount: 10 },         
    { name: "file", maxCount: 10 }
  ]),
    liveSessionController.saveWhiteboardRecording
)
router.route("/getSessionAnalytics/:sessionId").get(
    ADMINSTREAMERVIEWERAuth,
    liveSessionController.getSessionAnalytics
)
router.route("/endLiveSession/:sessionId").post(
    ADMINSTREAMERAuth,
    liveSessionController.endLiveSession
)
router.route("/getAllLiveSessions").get(
    ADMINSTREAMERVIEWERAuth,
    liveSessionController.getAllLiveSessions
)
router.route("/getSingleLiveSession/:sessionId").get(
    ADMINSTREAMERVIEWERAuth,
    liveSessionController.getSingleLiveSession
)
router.route("/updateLiveSession/:sessionId").patch(
    ADMINSTREAMERAuth,
    liveSessionController.updateLiveSession
)
router.route("/softDeleteLiveSession/:sessionId").delete(
    ADMINSTREAMERAuth,
    liveSessionController.softDeleteLiveSession
)
router.route("/restoreLiveSession/:sessionId").patch(
    ADMINSTREAMERAuth,
    liveSessionController.restoreLiveSession
)
export default router;

