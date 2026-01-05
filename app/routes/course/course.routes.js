// import { Router } from "express";
// const router = Router();
// import { verifyToken, checkRole } from '../../middleware/authentication.js';
// import { uploadFile } from '../../middleware/aws.s3.js';
// import * as courseController from '../../controller/course/course.controller.js';

// const ADMINAuth = [verifyToken, checkRole([1])];
// const STREAMERAuth = [verifyToken, checkRole([2])];
// const VIEWERAuth = [verifyToken, checkRole([3])];
// const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
// const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

// router.route("/createCourse").post(
//     ADMINSTREAMERAuth,
//     uploadFile([
//         { name: "lectures", maxCount: 10 },
//         { name: "thumbnail", maxCount: 1 },
//         { name: "assignments", maxCount: 25 }
//     ]),
//     courseController.createCourse
// );

// router.route("/getAllCourses").get(
//     ADMINSTREAMERVIEWERAuth,
//     courseController.getAllCourse
// );

// router.route("/getSingleCourse/:id").get(
//     ADMINSTREAMERVIEWERAuth,
//     courseController.getSingleCourse
// );

// router.route("/updateCourse/:id").put(
//     ADMINSTREAMERAuth,
//     uploadFile([
//         { name: "lectures", maxCount: 10 },
//         { name: "thumbnail", maxCount: 1 },
//         { name: "assignments", maxCount: 25 }
//     ]),
//     courseController.updateCourse
// );

// // ⭐ NEW ROUTE: Delete course + delete files from S3
// router.route("/deleteCourse/:id").delete(
//     ADMINSTREAMERAuth,
//     courseController.deleteCourse
// );

// export default router;





// import { Router } from "express";
// const router = Router();
// import { verifyToken, checkRole } from '../../middleware/authentication.js';
// import { uploadFile } from '../../middleware/aws.s3.js';
// import * as courseController from '../../controller/course/course.controller.js';

// const ADMINAuth = [verifyToken, checkRole([1])];
// const STREAMERAuth = [verifyToken, checkRole([2])];
// const VIEWERAuth = [verifyToken, checkRole([3])];
// const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
// const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

// router.route("/createCourse").post(
//     ADMINSTREAMERAuth,
//     uploadFile([
//         { name: "lectures", maxCount: 10 },
//         { name: "thumbnail", maxCount: 1 },
//         { name: "assignments", maxCount: 25 }
//     ]),
//     courseController.createCourse
// );

// router.route("/getAllCourses").get(

//     courseController.getAllCourse
// );

// router.route("/getSingleCourse/:id").get(
//     ADMINSTREAMERVIEWERAuth,
//     courseController.getSingleCourse
// );

// router.route("/updateCourse/:id").put(
//     ADMINSTREAMERAuth,
//     uploadFile([
//         { name: "lectures", maxCount: 10 },
//         { name: "thumbnail", maxCount: 1 },
//         { name: "assignments", maxCount: 25 }
//     ]),
//     courseController.updateCourse
// );

// router.route("/deleteCourse/:id").delete(
//     ADMINSTREAMERAuth,
//     courseController.deleteCourse
// );

// // ✅ NEW ROUTES FOR CONTENT MANAGEMENT
// router.route("/:courseId/addLecture").post(
//     ADMINSTREAMERAuth,
//     uploadFile([{ name: "file", maxCount: 1 }]),
//     courseController.addLecture
// );

// router.route("/:courseId/removeLecture/:lectureId").delete(
//     ADMINSTREAMERAuth,
//     courseController.removeLecture
// );

// router.route("/:courseId/addAssignment").post(
//     ADMINSTREAMERAuth,
//     uploadFile([{ name: "resources", maxCount: 25 }]),
//     courseController.addAssignment
// );

// router.route("/:courseId/removeAssignment/:assignmentId").delete(
//     ADMINSTREAMERAuth,
//     courseController.removeAssignment
// );

// export default router;




// import { Router } from "express";
// const router = Router();
// import { verifyToken, checkRole } from '../../middleware/authentication.js';
// import { uploadFile } from '../../middleware/aws.s3.js';
// import * as courseController from '../../controller/course/course.controller.js';

