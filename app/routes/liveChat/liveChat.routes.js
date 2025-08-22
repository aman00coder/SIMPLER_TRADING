import { Router } from "express";
const router = Router()
import { verifyToken, checkRole } from '../../middleware/authentication.js';
import { uploadFile } from '../../middleware/aws.s3.js';
import * as liveChatController from '../../controller/liveChat/liveChat.controller.js';


const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1,2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

router.route("/sendMessage").post(
    ADMINSTREAMERVIEWERAuth,
        uploadFile([
            { name: "fileUrl", maxCount: 1 },]),
    liveChatController.sendMessage
)
router.route("/fetchMessages").get(
    ADMINSTREAMERVIEWERAuth,
    liveChatController.fetchMessages
)
router.route("/deleteMessage/:messageId").delete(
    ADMINSTREAMERVIEWERAuth,
    liveChatController.deleteMessage
)
router.route("/editMessage/:messageId").patch(
    ADMINSTREAMERVIEWERAuth,
    liveChatController.editMessage
)
router.route("/reactMessage/:messageId").patch(
    ADMINSTREAMERVIEWERAuth,
    liveChatController.reactMessage
)
router.route("/pinMessage/:messageId").patch(
    ADMINSTREAMERVIEWERAuth,
    liveChatController.pinMessage
)
router.route("/markSeenMessage/:messageId").patch(
    ADMINSTREAMERVIEWERAuth,
    liveChatController.markSeenMessage
)
router.route("/fetchThread/:parentMessageId").get(
    ADMINSTREAMERVIEWERAuth,
    liveChatController.fetchThread
)
export default router;