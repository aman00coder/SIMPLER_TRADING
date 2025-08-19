import { Router } from "express";
const router = Router()
import { verifyToken, checkRole } from '../../middleware/authentication.js';
import { uploadFile } from '../../middleware/aws.s3.js';
import * as liveSessionParticipantController from '../../controller/liveSessionParticipants/liveSessionParticipant.controller.js';


const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1,2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

router.route("/joinParticipant/:sessionId").post(
    ADMINSTREAMERVIEWERAuth,
    liveSessionParticipantController.joinParticipant
)
router.route("/leaveParticipant/:sessionId").post(
    ADMINSTREAMERVIEWERAuth,
    liveSessionParticipantController.leaveParticipant
)
router.route("/getSessionParticipants/:sessionId").get(
    ADMINSTREAMERVIEWERAuth,
    liveSessionParticipantController.getSessionParticipants
)
router.route("/getSingleParticipant/:sessionId/:userId").get(
    ADMINSTREAMERVIEWERAuth,
    liveSessionParticipantController.getSingleParticipant
)
router.route("/removeParticipantBySocket").post(
    ADMINSTREAMERVIEWERAuth,
    (req, res) => {
        const { socketId } = req.body;
        liveSessionParticipantController.removeParticipantBySocket(socketId)
            .then(participant => {
                if (!participant) return res.status(404).json({ message: "Participant not found" });
                res.status(200).json({ message: "Participant removed successfully", participant });
            })
            .catch(err => res.status(500).json({ message: "Internal server error", error: err.message }));
    }
)

export default router;