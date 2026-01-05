import { Router } from "express";
const router = Router()
import { verifyToken, checkRole } from '../../middleware/authentication.js';
import { uploadFile } from '../../middleware/aws.s3.js';
import * as liveSessionWhiteBoardController from '../../controller/liveSessionWhiteBoard/liveSessionWhiteBoard.controller.js';


const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1,2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

router.route("/saveliveSessionRecording/:sessionId").post(
    ADMINSTREAMERAuth,
    uploadFile([
        { name: "recordingUrl", maxCount: 10 },         
        { name: "file", maxCount: 10 }
    ])    
    , liveSessionWhiteBoardController.saveliveSessionRecording
)
router.route("/getAllLiveSessionRecording/:sessionId").get(
    ADMINSTREAMERVIEWERAuth,
    liveSessionWhiteBoardController.getAllLiveSessionRecording
)
router.route("/saveWhiteBoardRecording/:whiteboardId").post(
    ADMINSTREAMERAuth,
    uploadFile([
        { name: "recordingUrl", maxCount: 10 },         
        { name: "file", maxCount: 10 }
    ])
    , liveSessionWhiteBoardController.saveWhiteBoardRecording
)
export default router;