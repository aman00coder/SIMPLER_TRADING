import { Router } from "express";
const router = Router()
import { verifyToken, checkRole } from '../../middleware/authentication.js';
import { uploadFile } from '../../middleware/aws.s3.js';
import * as whiteBoardController from '../../controller/whiteBoards/whiteBoard.controller.js';


const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1,2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1,2,3])];


router.route("/createWhiteboard").post(
    ADMINAuth,
    uploadFile([
    { name: "files", maxCount: 10 },         
    { name: "whiteboardUrl", maxCount: 1 }, 
    { name: "recordingUrl", maxCount: 1 },  
    { name: "file", maxCount: 1 },]),
    whiteBoardController.createWhiteboard
)
router.route("/updateWhiteBoard/:whiteboardId").patch(
    ADMINAuth,
    uploadFile([
    { name: "files", maxCount: 10 },         
    { name: "whiteboardUrl", maxCount: 1 },   
    { name: "recordingUrl", maxCount: 1 },   
    { name: "file", maxCount: 1 },]),
    whiteBoardController.updateWhiteBoard
)
router.route("/getAllWhiteboards").get(
    ADMINSTREAMERVIEWERAuth,
    whiteBoardController.getAllWhiteboards
)
router.route("/getSingleWhiteboard/:whiteboardId").get(
    whiteBoardController.getSingleWhiteboard
)
router.route("/softDeleteWhiteboard/:whiteboardId").delete(
    ADMINSTREAMERAuth,
    whiteBoardController.softDeleteWhiteboard
)
router.route("/restoreWhiteboard/:whiteboardId").patch(
    ADMINSTREAMERAuth,
    whiteBoardController.restoreWhiteboard
)

export default router;