// const ADMINAuth = [verifyToken, checkRole([1])];
// const STREAMERAuth = [verifyToken, checkRole([2])];
// const VIEWERAuth = [verifyToken, checkRole([3])];
// const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
// const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

// // Course CRUD Operations
// router.route("/createCourse").post(
//     ADMINSTREAMERAuth,
//     uploadFile([
//         { name: "lectures", maxCount: 10 },
//         { name: "thumbnail", maxCount: 1 },
//         { name: "assignments", maxCount: 25 }
//     ]),
//     courseController.createCourse
// );

// router.route("/getAllCourses").get(
//     courseController.getAllCourse
// );

// router.route("/getSingleCourse/:id").get(
//     ADMINSTREAMERVIEWERAuth,
//     courseController.getSingleCourse
// );

// router.route("/updateCourse/:id").put(
//     ADMINSTREAMERAuth,
//     uploadFile([
//         { name: "lectures", maxCount: 10 },
//         { name: "thumbnail", maxCount: 1 },
//         { name: "assignments", maxCount: 25 }
//     ]),
//     courseController.updateCourse
// );

// router.route("/deleteCourse/:id").delete(
//     ADMINSTREAMERAuth,
//     courseController.deleteCourse
// );

// // Content Management Routes
// router.route("/:courseId/addLecture").post(
//     ADMINSTREAMERAuth,
//     uploadFile([{ name: "file", maxCount: 1 }]),
//     courseController.addLecture
// );

// router.route("/:courseId/removeLecture/:lectureId").delete(
//     ADMINSTREAMERAuth,
//     courseController.removeLecture
// );

// router.route("/:courseId/addAssignment").post(
//     ADMINSTREAMERAuth,
//     uploadFile([{ name: "resources", maxCount: 25 }]),
//     courseController.addAssignment
// );

// router.route("/:courseId/removeAssignment/:assignmentId").delete(
//     ADMINSTREAMERAuth,
//     courseController.removeAssignment
// );

// // Enrollment Routes
// router.route("/:courseId/enroll").post(
//     VIEWERAuth,
//     courseController.enrollInCourse
// );

// router.route("/:courseId/unenroll").post(
//     VIEWERAuth,
//     courseController.unenrollFromCourse
// );

// router.route("/my-courses").get(
//     VIEWERAuth,
//     courseController.getMyEnrolledCourses
// );

// router.route("/:courseId/enrolled-users").get(
//     ADMINSTREAMERAuth,
//     courseController.getEnrolledUsers
// );

// router.route("/:courseId/progress").put(
//     VIEWERAuth,
//     courseController.updateCourseProgress
// );

// export default router;


// import { Router } from "express";
// const router = Router();
// import { verifyToken, checkRole } from '../../middleware/authentication.js';
// import { uploadFile } from '../../middleware/aws.s3.js';
// import * as courseController from '../../controller/course/course.controller.js';

// const ADMINAuth = [verifyToken, checkRole([1])];
// const STREAMERAuth = [verifyToken, checkRole([2])];
// const VIEWERAuth = [verifyToken, checkRole([3])];
// const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
// const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

// // Course CRUD Operations
// router.route("/createCourse").post(
//     ADMINSTREAMERAuth,
//     uploadFile([
//         { name: "lectures", maxCount: 10 },
//         { name: "thumbnail", maxCount: 1 },
//         { name: "assignments", maxCount: 25 }
//     ]),
//     courseController.createCourse
// );

// router.route("/getAllCourses").get(
//     courseController.getAllCourse
// );

// router.route("/getSingleCourse/:id").get(
//     ADMINSTREAMERVIEWERAuth,
//     courseController.getSingleCourse
// );

// router.route("/updateCourse/:id").put(
//     ADMINSTREAMERAuth,
//     uploadFile([
//         { name: "lectures", maxCount: 10 },
//         { name: "thumbnail", maxCount: 1 },
//         { name: "assignments", maxCount: 25 }
//     ]),
//     courseController.updateCourse
// );

// router.route("/deleteCourse/:id").delete(
//     ADMINSTREAMERAuth,
//     courseController.deleteCourse
// );

// // Content Management Routes
// router.route("/:courseId/addLecture").post(
//     ADMINSTREAMERAuth,
//     uploadFile([{ name: "file", maxCount: 1 }]),
//     courseController.addLecture
// );

