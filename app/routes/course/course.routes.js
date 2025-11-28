import { Router } from "express";
const router = Router();
import { verifyToken, checkRole } from '../../middleware/authentication.js';
import { uploadFile } from '../../middleware/aws.s3.js';
import * as courseController from '../../controller/course/course.controller.js';

const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

router.route("/createCourse").post(
    ADMINSTREAMERAuth,
    uploadFile([
        { name: "lectures", maxCount: 10 },
        { name: "thumbnail", maxCount: 1 },
        { name: "assignments", maxCount: 25 }
    ]),
    courseController.createCourse
);

router.route("/getAllCourses").get(
    ADMINSTREAMERVIEWERAuth,
    courseController.getAllCourse
);

router.route("/getSingleCourse/:id").get(
    ADMINSTREAMERVIEWERAuth,
    courseController.getSingleCourse
);

router.route("/updateCourse/:id").put(
    ADMINSTREAMERAuth,
    uploadFile([
        { name: "lectures", maxCount: 10 },
        { name: "thumbnail", maxCount: 1 },
        { name: "assignments", maxCount: 25 }
    ]),
    courseController.updateCourse
);

// ⭐ NEW ROUTE: Delete course + delete files from S3
router.route("/deleteCourse/:id").delete(
    ADMINSTREAMERAuth,
    courseController.deleteCourse
);

export default router;
