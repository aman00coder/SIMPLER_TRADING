import HttpStatus from 'http-status-codes';
import { v4 as uuidv4 } from 'uuid';
import authenticationModel from '../../model/Authentication/authentication.model.js';
import { sendOtpToEmail, sendOtpToPhone } from '../../middleware/sendOtpToMail.js';
import { sendSuccessResponse, sendErrorResponse } from '../../responses/responses.js';
import { errorEn, successEn } from '../../responses/message.js';
import { genPassword, comparePass } from '../../utils/password.js';
import { generateToken } from '../../middleware/authentication.js';

export const tempStore = new Map(); 

// 1. Send Email OTP
export const sendEmailOtp = async (req, res) => {
  try {
    let { email, secretId } = req.body;

    if (!email) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    email = email.toLowerCase();

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    const id = secretId || uuidv4();

    const oldData = tempStore.get(id) || {};
    oldData.email = email;
    oldData.emailOtp = otp;
    oldData.expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes expiry

    tempStore.set(id, oldData);

    await sendOtpToEmail(email, otp);

    // 👇 Send OTP in response (for testing only)
    return sendSuccessResponse(
      res,
      { secretId: id, otp },
      successEn.OTP_SENT,
      HttpStatus.OK
    );

  } catch (err) {
    console.error("Error in sendEmailOtp:", err);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// 2. Verify Email OTP
export const verifyEmailOtp = async (req, res) => {
  try {
    const { secretId, otp } = req.body;
    const data = tempStore.get(secretId);

    if (!data || data.emailOtp !== otp) {
      return sendErrorResponse(res, errorEn.INVALID_OTP, HttpStatus.UNAUTHORIZED);
    }

    data.isEmailVerified = true;
    tempStore.set(secretId, data);

    return sendSuccessResponse(res, { secretId }, successEn.EMAIL_VERIFIED, HttpStatus.OK);
  } catch (err) {
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// 3. Send Phone OTP
export const sendPhoneOtp = async (req, res) => {
  try {
    const { phone, secretId } = req.body;
    if (!phone) {
      return sendErrorResponse(
        res,
        errorEn.ALL_FIELDS_REQUIRED,
        HttpStatus.BAD_REQUEST
      );
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const id = secretId || uuidv4();

    const oldData = tempStore.get(id) || {};
    oldData.phone = phone;
    oldData.phoneOtp = otp;
    oldData.expiresAt = Date.now() + 10 * 60 * 1000;

    tempStore.set(id, oldData);

    await sendOtpToPhone(phone, otp);

    return sendSuccessResponse(
      res,
      { secretId: id, otp },
      successEn.OTP_SENT,
      HttpStatus.OK
    );
  } catch (err) {
    return sendErrorResponse(
      res,
      errorEn.INTERNAL_SERVER_ERROR,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

// 4. Verify Phone OTP
export const verifyPhoneOtp = async (req, res) => {
  try {
    const { secretId, otp } = req.body;
    const data = tempStore.get(secretId);

    if (!data || data.phoneOtp !== otp) {
      return sendErrorResponse(res, errorEn.INVALID_OTP, HttpStatus.UNAUTHORIZED);
    }

    data.isPhoneVerified = true;
    tempStore.set(secretId, data);

    return sendSuccessResponse(res, { secretId }, successEn.PHONE_VERIFIED, HttpStatus.OK);
  } catch (err) {
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// 5. Check Temp Registration Status
export const checkTempRegistrationStatus = async (req, res) => {
  try {
    const { secretId } = req.body;

    if (!secretId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    const tempData = tempStore.get(secretId);

    if (!tempData) {
      return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
    }

    return sendSuccessResponse(
      res,
      {
        secretId,
        email: tempData.email || null,
        phone: tempData.phone || null,
        isEmailVerified: tempData.isEmailVerified || false,
        isPhoneVerified: tempData.isPhoneVerified || false
      },
      successEn.TEMP_STATUS_FETCHED,
      HttpStatus.OK
    );

  } catch (err) {
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// 6. Create Account
export const createAccount = async (req, res) => {
  try {
    const { secretId, name, password, confirmPassword, role } = req.body;
    const data = tempStore.get(secretId);

    if (!data?.isEmailVerified) {
      return sendErrorResponse(res, errorEn.EMAIL_NOT_VERIFIED, HttpStatus.BAD_REQUEST);
    }

    if (!data?.isPhoneVerified) {
      return sendErrorResponse(res, errorEn.PHONE_NOT_VERIFIED, HttpStatus.BAD_REQUEST);
    }

    if (password !== confirmPassword) {
      return sendErrorResponse(res, errorEn.PASSWORD_NOT_MATCH, HttpStatus.BAD_REQUEST);
    }

    const email = data.email?.toLowerCase();
    const phone = data.phone;

    const existingUser = await authenticationModel.findOne({
      $or: [{ email }, { phone }]
    });

    if (existingUser) {
      return sendErrorResponse(res, errorEn.USER_ALREADY_REGISTERED(role), HttpStatus.CONFLICT);
    }

    const hashedPassword = await genPassword(password);

    const savedUser = await authenticationModel.create({
      name,
      email,
      phone,
      password: hashedPassword,
      role
    });

    tempStore.delete(secretId);

    return sendSuccessResponse(res, {
      userId: savedUser._id,
      isEmailVerified: true,
      isPhoneVerified: true
    }, successEn.REGISTERED(role), HttpStatus.OK);

  } catch (err) {
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// 7. Login
export const login = async (req, res) => {
  try {
    const { emailOrPhone, password } = req.body;

    if (!emailOrPhone || !password) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    const input = emailOrPhone?.toLowerCase();

    const user = await authenticationModel.findOne({
      $or: [{ email: input }, { phone: emailOrPhone }]
    });

    if (user) {
      const isMatch = await comparePass(password, user.password);
      if (!isMatch) {
        return sendErrorResponse(res, errorEn.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED);
      }

      const token = generateToken(user); 

      return sendSuccessResponse(res, {
        token,
        userId: user._id,           // User id
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        profilePic: user.profilePic || "",
        isActive: user.isActive,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }, successEn.LOGIN_SUCCESS, HttpStatus.OK);
    }

    return sendErrorResponse(res, errorEn.EMAIL_OR_PHONE_NOT_FOUND, HttpStatus.NOT_FOUND);
  } catch (error) {
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


// ✅ Send OTP for Forget Password// 1️⃣ Send OTP for Forget Password
export const sendOtpForgetPassword = async (req, res) => {
  try {
    let { emailOrPhone } = req.body;

    if (!emailOrPhone) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    if (emailOrPhone.includes('@')) {
      emailOrPhone = emailOrPhone.toLowerCase();
    }

    const existingUser = await authenticationModel.findOne({
      $or: [
        { email: emailOrPhone },
        { phone: emailOrPhone }
      ]
    });

    if (!existingUser) {
      return sendErrorResponse(res, errorEn.EMAIL_OR_PHONE_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const secretId = uuidv4();

    tempStore.set(secretId, {
      userId: existingUser._id,
      email: existingUser.email,
      phone: existingUser.phone,
      role: existingUser.role,
      otp,
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    if (emailOrPhone.includes('@')) {
      await sendOtpToEmail(existingUser.email, otp);
    } else {
      await sendOtpToPhone(existingUser.phone, otp);
    }

    // OTP ko response me include kar rahe hain
    return sendSuccessResponse(
      res,
      { secretId, otp },
      successEn.OTP_SENT,
      HttpStatus.OK
    );

  } catch (error) {
    console.error("Error in sendOtpForgetPassword:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


// 2️⃣ Verify OTP
export const verifyOtpForResetPassword = async (req, res) => {
  try {
    const { otp, secretId } = req.body;

    if (!otp || !secretId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    const storedData = tempStore.get(secretId);
    if (!storedData) {
      return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
    }

    if (Date.now() > storedData.expiresAt) {
      tempStore.delete(secretId);
      return sendErrorResponse(res, errorEn.OTP_EXPIRED, HttpStatus.UNAUTHORIZED);
    }

    if (storedData.otp !== otp) {
      return sendErrorResponse(res, errorEn.INVALID_OTP, HttpStatus.UNAUTHORIZED);
    }

    storedData.isOtpVerified = true;
    tempStore.set(secretId, storedData);

    return sendSuccessResponse(res, { secretId }, successEn.OTP_VERIFIED, HttpStatus.OK);

  } catch (error) {
    console.error("Error in verifyOtpForResetPassword:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// 3️⃣ Reset Password
export const forgetPassword = async (req, res) => {
  try {
    const { secretId, newPassword, confirmPassword } = req.body;

    if (!secretId || !newPassword || !confirmPassword) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    if (newPassword !== confirmPassword) {
      return sendErrorResponse(res, errorEn.PASSWORD_NOT_MATCH, HttpStatus.BAD_REQUEST);
    }

    const storedData = tempStore.get(secretId);
    if (!storedData) {
      return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
    }

    if (!storedData.isOtpVerified) {
      return sendErrorResponse(res, errorEn.OTP_NOT_VERIFIED, HttpStatus.UNAUTHORIZED);
    }

    if (Date.now() > storedData.expiresAt) {
      tempStore.delete(secretId);
      return sendErrorResponse(res, errorEn.OTP_EXPIRED, HttpStatus.UNAUTHORIZED);
    }

    const user = await authenticationModel.findById(storedData.userId);
    if (!user) {
      return sendErrorResponse(res, errorEn.USER_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    user.password = await genPassword(newPassword);
    await user.save();

    tempStore.delete(secretId);

    return sendSuccessResponse(
      res,
      {
        email: user.email,
        userId: user._id,
        message: "Your password has been updated successfully."
      },
      successEn.PASSWORD_RESET_SUCCESS,
      HttpStatus.OK
    );

  } catch (error) {
    console.error("Error in forgetPassword:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};