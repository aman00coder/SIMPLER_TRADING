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

// router.route("/getAllCoursesForUser").get(
//     courseController.getAllCoursesForUser
// );

// router.route("/getSingleCourse/:id").get(
//     ADMINSTREAMERVIEWERAuth,
//     courseController.getSingleCourse
// );


// router.route("/getSingleCourseForEnrolledUsers/:id").get(
//     VIEWERAuth,
//     courseController.getSingleCourseForEnrolledUsers
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

// // Add this route in course.route.js
// router.route("/check-enrollment/:courseId").get(
//   VIEWERAuth, // Just verify token, no specific role required
//   courseController.checkEnrollment
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

import { verifyToken, checkRole } from "../../middleware/authentication.js";
import * as courseController from "../../controller/course/course.controller.js";

// Role Middlewares
const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];


// =================================================
// COURSE CRUD (NO FILE UPLOAD HERE ❌)
// =================================================

// ✅ Create Course (URLs come from frontend)
router.post(
  "/createCourse",
  STREAMERAuth,
  courseController.createCourse
);

// ✅ Get all courses (role based)
router.get(
  "/getAllCourses",
  ADMINSTREAMERVIEWERAuth,
  courseController.getAllCourse
);

router.get(
  "/getAllCoursesForUser",
  courseController.getAllCoursesForUser
);

// ✅ Get single course (owner/admin)
router.get(
  "/getSingleCourse/:id",
  ADMINSTREAMERAuth,
  courseController.getSingleCourse
);

router.get(
  "/getSingleCourseForEnrolledUsers/:id",
  VIEWERAuth,
  courseController.getSingleCourseForEnrolledUsers
);

// ✅ Update Course (URLs only)
router.put(
  "/updateCourse/:id",
  STREAMERAuth,
  courseController.updateCourse
);

// ✅ Delete Course
router.delete(
  "/deleteCourse/:id",
  ADMINSTREAMERAuth,
  courseController.deleteCourse
);

// ✅ Toggle course status (Admin only logic inside controller)
router.patch(
  "/toggle-course-status/:id",
  STREAMERAuth,
  courseController.toggleCourseStatus
);

// =================================================
// COURSE LISTING / STATS
// =================================================

router.get(
  "/streamer/:streamerId/courses",
  ADMINSTREAMERVIEWERAuth,
  courseController.getCoursesByStreamer
);

router.get(
  "/statistics",
  ADMINSTREAMERAuth,
  courseController.getCourseStatistics
);

router.get(
  "/allCoursesForAdmin",
  ADMINAuth,
  courseController.getAllCoursesForAdmin
);

// =================================================
// CONTENT MANAGEMENT (URL BASED ❌ NO FILE UPLOAD)
// =================================================

// ✅ Add Lecture (URL comes in body)
router.post(
  "/:courseId/addLecture",
  ADMINSTREAMERAuth,
  courseController.addLecture
);

// ✅ Remove Lecture
router.delete(
  "/:courseId/removeLecture/:lectureId",
  ADMINSTREAMERAuth,
  courseController.removeLecture
);

// ✅ Add Assignment (resources = [url])
router.post(
  "/:courseId/addAssignment",
  ADMINSTREAMERAuth,
  courseController.addAssignment
);

// ✅ Remove Assignment
router.delete(
  "/:courseId/removeAssignment/:assignmentId",
  ADMINSTREAMERAuth,
  courseController.removeAssignment
);

// =================================================
// ENROLLMENT ROUTES
// =================================================

router.post(
  "/:courseId/enroll",
  VIEWERAuth,
  courseController.enrollInCourse
);

router.post(
  "/:courseId/unenroll",
  VIEWERAuth,
  courseController.unenrollFromCourse
);

router.get(
  "/my-courses",
  VIEWERAuth,
  courseController.getMyEnrolledCourses
);

router.get(
  "/:courseId/enrolled-users",
  ADMINSTREAMERAuth,
  courseController.getEnrolledUsers
);

router.put(
  "/:courseId/progress",
  VIEWERAuth,
  courseController.updateCourseProgress
);

router.get(
  "/check-enrollment/:courseId",
  VIEWERAuth,
  courseController.checkEnrollment
);

// =================================================
// ADMIN / STREAMER ENROLLMENT MANAGEMENT
// =================================================

router.get(
  "/all-enrollments",
  ADMINSTREAMERAuth,
  courseController.getAllEnrollments
);

router.post(
  "/:courseId/enroll-user",
  ADMINSTREAMERAuth,
  courseController.enrollUser
);

router.delete(
  "/:courseId/unenroll-user/:userId",
  ADMINSTREAMERAuth,
  courseController.unenrollUser
);

export default router;
