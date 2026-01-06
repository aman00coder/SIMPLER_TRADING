import jwt from "jsonwebtoken";
import HttpStatus from "http-status-codes";
import dotenv from "dotenv";
import authenticationModel from "../model/Authentication/authentication.model.js";
import { sendErrorResponse } from "../../app/responses/responses.js";
import { errorEn } from "../../app/responses/message.js";
import { ROLE_MAP, ROLE_REVERSE_MAP } from "../constant/role.js";

dotenv.config();

// ✅ Token Generate Function
export const generateToken = (user, expiresIn = "1d") => {
  try {
    const payload = {
      userId: user._id,
      role: ROLE_MAP[user.role] // ✅ profession ki jagah role use kiya
    };

    return jwt.sign(payload, process.env.SECRET_KEY, { expiresIn });
  } catch (error) {
    console.error("Token generation error:", error);
    return null;
  }
};

// ✅ Token Verify Function
export const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return sendErrorResponse(res, errorEn.NO_TOKEN, HttpStatus.FORBIDDEN);
    }

    const token = authHeader.replace("Bearer ", "");
    const decoded = jwt.verify(token, process.env.SECRET_KEY);

    const roleName = ROLE_REVERSE_MAP[decoded.role];
    if (!roleName) {
      return sendErrorResponse(res, errorEn.INVALID_ROLE, HttpStatus.FORBIDDEN);
    }

    const user = await authenticationModel.findById(decoded.userId);
    if (!user || user.role !== roleName) {
      return sendErrorResponse(res, errorEn.LOGGED_OUT, HttpStatus.FORBIDDEN);
    }

    req.tokenData = {
      userId: decoded.userId,
      role: decoded.role,
      roleName: roleName,
      user: user.toObject()
    };

    next();
  } catch (error) {

    if (error.name === 'TokenExpiredError') {
  return sendErrorResponse(res, errorEn.TOKEN_EXPIRED, HttpStatus.UNAUTHORIZED); // 401
}

if (error.name === 'JsonWebTokenError') {
  return sendErrorResponse(res, errorEn.TOKEN_INVALID, HttpStatus.FORBIDDEN); // 403
}
    console.error("Token Verification Error:", error.message);
    return sendErrorResponse(res, errorEn.TOKEN_INVALID, HttpStatus.FORBIDDEN);
  }
};

// export const checkRole = (allowedRoles = []) => {
//   return (req, res, next) => {
//     const roleName = req.tokenData?.roleName; // 👈 STRING (ADMIN)

//     if (!allowedRoles.includes(roleName)) {
//       return sendErrorResponse(
//         res,
//         "Access denied: insufficient permissions",
//         HttpStatus.FORBIDDEN
//       );
//     }
//     next();
//   };
// };


export const checkRole = (allowedRoles = []) => {
  return (req, res, next) => {
    const userRole = req.tokenData?.role;
    if (!allowedRoles.includes(userRole)) {
      return sendErrorResponse(res, "Access denied: insufficient permissions", HttpStatus.FORBIDDEN);
    }
    next();
  };
};