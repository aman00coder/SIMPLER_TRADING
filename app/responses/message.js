// ==================== ✅ SUCCESS MESSAGES ====================
export const successEn = {
  // 🔐 AUTH MODULE
  OTP_SENT: "✅ OTP sent successfully.",
  EMAIL_VERIFIED: "✅ Email verified successfully.",
  PHONE_VERIFIED: "✅ Phone number verified successfully.",
  PASSWORD_RESET_SUCCESS: "✅ Password reset successfully.",
  LOGIN_SUCCESS: "✅ Login successful.",
  OTP_VERIFIED: "✅ OTP verified successfully.",
  TEMP_STATUS_FETCHED: "📌 Temporary registration status fetched successfully.",
  ACCOUNT_NOT_CREATED_YET: "ℹ️ User is verified but account not created.",
  REGISTERED: (profession) => `✅ ${profession} registered successfully.`,

  // 📋 COMMON
  DETAILS_FETCH: "📋 Details fetched successfully.",
  DATA_FOUND: "📊 Data found successfully.",
  NO_DATA_FOUND: "ℹ️ No data found.",
  CREATED: "✅ Data created successfully.",
  UPDATED: "🔄 Data updated successfully.",
  DELETED: "🗑️ Data deleted successfully.",
  SESSION_LEFT: "👋 You have left the live session.",
  SOFT_DELETED: "🗃️ Data soft-deleted successfully.",
  HARD_DELETED: "❌ Data permanently deleted.",
  DATA_UPDATED: "✅ Data updated successfully.",
  DATA_RESTORED: "✅ Pump restored successfully.",

  // ==================== ✅ WHITEBOARD MESSAGES ====================
  WHITEBOARD_CREATED: "✅ Whiteboard created successfully.",
  WHITEBOARD_UPDATED: "🔄 Whiteboard updated successfully.",
  WHITEBOARD_FETCHED: "✅ Whiteboard fetched successfully.",
  WHITEBOARD_DELETED: "🗑️ Whiteboard deleted successfully.",
  WHITEBOARD_RESTORED: "✅ Whiteboard restored successfully.",

  // ==================== ✅ LIVE SESSION MESSAGES ====================
  LIVE_SESSION_CREATED: "✅ Live session created successfully.",
  LIVE_SESSION_STARTED: "🎥 Live session started successfully.",
  LIVE_SESSION_ENDED: "🛑 Live session ended successfully.",
  LIVE_SESSION_FETCHED: "📋 Live session fetched successfully.",
  LIVE_SESSION_UPDATED: "🔄 Live session updated successfully.",
  LIVE_SESSION_DELETED: "🗑️ Live session deleted successfully.",
  LIVE_SESSION_RESTORED: "✅ Live session restored successfully.",
  LIVE_SESSION_ID_GENERATED: "🆔 Live session ID generated successfully.",
};