// router.route("/:courseId/removeLecture/:lectureId").delete(
//     ADMINSTREAMERAuth,
//     courseController.removeLecture
// );

// router.route("/:courseId/addAssignment").post(
//     ADMINSTREAMERAuth,
//     uploadFile([{ name: "resources", maxCount: 25 }]),
//     courseController.addAssignment
// );

// router.route("/:courseId/removeAssignment/:assignmentId").delete(
//     ADMINSTREAMERAuth,
//     courseController.removeAssignment
// );

// // Enrollment Routes
// router.route("/:courseId/enroll").post(
//     VIEWERAuth,
//     courseController.enrollInCourse
// );

// router.route("/:courseId/unenroll").post(
//     VIEWERAuth,
//     courseController.unenrollFromCourse
// );

// router.route("/my-courses").get(
//     VIEWERAuth,
//     courseController.getMyEnrolledCourses
// );

// router.route("/:courseId/enrolled-users").get(
//     ADMINSTREAMERAuth,
//     courseController.getEnrolledUsers
// );

// router.route("/:courseId/progress").put(
//     VIEWERAuth,
//     courseController.updateCourseProgress
// );

// // ✅ ADD THESE NEW ROUTES FOR ADMIN/STREAMER
// router.route("/all-enrollments").get(
//     ADMINSTREAMERAuth, // Both ADMIN and STREAMER can access
//     courseController.getAllEnrollments
// );

// router.route("/:courseId/enroll-user").post(
//     ADMINSTREAMERAuth,
//     courseController.enrollUser
// );

// router.route("/:courseId/unenroll-user/:userId").delete(
//     ADMINSTREAMERAuth,
//     courseController.unenrollUser
// );

// export default router;



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

// Course CRUD Operations
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
    ADMINSTREAMERAuth,courseController.getAllCourse
);

router.route("/getAllCoursesForUser").get(
    courseController.getAllCoursesForUser
);

router.route("/getSingleCourse/:id").get(
    ADMINSTREAMERVIEWERAuth,
    courseController.getSingleCourse
);


router.route("/getSingleCourseForEnrolledUsers/:id").get(
    VIEWERAuth,
    courseController.getSingleCourseForEnrolledUsers
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

router.route("/deleteCourse/:id").delete(
    ADMINSTREAMERAuth,
    courseController.deleteCourse
);

// Content Management Routes
router.route("/:courseId/addLecture").post(
    ADMINSTREAMERAuth,
    uploadFile([{ name: "file", maxCount: 1 }]),
    courseController.addLecture
);

router.route("/:courseId/removeLecture/:lectureId").delete(
    ADMINSTREAMERAuth,
    courseController.removeLecture
);

router.route("/:courseId/addAssignment").post(
    ADMINSTREAMERAuth,
    uploadFile([{ name: "resources", maxCount: 25 }]),
    courseController.addAssignment
);

router.route("/:courseId/removeAssignment/:assignmentId").delete(
    ADMINSTREAMERAuth,
    courseController.removeAssignment
);

// Enrollment Routes
router.route("/:courseId/enroll").post(
    VIEWERAuth,
    courseController.enrollInCourse
);

router.route("/:courseId/unenroll").post(
    VIEWERAuth,
    courseController.unenrollFromCourse
);

router.route("/my-courses").get(
    VIEWERAuth,
    courseController.getMyEnrolledCourses
);

router.route("/:courseId/enrolled-users").get(
    ADMINSTREAMERAuth,
    courseController.getEnrolledUsers
);

router.route("/:courseId/progress").put(
    VIEWERAuth,
    courseController.updateCourseProgress
);

// Add this route in course.route.js
router.route("/check-enrollment/:courseId").get(
  VIEWERAuth, // Just verify token, no specific role required
  courseController.checkEnrollment
);

// ✅ ADD THESE NEW ROUTES FOR ADMIN/STREAMER
router.route("/all-enrollments").get(
    ADMINSTREAMERAuth, // Both ADMIN and STREAMER can access
    courseController.getAllEnrollments
);

router.route("/:courseId/enroll-user").post(
    ADMINSTREAMERAuth,
    courseController.enrollUser
);

router.route("/:courseId/unenroll-user/:userId").delete(
    ADMINSTREAMERAuth,
    courseController.unenrollUser
);

export default router;