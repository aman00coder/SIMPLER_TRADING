import { Router } from "express";
const router = Router()

import * as authenticationController from '../../controller/Authentication/authentication.controller.js';
import { uploadFile,uploadSingleFile } from '../../middleware/aws.s3.js';

// authentication routes
router.route("/sendEmailOtp").post(authenticationController.sendEmailOtp);
router.route("/verifyEmailOtp").post(authenticationController.verifyEmailOtp);  
// router.route("/sendPhoneOtp").post(authenticationController.sendPhoneOtp);  
// router.route("/verifyPhoneOtp").post(authenticationController.verifyPhoneOtp);  
router.route("/checkTempRegistrationStatus").post(authenticationController.checkTempRegistrationStatus);  
router.route("/createAccount").post(authenticationController.createAccount); 


// router.route("/streamerSignUp").post(
//   uploadFile([
//     { name: "profilePic", maxCount: 1 }, // Profile picture
//     { name: "qualificationCertificates", maxCount: 5 }, // Qualification certificates
//     { name: "certificationFiles", maxCount: 5 } // Certification files
//   ]),
//   authenticationController.createStreamerAccount
// );


// Create basic account (NO TOKEN NEEDED)
router.route("/create-basic-streamer-account").post(authenticationController.createBasicStreamerAccount);

// File upload routes (NO TOKEN NEEDED - user ID in body)
router.route("/upload-file").post(
  uploadSingleFile("file"),
  authenticationController.uploadFile
);

router.route("/upload-profile-pic").post(
  uploadSingleFile("profilePic"),
  authenticationController.uploadProfilePic
);

router.route("/upload-qualification-certificate").post(
  uploadSingleFile("certificateFile"),
  authenticationController.uploadQualificationCertificate
);

router.route("/upload-certification-document").post(
  uploadSingleFile("certificateFile"),
  authenticationController.uploadCertificationDocument
);

// Batch upload for multiple files (NO TOKEN NEEDED)
router.route("/upload-multiple-files").post(
  uploadFile([
    { name: "profilePic", maxCount: 1 },
    { name: "qualificationCertificates", maxCount: 5 },
    { name: "certificationFiles", maxCount: 5 }
  ]),
  authenticationController.uploadMultipleFiles
);

// Keep old route for backward compatibility
router.route("/streamerSignUp").post(
  uploadFile([
    { name: "profilePic", maxCount: 1 },
    { name: "qualificationCertificates", maxCount: 5 },
    { name: "certificationFiles", maxCount: 5 }
  ]),
  authenticationController.createStreamerAccount
);


// // router.js में
// router.route("/streamerSignUp").post(
//   uploadFile([
//     { name: "profilePic", maxCount: 1 },
//     { name: "qualificationCertificates", maxCount: 5 },
//     { name: "certificationFiles", maxCount: 5 }
//   ]),
//   authenticationController.createStreamerAccount
// );

router.route("/login").post(authenticationController.login);
router.route("/sendOtpForgetPassword").post(authenticationController.sendOtpForgetPassword);
router.route("/verifyOtpForgetPassword").post(authenticationController.verifyOtpForResetPassword);
router.route("/forgetPassword").post(authenticationController.forgetPassword);

export default router;