// ==================== ❌ ERROR MESSAGES ====================
export const errorEn = {
  ALL_FIELDS_REQUIRED: "⚠️ All fields are required.",
  EMAIL_ALREADY_REGISTERED: "🚫 Email already registered.",
  PHONE_ALREADY_REGISTERED: "🚫 Phone number already registered.",
  EMAIL_NOT_FOUND: "❌ Email not found.",
  PASSWORD_NOT_MATCH: "❌ Password and confirm password do not match.",
  INVALID_OTP: "❌ Invalid OTP.",
  OTP_EXPIRED: "⌛ OTP expired.",
  INVALID_SECRET_ID: "🚫 Invalid secret ID.",
  INVALID_CREDENTIALS: "❌ Invalid email or password.",
  EMAIL_NOT_VERIFIED: "⚠️ Email not verified.",
  PHONE_NOT_VERIFIED: "⚠️ Phone not verified.",
  ADMIN_NOT_FOUND: "❌ User not found. Please try again.",
  INVALID_PHONE: "❌ Invalid phone number format.",
  INVALID_LICENSE_NUMBER: "❌ Invalid license number format.",
  INVALID_LOCATION_FORMAT: "❌ Invalid location format.",
  INVALID_COORDINATES: "❌ Invalid coordinates.",
  UNAUTHORIZED_ROLE: "🚫 Unauthorized role.",
  INVALID_APPROVAL_STATUS: "❌ Invalid status",
  UNAUTHORIZED_ACCESS: "🚫 You are not authorized to access this data.",
  UNAUTHORIZED: "🚫 Unauthorized access.",
  DEFAULT_ERROR: "⚠️ Something went wrong. Please try again.",
  FAILED_TO_CREATE: "❌ Failed to create data.",
  FAILED_TO_UPDATE: "❌ Failed to update data.",
  FAILED_TO_DELETE: "❌ Failed to delete data.",
  IMAGE_DELETE_FAILED: "🖼️ Failed to delete image from storage.",
  INTERNAL_SERVER_ERROR: "🔥 Internal server error. Please try again later.",

  // ==================== ❌ WHITEBOARD ERRORS ====================
  WHITEBOARD_TITLE_REQUIRED: "⚠️ Title is required.",
  WHITEBOARD_DESCRIPTION_REQUIRED: "⚠️ Description is required.",
  WHITEBOARD_CREATED_BY_REQUIRED: "⚠️ CreatedBy (userId) is required.",
  WHITEBOARD_ACCESS_TYPE_REQUIRED: "⚠️ Valid accessType is required (public | private | restricted).",
  WHITEBOARD_STATUS_REQUIRED: "⚠️ Valid status is required (active | archived).",
  WHITEBOARD_CANVAS_REQUIRED: "⚠️ Canvas data is required.",
  WHITEBOARD_CHAT_ENABLED_REQUIRED: "⚠️ Chat enabled flag is required.",
  WHITEBOARD_LIVESTREAM_REQUIRED: "⚠️ Live stream details (isLive, streamUrl) are required.",
  WHITEBOARD_SESSION_ID_REQUIRED: "⚠️ currentSessionId is required for live sessions.",
  WHITEBOARD_PERMISSIONS_REQUIRED: "⚠️ Permissions array is required.",
  WHITEBOARD_MAX_PARTICIPANTS_REQUIRED: "⚠️ Max participants is required and must be a number.",
  WHITEBOARD_PARTICIPANTS_REQUIRED: "⚠️ At least one participant is required for the whiteboard.",
  WHITEBOARD_NOT_CREATED: "❌ Whiteboard could not be created.",
  WHITEBOARD_NOT_FOUND: "❌ Whiteboard not found.",
  NO_DELETED_WHITEBOARD: "ℹ️ No deleted whiteboard found to restore.",
  FAILED_TO_UPDATE: "❌ Failed to update data.",

  // 🔒 WHITEBOARD ACCESS ERRORS
  WHITEBOARD_ACCESS_STUDENT_DENIED: "🚫 Access denied: Students cannot update whiteboards.",
  WHITEBOARD_ACCESS_TEACHER_DENIED: "🚫 Access denied: You can only update whiteboards created by admin or teacher.",
  WHITEBOARD_SESSIONID_REQUIRED: "⚠️ currentSessionId is required for live sessions.",
  WHITEBOARD_PASSWORD_REQUIRED:"🔒 Whiteboard password is required to create a secure session.",

  // 🚫 Role restriction
  FORBIDDEN: "🚫 Access denied: Your role is not allowed to perform this action.",
  NO_TOKEN: "🚫 No token provided.",
  TOKEN_INVALID: "🔑 Invalid token.",
  TOKEN_EXPIRED: "⏰ Token expired. Please login again.",
  LOGGED_OUT: "👋 User logged out. Please login again.",
  INVALID_ROLE: "🚫 Invalid role in token.",

  // ==================== ❌ LIVE SESSION ERRORS ====================
  LIVE_SESSION_ALREADY_EXISTS: "🚫 Live session with this room code already exists.",
  LIVE_SESSION_NOT_FOUND: "❌ Live session not found.",
  LIVE_SESSION_ID_REQUIRED: "⚠️ Live session ID is required.",
  MAX_PARTICIPANTS_EXCEEDED: "⚠️ Maximum participants limit exceeded.",
};
