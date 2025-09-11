import { Router } from "express";
const router = Router()

import * as authenticationController from '../../controller/Authentication/authentication.controller.js';

// authentication routes
router.route("/sendEmailOtp").post(authenticationController.sendEmailOtp);
router.route("/verifyEmailOtp").post(authenticationController.verifyEmailOtp);  
// router.route("/sendPhoneOtp").post(authenticationController.sendPhoneOtp);  
// router.route("/verifyPhoneOtp").post(authenticationController.verifyPhoneOtp);  
router.route("/checkTempRegistrationStatus").post(authenticationController.checkTempRegistrationStatus);  
router.route("/createAccount").post(authenticationController.createAccount);  
router.route("/login").post(authenticationController.login);
router.route("/sendOtpForgetPassword").post(authenticationController.sendOtpForgetPassword);
router.route("/verifyOtpForgetPassword").post(authenticationController.verifyOtpForResetPassword);
router.route("/forgetPassword").post(authenticationController.forgetPassword);

export default router;