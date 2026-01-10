import HttpStatus from 'http-status-codes';
import { v4 as uuidv4 } from 'uuid';
import authenticationModel from '../../model/Authentication/authentication.model.js';
import { sendOtpToEmail } from '../../middleware/sendOtpToMail.js';
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

    // Check if email already exists
    const existingUser = await authenticationModel.findOne({ email });
    if (existingUser) {
      // ✅ Fixed: dynamic message
      const message = errorEn.USER_ALREADY_REGISTERED
        ? (typeof errorEn.USER_ALREADY_REGISTERED === "function"
            ? errorEn.USER_ALREADY_REGISTERED("user")
            : errorEn.USER_ALREADY_REGISTERED)
        : "User already registered";

      return sendErrorResponse(res, message, HttpStatus.CONFLICT);
    }

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

    // ✅ Catch me bhi same fix
    const message = errorEn.INTERNAL_SERVER_ERROR
      ? (typeof errorEn.INTERNAL_SERVER_ERROR === "function"
          ? errorEn.INTERNAL_SERVER_ERROR()
          : errorEn.INTERNAL_SERVER_ERROR)
      : "Internal server error";

    return sendErrorResponse(res, message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// export const verifyEmailOtp = async (req, res) => {
//   try {
//     const { secretId, otp } = req.body;
//     const data = tempStore.get(secretId);

//     if (!data) {
//       return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
//     }

//     if (Date.now() > data.expiresAt) {
//       tempStore.delete(secretId);
//       return sendErrorResponse(res, errorEn.OTP_EXPIRED, HttpStatus.UNAUTHORIZED);
//     }

//     if (data.emailOtp !== otp) {
//       return sendErrorResponse(res, errorEn.INVALID_OTP, HttpStatus.UNAUTHORIZED);
//     }

//     data.isEmailVerified = true;
//     tempStore.set(secretId, data);

//     return sendSuccessResponse(res, { secretId }, successEn.EMAIL_VERIFIED, HttpStatus.OK);
//   } catch (err) {
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };



// 3. Check Temp Registration Status


export const verifyEmailOtp = async (req, res) => {
  try {
    const { secretId, otp } = req.body;
    const data = tempStore.get(secretId);

    console.log("🔍 [VERIFY EMAIL] Checking for secretId:", secretId);
    console.log("📦 [VERIFY EMAIL] Data in tempStore:", data);

    if (!data) {
      console.error("❌ [VERIFY EMAIL] Secret ID not found in tempStore");
      return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
    }

    if (Date.now() > data.expiresAt) {
      console.error("❌ [VERIFY EMAIL] OTP expired for secretId:", secretId);
      tempStore.delete(secretId);
      return sendErrorResponse(res, errorEn.OTP_EXPIRED, HttpStatus.UNAUTHORIZED);
    }

    if (data.emailOtp !== otp) {
      console.error("❌ [VERIFY EMAIL] Invalid OTP for secretId:", secretId);
      return sendErrorResponse(res, errorEn.INVALID_OTP, HttpStatus.UNAUTHORIZED);
    }

    // ✅ FIXED: isEmailVerified को true सेट करें
    data.isEmailVerified = true;
    data.emailVerifiedAt = new Date();
    
    // ✅ IMPORTANT: tempStore में update करें
    tempStore.set(secretId, data);
    
    console.log("✅ [VERIFY EMAIL] Email verified successfully for secretId:", secretId);
    console.log("📝 [VERIFY EMAIL] Updated data:", tempStore.get(secretId));

    return sendSuccessResponse(
      res, 
      { 
        secretId,
        email: data.email,
        isEmailVerified: true 
      }, 
      successEn.EMAIL_VERIFIED, 
      HttpStatus.OK
    );
  } catch (err) {
    console.error("❌ [VERIFY EMAIL] Error:", err);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

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
        isEmailVerified: tempData.isEmailVerified || false
      },
      successEn.TEMP_STATUS_FETCHED,
      HttpStatus.OK
    );

  } catch (err) {
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// 4. Create Account
// export const createAccount = async (req, res) => {
//   try {
//     const { secretId, name, password, confirmPassword, role } = req.body;
//     const data = tempStore.get(secretId);

//     if (!data) {
//       return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
//     }

//     if (!data.isEmailVerified) {
//       return sendErrorResponse(res, errorEn.EMAIL_NOT_VERIFIED, HttpStatus.BAD_REQUEST);
//     }

//     if (password !== confirmPassword) {
//       return sendErrorResponse(res, errorEn.PASSWORD_NOT_MATCH, HttpStatus.BAD_REQUEST);
//     }
//     const email = data.email?.toLowerCase();

//     // ✅ Check again if user exists (race condition)
//     const existingUser = await authenticationModel.findOne({ email });
//     if (existingUser) {
//       const message = errorEn.USER_ALREADY_REGISTERED
//         ? (typeof errorEn.USER_ALREADY_REGISTERED === "function"
//             ? errorEn.USER_ALREADY_REGISTERED(role)
//             : errorEn.USER_ALREADY_REGISTERED)
//         : "User already registered";

//       return sendErrorResponse(res, message, HttpStatus.CONFLICT);
//     }

//     // ✅ Hash password
//     const hashedPassword = await genPassword(password);

//     const savedUser = await authenticationModel.create({
//       name,
//       email,
//       password: hashedPassword,
//       role,
//       isEmailVerified: true
//     });

//     // ✅ Remove temp store
//     tempStore.delete(secretId);

//     return sendSuccessResponse(
//       res,
//       {
//         userId: savedUser._id,
//         isEmailVerified: true
//       },
//       successEn.REGISTERED
//         ? (typeof successEn.REGISTERED === "function"
//             ? successEn.REGISTERED(role)
//             : successEn.REGISTERED)
//         : "Registered successfully",
//       HttpStatus.OK
//     );

//   } catch (err) {
//     console.error("Error in createAccount:", err);

//     const message = errorEn.INTERNAL_SERVER_ERROR
//       ? (typeof errorEn.INTERNAL_SERVER_ERROR === "function"
//           ? errorEn.INTERNAL_SERVER_ERROR()
//           : errorEn.INTERNAL_SERVER_ERROR)
//       : "Internal server error";

//     return sendErrorResponse(res, message, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };


// 5. Login
// export const login = async (req, res) => {
//   try {
//     const { email, password } = req.body;

//     if (!email || !password) {
//       return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
//     }

//     const user = await authenticationModel.findOne({
//       email: email.toLowerCase()
//     });

//     if (user) {
//       const isMatch = await comparePass(password, user.password);
//       if (!isMatch) {
//         return sendErrorResponse(res, errorEn.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED);
//       }

//       const token = generateToken(user); 

//       return sendSuccessResponse(res, {
//         token,
//         userId: user._id,           // User id
//         name: user.name,
//         email: user.email,
//         role: user.role,
//         profilePic: user.profilePic || "",
//         isActive: user.isActive,
//         lastLogin: user.lastLogin,
//         createdAt: user.createdAt,
//         updatedAt: user.updatedAt
//       }, successEn.LOGIN_SUCCESS, HttpStatus.OK);
//     }

//     return sendErrorResponse(res, errorEn.EMAIL_NOT_FOUND, HttpStatus.NOT_FOUND);
//   } catch (error) {
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };


// controller/Authentication/authentication.controller.js


// controller/Authentication/authentication.controller.js

// 4. Create Account with optional streamer profile
export const createAccount = async (req, res) => {
  try {
    const { 
      secretId, 
      name, 
      password, 
      confirmPassword, 
      role,
      // ✅ Streamer profile fields (optional)
      bio,
      expertise,
      experienceYears,
      experienceDescription,
      qualifications,
      certifications,
      socialLinks // object containing social media links
    } = req.body;
    
    const data = tempStore.get(secretId);

    if (!data) {
      return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
    }

    if (!data.isEmailVerified) {
      return sendErrorResponse(res, errorEn.EMAIL_NOT_VERIFIED, HttpStatus.BAD_REQUEST);
    }

    if (password !== confirmPassword) {
      return sendErrorResponse(res, errorEn.PASSWORD_NOT_MATCH, HttpStatus.BAD_REQUEST);
    }
    
    const email = data.email?.toLowerCase();

    // ✅ Check again if user exists (race condition)
    const existingUser = await authenticationModel.findOne({ email });
    if (existingUser) {
      const message = errorEn.USER_ALREADY_REGISTERED
        ? (typeof errorEn.USER_ALREADY_REGISTERED === "function"
            ? errorEn.USER_ALREADY_REGISTERED(role)
            : errorEn.USER_ALREADY_REGISTERED)
        : "User already registered";

      return sendErrorResponse(res, message, HttpStatus.CONFLICT);
    }

    // ✅ Hash password
    const hashedPassword = await genPassword(password);

    // Create user object
    const userData = {
      name,
      email,
      password: hashedPassword,
      role,
      isEmailVerified: true
    };

    // ✅ If role is STREAMER, add streamer profile with verification request
    if (role === 'STREAMER') {
      userData.streamerProfile = {
        verificationStatus: 'PENDING',
        verificationRequestDate: new Date(),
        // Optional fields - only add if provided
        ...(bio && { bio }),
        ...(expertise && { 
          expertise: Array.isArray(expertise) ? expertise : [expertise] 
        }),
        ...(experienceYears && { experienceYears }),
        ...(experienceDescription && { experienceDescription }),
        ...(qualifications && { 
          qualifications: Array.isArray(qualifications) ? qualifications : [qualifications]
        }),
        ...(certifications && { 
          certifications: Array.isArray(certifications) ? certifications : [certifications]
        }),
        ...(socialLinks && { socialLinks })
      };
    }

    const savedUser = await authenticationModel.create(userData);

    // ✅ Remove temp store
    tempStore.delete(secretId);

    // ✅ Generate token for immediate login
    const token = generateToken(savedUser);

    // ✅ Prepare response data
    const responseData = {
      token,
      userId: savedUser._id,
      name: savedUser.name,
      email: savedUser.email,
      role: savedUser.role,
      profilePic: savedUser.profilePic || "",
      isEmailVerified: true,
      isActive: savedUser.isActive,
      createdAt: savedUser.createdAt
    };

    // ✅ If streamer, add profile info to response
    if (savedUser.role === 'STREAMER' && savedUser.streamerProfile) {
      responseData.streamerProfile = {
        verificationStatus: savedUser.streamerProfile.verificationStatus,
        verificationRequestDate: savedUser.streamerProfile.verificationRequestDate,
        ...(bio && { bio }),
        ...(expertise && { expertise }),
        ...(experienceYears && { experienceYears }),
        ...(experienceDescription && { experienceDescription }),
        ...(qualifications && { qualifications }),
        ...(certifications && { certifications }),
        ...(socialLinks && { socialLinks }),
        message: savedUser.streamerProfile.bio || savedUser.streamerProfile.expertise 
          ? 'Your streamer account has been created and verification is pending.'
          : 'Your streamer account has been created. Please complete your profile for verification.'
      };
    }

    return sendSuccessResponse(
      res,
      responseData,
      role === 'STREAMER' 
        ? 'Streamer account created successfully. Verification pending.' 
        : successEn.REGISTERED
          ? (typeof successEn.REGISTERED === "function"
              ? successEn.REGISTERED(role)
              : successEn.REGISTERED)
          : "Registered successfully",
      HttpStatus.OK
    );

  } catch (err) {
    console.error("Error in createAccount:", err);

    const message = errorEn.INTERNAL_SERVER_ERROR
      ? (typeof errorEn.INTERNAL_SERVER_ERROR === "function"
          ? errorEn.INTERNAL_SERVER_ERROR()
          : errorEn.INTERNAL_SERVER_ERROR)
      : "Internal server error";

    return sendErrorResponse(res, message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};






// authentication.controller.js में सभी नए functions (NO TOKEN)

// Create basic streamer account (NO TOKEN NEEDED)
export const createBasicStreamerAccount = async (req, res) => {
  try {
    console.log("🔑 [CREATE BASIC ACCOUNT] Request received");
    
    const { 
      secretId, 
      name, 
      password, 
      confirmPassword,
      phone,
      bio,
      expertise,
      experienceYears,
      experienceDescription,
      qualifications: qualificationsJson,
      certifications: certificationsJson,
      socialLinks: socialLinksJson
    } = req.body;
    
    // Validate secretId and temp store
    const data = tempStore.get(secretId);
    if (!data) {
      console.error("❌ [ERROR] Secret ID not found:", secretId);
      return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
    }

    if (!data.isEmailVerified) {
      console.error("❌ [ERROR] Email not verified for secretId:", secretId);
      return sendErrorResponse(res, errorEn.EMAIL_NOT_VERIFIED, HttpStatus.BAD_REQUEST);
    }

    if (password !== confirmPassword) {
      return sendErrorResponse(res, errorEn.PASSWORD_NOT_MATCH, HttpStatus.BAD_REQUEST);
    }
    
    const email = data.email?.toLowerCase();

    // Check if user already exists
    const existingUser = await authenticationModel.findOne({ email });
    if (existingUser) {
      console.error("❌ [ERROR] User already exists:", email);
      const message = errorEn.USER_ALREADY_REGISTERED
        ? (typeof errorEn.USER_ALREADY_REGISTERED === "function"
            ? errorEn.USER_ALREADY_REGISTERED("streamer")
            : errorEn.USER_ALREADY_REGISTERED)
        : "User already registered";

      return sendErrorResponse(res, message, HttpStatus.CONFLICT);
    }

    // Validate required streamer fields
    const requiredFields = ['bio', 'expertise', 'experienceYears', 'experienceDescription'];
    const missingFields = requiredFields.filter(field => !req.body[field]);
    
    if (missingFields.length > 0) {
      console.error("❌ [ERROR] Missing required fields:", missingFields);
      return sendErrorResponse(
        res, 
        `The following fields are required for streamer registration: ${missingFields.join(', ')}`, 
        HttpStatus.BAD_REQUEST
      );
    }

    // Hash password
    const hashedPassword = await genPassword(password);

    // Parse JSON strings
    let parsedExpertise = [];
    let parsedQualifications = [];
    let parsedCertifications = [];
    let parsedSocialLinks = {};
    
    try {
      // Parse expertise
      if (expertise) {
        parsedExpertise = typeof expertise === 'string' ? JSON.parse(expertise) : expertise;
      }
      
      // Parse qualifications
      if (qualificationsJson) {
        parsedQualifications = typeof qualificationsJson === 'string' 
          ? JSON.parse(qualificationsJson) 
          : (Array.isArray(qualificationsJson) ? qualificationsJson : []);
      }
      
      // Parse certifications
      if (certificationsJson) {
        parsedCertifications = typeof certificationsJson === 'string' 
          ? JSON.parse(certificationsJson) 
          : (Array.isArray(certificationsJson) ? certificationsJson : []);
      }
      
      // Parse social links
      if (socialLinksJson) {
        parsedSocialLinks = typeof socialLinksJson === 'string' 
          ? JSON.parse(socialLinksJson) 
          : socialLinksJson;
      }
    } catch (parseError) {
      console.error("❌ [ERROR] Failed to parse JSON:", parseError);
      return sendErrorResponse(
        res, 
        "Invalid JSON format in data", 
        HttpStatus.BAD_REQUEST
      );
    }

    // Create user without file URLs
    const userData = {
      name: name.trim(),
      email: email.trim(),
      phone: phone ? phone.trim() : "",
      password: hashedPassword,
      role: 'STREAMER',
      profilePic: "", // Empty for now
      isEmailVerified: true,
      isActive: true,
      streamerProfile: {
        verificationStatus: 'PENDING',
        verificationRequestDate: new Date(),
        bio: bio.trim(),
        expertise: Array.isArray(parsedExpertise) ? parsedExpertise : [parsedExpertise],
        experienceYears: Number(experienceYears),
        experienceDescription: experienceDescription.trim(),
        qualifications: parsedQualifications.map(q => ({
          degree: q.degree || "",
          institute: q.institute || "",
          year: q.year ? Number(q.year) : new Date().getFullYear(),
          certificateUrl: "", // Empty for now
          certificateFileName: ""
        })),
        certifications: parsedCertifications.map(c => ({
          name: c.name || "",
          issuer: c.issuer || "",
          issueDate: c.issueDate || null,
          expiryDate: c.expiryDate || null,
          certificateUrl: "", // Empty for now
          certificateFileName: ""
        })),
        socialLinks: parsedSocialLinks || {},
        totalStreams: 0,
        totalStudents: 0,
        averageRating: 0,
        totalEarnings: 0,
        isProfileComplete: true
      }
    };

    const savedUser = await authenticationModel.create(userData);

    // Remove temp store
    tempStore.delete(secretId);

    // Generate token for immediate login (optional)
    const token = generateToken(savedUser);

    // Prepare response
    const responseData = {
      token, // Token सिर्फ login के लिए
      userId: savedUser._id, // ✅ User ID response में भेजें
      name: savedUser.name,
      email: savedUser.email,
      phone: savedUser.phone,
      role: savedUser.role,
      profilePic: savedUser.profilePic,
      isEmailVerified: true,
      isActive: savedUser.isActive,
      createdAt: savedUser.createdAt,
      streamerProfile: {
        bio: savedUser.streamerProfile.bio,
        expertise: savedUser.streamerProfile.expertise,
        experienceYears: savedUser.streamerProfile.experienceYears,
        experienceDescription: savedUser.streamerProfile.experienceDescription,
        verificationStatus: savedUser.streamerProfile.verificationStatus,
        verificationRequestDate: savedUser.streamerProfile.verificationRequestDate,
        qualifications: savedUser.streamerProfile.qualifications.map((q, index) => ({
          index,
          degree: q.degree,
          institute: q.institute,
          year: q.year,
          certificateUrl: q.certificateUrl,
          certificateFileName: q.certificateFileName,
          needsUpload: !q.certificateUrl
        })),
        certifications: savedUser.streamerProfile.certifications.map((c, index) => ({
          index,
          name: c.name,
          issuer: c.issuer,
          issueDate: c.issueDate,
          expiryDate: c.expiryDate,
          certificateUrl: c.certificateUrl,
          certificateFileName: c.certificateFileName,
          needsUpload: !c.certificateUrl
        })),
        socialLinks: savedUser.streamerProfile.socialLinks
      },
      uploadInfo: {
        profilePic: false, // Frontend check करेगा
        qualifications: parsedQualifications.map((q, index) => index),
        certifications: parsedCertifications.map((c, index) => index)
      }
    };

    console.log("✅ [ACCOUNT CREATED] User ID:", savedUser._id);

    return sendSuccessResponse(
      res,
      responseData,
      'Streamer account created successfully. You can now upload files.',
      HttpStatus.OK
    );

  } catch (err) {
    console.error("❌ [ERROR] in createBasicStreamerAccount:", err);

    const message = errorEn.INTERNAL_SERVER_ERROR
      ? (typeof errorEn.INTERNAL_SERVER_ERROR === "function"
          ? errorEn.INTERNAL_SERVER_ERROR()
          : errorEn.INTERNAL_SERVER_ERROR)
      : "Internal server error";

    return sendErrorResponse(res, message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// Upload single file (NO TOKEN NEEDED - user ID in body)
export const uploadFile = async (req, res) => {
  try {
    console.log("📁 [UPLOAD FILE] Request received");
    
    // ✅ User ID body से लें (token से नहीं)
    const { userId, fileType, qualificationIndex, certificationIndex } = req.body;
    
    if (!userId) {
      console.error("❌ [ERROR] User ID is required");
      return sendErrorResponse(res, 'User ID is required', HttpStatus.BAD_REQUEST);
    }
    
    const uploadedFiles = req.fileUrls || {};
    const file = uploadedFiles.file;
    
    if (!file) {
      console.error("❌ [ERROR] No file uploaded");
      return sendErrorResponse(res, 'No file uploaded', HttpStatus.BAD_REQUEST);
    }
    
    console.log("👤 [USER ID FROM BODY]:", userId);
    console.log("📄 [FILE TYPE]:", fileType);
    console.log("📄 [FILE DETAILS]:", file.fileName);
    
    // User को database से fetch करें
    const user = await authenticationModel.findById(userId);
    if (!user) {
      console.error("❌ [ERROR] User not found:", userId);
      return sendErrorResponse(res, 'User not found', HttpStatus.NOT_FOUND);
    }
    
    let updateData = {};
    let message = 'File uploaded successfully';
    
    switch(fileType) {
      case 'profilePic':
        updateData.profilePic = file.fileUrl;
        message = 'Profile picture uploaded successfully';
        console.log("🖼️ [UPDATING PROFILE PICTURE]");
        break;
        
      case 'qualification':
        if (qualificationIndex !== undefined && user.streamerProfile?.qualifications[qualificationIndex]) {
          const updatedQualifications = [...user.streamerProfile.qualifications];
          updatedQualifications[qualificationIndex] = {
            ...updatedQualifications[qualificationIndex],
            certificateUrl: file.fileUrl,
            certificateFileName: file.fileName
          };
          updateData['streamerProfile.qualifications'] = updatedQualifications;
          message = `Qualification certificate uploaded for ${updatedQualifications[qualificationIndex].degree}`;
          console.log("📜 [UPDATING QUALIFICATION]:", qualificationIndex);
        } else {
          // Additional qualification file
          const newQualification = {
            degree: "Additional Certificate",
            institute: "Additional",
            year: new Date().getFullYear(),
            certificateUrl: file.fileUrl,
            certificateFileName: file.fileName
          };
          
          const updatedQualifications = [...(user.streamerProfile?.qualifications || []), newQualification];
          updateData['streamerProfile.qualifications'] = updatedQualifications;
          message = 'Additional qualification uploaded successfully';
          console.log("➕ [ADDING NEW QUALIFICATION]");
        }
        break;
        
      case 'certification':
        if (certificationIndex !== undefined && user.streamerProfile?.certifications[certificationIndex]) {
          const updatedCertifications = [...user.streamerProfile.certifications];
          updatedCertifications[certificationIndex] = {
            ...updatedCertifications[certificationIndex],
            certificateUrl: file.fileUrl,
            certificateFileName: file.fileName
          };
          updateData['streamerProfile.certifications'] = updatedCertifications;
          message = `Certification uploaded for ${updatedCertifications[certificationIndex].name}`;
          console.log("🎓 [UPDATING CERTIFICATION]:", certificationIndex);
        } else {
          // Additional certification file
          const newCertification = {
            name: "Additional Certification",
            issuer: "Additional",
            issueDate: new Date(),
            certificateUrl: file.fileUrl,
            certificateFileName: file.fileName
          };
          
          const updatedCertifications = [...(user.streamerProfile?.certifications || []), newCertification];
          updateData['streamerProfile.certifications'] = updatedCertifications;
          message = 'Additional certification uploaded successfully';
          console.log("➕ [ADDING NEW CERTIFICATION]");
        }
        break;
        
      default:
        console.error("❌ [ERROR] Invalid file type:", fileType);
        return sendErrorResponse(res, 'Invalid file type', HttpStatus.BAD_REQUEST);
    }
    
    // Update user in database
    const updatedUser = await authenticationModel.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true }
    );
    
    console.log("✅ [USER UPDATED SUCCESSFULLY]");
    
    return sendSuccessResponse(
      res,
      {
        fileUrl: file.fileUrl,
        fileName: file.fileName,
        fileType,
        userId,
        qualificationIndex,
        certificationIndex,
        message
      },
      message,
      HttpStatus.OK
    );
    
  } catch (err) {
    console.error("❌ [ERROR] in uploadFile:", err);
    return sendErrorResponse(res, 'File upload failed', HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// Upload profile picture (NO TOKEN NEEDED)
export const uploadProfilePic = async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return sendErrorResponse(res, 'User ID is required', HttpStatus.BAD_REQUEST);
    }
    
    const uploadedFiles = req.fileUrls || {};
    const profilePic = uploadedFiles.profilePic;
    
    if (!profilePic) {
      return sendErrorResponse(res, 'No profile picture uploaded', HttpStatus.BAD_REQUEST);
    }
    
    // Check if user exists
    const userExists = await authenticationModel.findById(userId);
    if (!userExists) {
      return sendErrorResponse(res, 'User not found', HttpStatus.NOT_FOUND);
    }
    
    await authenticationModel.findByIdAndUpdate(
      userId,
      { profilePic: profilePic.fileUrl },
      { new: true }
    );
    
    return sendSuccessResponse(
      res,
      {
        profilePicUrl: profilePic.fileUrl,
        fileName: profilePic.fileName,
        userId
      },
      'Profile picture uploaded successfully',
      HttpStatus.OK
    );
    
  } catch (err) {
    console.error("❌ [ERROR] in uploadProfilePic:", err);
    return sendErrorResponse(res, 'Profile picture upload failed', HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// Upload qualification certificate (NO TOKEN NEEDED)
export const uploadQualificationCertificate = async (req, res) => {
  try {
    const { userId, qualificationIndex, qualificationId } = req.body;
    
    if (!userId) {
      return sendErrorResponse(res, 'User ID is required', HttpStatus.BAD_REQUEST);
    }
    
    const uploadedFiles = req.fileUrls || {};
    const certificateFile = uploadedFiles.certificateFile;
    
    if (!certificateFile) {
      return sendErrorResponse(res, 'No certificate file uploaded', HttpStatus.BAD_REQUEST);
    }
    
    const user = await authenticationModel.findById(userId);
    if (!user || !user.streamerProfile) {
      return sendErrorResponse(res, 'User or streamer profile not found', HttpStatus.NOT_FOUND);
    }
    
    let updatedQualifications = [...user.streamerProfile.qualifications];
    
    // यदि qualificationIndex दिया है
    if (qualificationIndex !== undefined && updatedQualifications[qualificationIndex]) {
      updatedQualifications[qualificationIndex] = {
        ...updatedQualifications[qualificationIndex],
        certificateUrl: certificateFile.fileUrl,
        certificateFileName: certificateFile.fileName
      };
    } 
    // यदि qualificationId दिया है
    else if (qualificationId) {
      const index = updatedQualifications.findIndex(q => 
        q._id?.toString() === qualificationId || 
        q.degree === qualificationId
      );
      
      if (index !== -1) {
        updatedQualifications[index] = {
          ...updatedQualifications[index],
          certificateUrl: certificateFile.fileUrl,
          certificateFileName: certificateFile.fileName
        };
      } else {
        // New qualification
        updatedQualifications.push({
          degree: "Additional Certificate",
          institute: "Additional",
          year: new Date().getFullYear(),
          certificateUrl: certificateFile.fileUrl,
          certificateFileName: certificateFile.fileName
        });
      }
    } 
    // New qualification
    else {
      updatedQualifications.push({
        degree: "Additional Certificate",
        institute: "Additional",
        year: new Date().getFullYear(),
        certificateUrl: certificateFile.fileUrl,
        certificateFileName: certificateFile.fileName
      });
    }
    
    await authenticationModel.findByIdAndUpdate(
      userId,
      { 'streamerProfile.qualifications': updatedQualifications },
      { new: true }
    );
    
    return sendSuccessResponse(
      res,
      {
        certificateUrl: certificateFile.fileUrl,
        fileName: certificateFile.fileName,
        userId,
        qualificationIndex
      },
      'Qualification certificate uploaded successfully',
      HttpStatus.OK
    );
    
  } catch (err) {
    console.error("❌ [ERROR] in uploadQualificationCertificate:", err);
    return sendErrorResponse(res, 'Certificate upload failed', HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// Upload certification document (NO TOKEN NEEDED)
export const uploadCertificationDocument = async (req, res) => {
  try {
    const { userId, certificationIndex, certificationId } = req.body;
    
    if (!userId) {
      return sendErrorResponse(res, 'User ID is required', HttpStatus.BAD_REQUEST);
    }
    
    const uploadedFiles = req.fileUrls || {};
    const certificateFile = uploadedFiles.certificateFile;
    
    if (!certificateFile) {
      return sendErrorResponse(res, 'No certificate file uploaded', HttpStatus.BAD_REQUEST);
    }
    
    const user = await authenticationModel.findById(userId);
    if (!user || !user.streamerProfile) {
      return sendErrorResponse(res, 'User or streamer profile not found', HttpStatus.NOT_FOUND);
    }
    
    let updatedCertifications = [...user.streamerProfile.certifications];
    
    // यदि certificationIndex दिया है
    if (certificationIndex !== undefined && updatedCertifications[certificationIndex]) {
      updatedCertifications[certificationIndex] = {
        ...updatedCertifications[certificationIndex],
        certificateUrl: certificateFile.fileUrl,
        certificateFileName: certificateFile.fileName
      };
    } 
    // यदि certificationId दिया है
    else if (certificationId) {
      const index = updatedCertifications.findIndex(c => 
        c._id?.toString() === certificationId || 
        c.name === certificationId
      );
      
      if (index !== -1) {
        updatedCertifications[index] = {
          ...updatedCertifications[index],
          certificateUrl: certificateFile.fileUrl,
          certificateFileName: certificateFile.fileName
        };
      } else {
        // New certification
        updatedCertifications.push({
          name: "Additional Certification",
          issuer: "Additional",
          issueDate: new Date(),
          certificateUrl: certificateFile.fileUrl,
          certificateFileName: certificateFile.fileName
        });
      }
    } 
    // New certification
    else {
      updatedCertifications.push({
        name: "Additional Certification",
        issuer: "Additional",
        issueDate: new Date(),
        certificateUrl: certificateFile.fileUrl,
        certificateFileName: certificateFile.fileName
      });
    }
    
    await authenticationModel.findByIdAndUpdate(
      userId,
      { 'streamerProfile.certifications': updatedCertifications },
      { new: true }
    );
    
    return sendSuccessResponse(
      res,
      {
        certificateUrl: certificateFile.fileUrl,
        fileName: certificateFile.fileName,
        userId,
        certificationIndex
      },
      'Certification document uploaded successfully',
      HttpStatus.OK
    );
    
  } catch (err) {
    console.error("❌ [ERROR] in uploadCertificationDocument:", err);
    return sendErrorResponse(res, 'Certification upload failed', HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// Upload multiple files at once (NO TOKEN NEEDED)
export const uploadMultipleFiles = async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return sendErrorResponse(res, 'User ID is required', HttpStatus.BAD_REQUEST);
    }
    
    const uploadedFiles = req.fileUrls || {};
    const results = [];
    
    // Check if user exists
    const user = await authenticationModel.findById(userId);
    if (!user) {
      return sendErrorResponse(res, 'User not found', HttpStatus.NOT_FOUND);
    }
    
    let updateData = {};
    
    // Process profile picture
    if (uploadedFiles.profilePic) {
      updateData.profilePic = uploadedFiles.profilePic.fileUrl;
      results.push({
        type: 'profilePic',
        fileName: uploadedFiles.profilePic.fileName,
        fileUrl: uploadedFiles.profilePic.fileUrl,
        status: 'success'
      });
    }
    
    // Process qualification certificates
    if (uploadedFiles.qualificationCertificates) {
      const qualFiles = Array.isArray(uploadedFiles.qualificationCertificates) 
        ? uploadedFiles.qualificationCertificates 
        : [uploadedFiles.qualificationCertificates];
      
      const existingQualifications = user.streamerProfile?.qualifications || [];
      const updatedQualifications = [...existingQualifications];
      
      qualFiles.forEach((file, index) => {
        if (updatedQualifications[index]) {
          updatedQualifications[index] = {
            ...updatedQualifications[index],
            certificateUrl: file.fileUrl,
            certificateFileName: file.fileName
          };
        } else {
          updatedQualifications.push({
            degree: `Certificate ${index + 1}`,
            institute: "Uploaded",
            year: new Date().getFullYear(),
            certificateUrl: file.fileUrl,
            certificateFileName: file.fileName
          });
        }
        
        results.push({
          type: 'qualification',
          index,
          fileName: file.fileName,
          fileUrl: file.fileUrl,
          status: 'success'
        });
      });
      
      updateData['streamerProfile.qualifications'] = updatedQualifications;
    }
    
    // Process certification files
    if (uploadedFiles.certificationFiles) {
      const certFiles = Array.isArray(uploadedFiles.certificationFiles) 
        ? uploadedFiles.certificationFiles 
        : [uploadedFiles.certificationFiles];
      
      const existingCertifications = user.streamerProfile?.certifications || [];
      const updatedCertifications = [...existingCertifications];
      
      certFiles.forEach((file, index) => {
        if (updatedCertifications[index]) {
          updatedCertifications[index] = {
            ...updatedCertifications[index],
            certificateUrl: file.fileUrl,
            certificateFileName: file.fileName
          };
        } else {
          updatedCertifications.push({
            name: `Certification ${index + 1}`,
            issuer: "Uploaded",
            issueDate: new Date(),
            certificateUrl: file.fileUrl,
            certificateFileName: file.fileName
          });
        }
        
        results.push({
          type: 'certification',
          index,
          fileName: file.fileName,
          fileUrl: file.fileUrl,
          status: 'success'
        });
      });
      
      updateData['streamerProfile.certifications'] = updatedCertifications;
    }
    
    // Update user with all files
    await authenticationModel.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true }
    );
    
    return sendSuccessResponse(
      res,
      {
        userId,
        uploadedFiles: results,
        totalFiles: results.length
      },
      `${results.length} files uploaded successfully`,
      HttpStatus.OK
    );
    
  } catch (err) {
    console.error("❌ [ERROR] in uploadMultipleFiles:", err);
    
    // Rollback uploaded files if update fails
    try {
      const uploadedFiles = req.fileUrls || {};
      const allFileUrls = [];
      
      if (uploadedFiles.profilePic) allFileUrls.push(uploadedFiles.profilePic.fileUrl);
      if (uploadedFiles.qualificationCertificates) {
        const files = Array.isArray(uploadedFiles.qualificationCertificates) 
          ? uploadedFiles.qualificationCertificates 
          : [uploadedFiles.qualificationCertificates];
        files.forEach(file => allFileUrls.push(file.fileUrl));
      }
      if (uploadedFiles.certificationFiles) {
        const files = Array.isArray(uploadedFiles.certificationFiles) 
          ? uploadedFiles.certificationFiles 
          : [uploadedFiles.certificationFiles];
        files.forEach(file => allFileUrls.push(file.fileUrl));
      }
      
      for (const fileUrl of allFileUrls) {
        await deleteFileFromS3(fileUrl);
      }
    } catch (rollbackError) {
      console.error("❌ [ROLLBACK ERROR]:", rollbackError);
    }
    
    return sendErrorResponse(res, 'Multiple files upload failed', HttpStatus.INTERNAL_SERVER_ERROR);
  }
};




// controller/Authentication/authentication.controller.js
// export const createStreamerAccount = async (req, res) => {
//   try {
//     const { 
//       secretId, 
//       name, 
//       password, 
//       confirmPassword,
//       // Streamer profile fields
//       bio,
//       expertise,
//       experienceYears,
//       experienceDescription,
//       qualifications: qualificationsJson,
//       certifications: certificationsJson,
//       socialLinks: socialLinksJson
//     } = req.body;
    
//     // ✅ Get uploaded files from middleware
//     const uploadedFiles = req.fileUrls || {};
//     console.log("📁 [UPLOADED FILES]", uploadedFiles);
    
//     const data = tempStore.get(secretId);

//     if (!data) {
//       return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
//     }

//     if (!data.isEmailVerified) {
//       return sendErrorResponse(res, errorEn.EMAIL_NOT_VERIFIED, HttpStatus.BAD_REQUEST);
//     }

//     if (password !== confirmPassword) {
//       return sendErrorResponse(res, errorEn.PASSWORD_NOT_MATCH, HttpStatus.BAD_REQUEST);
//     }
    
//     const email = data.email?.toLowerCase();

//     // ✅ Check again if user exists
//     const existingUser = await authenticationModel.findOne({ email });
//     if (existingUser) {
//       const message = errorEn.USER_ALREADY_REGISTERED
//         ? (typeof errorEn.USER_ALREADY_REGISTERED === "function"
//             ? errorEn.USER_ALREADY_REGISTERED("streamer")
//             : errorEn.USER_ALREADY_REGISTERED)
//         : "User already registered";

//       return sendErrorResponse(res, message, HttpStatus.CONFLICT);
//     }

//     // ✅ Validate required streamer fields
//     const requiredFields = ['bio', 'expertise', 'experienceYears', 'experienceDescription'];
//     const missingFields = requiredFields.filter(field => !req.body[field]);
    
//     if (missingFields.length > 0) {
//       return sendErrorResponse(
//         res, 
//         `The following fields are required for streamer registration: ${missingFields.join(', ')}`, 
//         HttpStatus.BAD_REQUEST
//       );
//     }

//     // ✅ Hash password
//     const hashedPassword = await genPassword(password);

//     // ✅ Parse JSON strings if they exist
//     let qualifications = [];
//     let certifications = [];
//     let socialLinks = {};
    
//     try {
//       if (qualificationsJson) {
//         qualifications = typeof qualificationsJson === 'string' 
//           ? JSON.parse(qualificationsJson) 
//           : qualificationsJson;
//       }
      
//       if (certificationsJson) {
//         certifications = typeof certificationsJson === 'string' 
//           ? JSON.parse(certificationsJson) 
//           : certificationsJson;
//       }
      
//       if (socialLinksJson) {
//         socialLinks = typeof socialLinksJson === 'string' 
//           ? JSON.parse(socialLinksJson) 
//           : socialLinksJson;
//       }
//     } catch (parseError) {
//       console.error("❌ [ERROR] Failed to parse JSON:", parseError);
//       return sendErrorResponse(
//         res, 
//         "Invalid JSON format in qualifications/certifications/socialLinks", 
//         HttpStatus.BAD_REQUEST
//       );
//     }

//     // ✅ Process uploaded files
//     const profilePictureUrl = uploadedFiles.profilePic ? uploadedFiles.profilePic.fileUrl : "";
    
//     // ✅ Attach certificate URLs to qualifications
//     if (qualifications && Array.isArray(qualifications) && uploadedFiles.qualificationCertificates) {
//       const qualCertificates = Array.isArray(uploadedFiles.qualificationCertificates) 
//         ? uploadedFiles.qualificationCertificates 
//         : [uploadedFiles.qualificationCertificates];
      
//       qualifications = qualifications.map((qual, index) => ({
//         ...qual,
//         certificateUrl: qualCertificates[index]?.fileUrl || qual.certificateUrl || "",
//         certificateFileName: qualCertificates[index]?.fileName || ""
//       }));
//     }

//     // ✅ Attach certificate URLs to certifications
//     if (certifications && Array.isArray(certifications) && uploadedFiles.certificationFiles) {
//       const certFiles = Array.isArray(uploadedFiles.certificationFiles) 
//         ? uploadedFiles.certificationFiles 
//         : [uploadedFiles.certificationFiles];
      
//       certifications = certifications.map((cert, index) => ({
//         ...cert,
//         certificateUrl: certFiles[index]?.fileUrl || cert.certificateUrl || "",
//         certificateFileName: certFiles[index]?.fileName || "",
//         issueDate: cert.issueDate ? new Date(cert.issueDate) : null,
//         expiryDate: cert.expiryDate ? new Date(cert.expiryDate) : null
//       }));
//     }

//     // ✅ Create user object with streamer profile
//     const userData = {
//       name,
//       email,
//       password: hashedPassword,
//       role: 'STREAMER',
//       profilePic: profilePictureUrl, // ✅ Set profile picture
//       isEmailVerified: true,
//       streamerProfile: {
//         verificationStatus: 'PENDING',
//         verificationRequestDate: new Date(),
//         bio,
//         expertise: Array.isArray(expertise) ? expertise : [expertise],
//         experienceYears: Number(experienceYears),
//         experienceDescription,
//         qualifications,
//         certifications,
//         socialLinks: socialLinks || {},
//         totalStreams: 0,
//         totalStudents: 0,
//         averageRating: 0,
//         totalEarnings: 0
//       }
//     };

//     const savedUser = await authenticationModel.create(userData);

//     // ✅ Remove temp store
//     tempStore.delete(secretId);

//     // ✅ Generate token for immediate login
//     const token = generateToken(savedUser);

//     // ✅ Prepare response data
//     const responseData = {
//       token,
//       userId: savedUser._id,
//       name: savedUser.name,
//       email: savedUser.email,
//       role: savedUser.role,
//       profilePic: savedUser.profilePic || profilePictureUrl,
//       isEmailVerified: true,
//       isActive: savedUser.isActive,
//       createdAt: savedUser.createdAt,
//       streamerProfile: {
//         bio: savedUser.streamerProfile.bio,
//         expertise: savedUser.streamerProfile.expertise,
//         experienceYears: savedUser.streamerProfile.experienceYears,
//         experienceDescription: savedUser.streamerProfile.experienceDescription,
//         verificationStatus: savedUser.streamerProfile.verificationStatus,
//         verificationRequestDate: savedUser.streamerProfile.verificationRequestDate,
//         qualifications: savedUser.streamerProfile.qualifications.map(q => ({
//           degree: q.degree,
//           institute: q.institute,
//           year: q.year,
//           certificateUrl: q.certificateUrl,
//           certificateFileName: q.certificateFileName
//         })),
//         certifications: savedUser.streamerProfile.certifications.map(c => ({
//           name: c.name,
//           issuer: c.issuer,
//           issueDate: c.issueDate,
//           expiryDate: c.expiryDate,
//           certificateUrl: c.certificateUrl,
//           certificateFileName: c.certificateFileName
//         })),
//         socialLinks: savedUser.streamerProfile.socialLinks,
//         message: 'Streamer account created successfully. Your profile is pending admin verification.'
//       }
//     };

//     return sendSuccessResponse(
//       res,
//       responseData,
//       'Streamer account created successfully. Verification pending.',
//       HttpStatus.OK
//     );

//   } catch (err) {
//     console.error("❌ [ERROR] in createStreamerAccount:", err);

//     // ✅ Rollback uploaded files if user creation fails
//     try {
//       const uploadedFiles = req.fileUrls || {};
//       const allFiles = [];
      
//       if (uploadedFiles.profilePic) allFiles.push(uploadedFiles.profilePic.fileUrl);
//       if (uploadedFiles.qualificationCertificates) {
//         const qualFiles = Array.isArray(uploadedFiles.qualificationCertificates) 
//           ? uploadedFiles.qualificationCertificates 
//           : [uploadedFiles.qualificationCertificates];
//         qualFiles.forEach(file => allFiles.push(file.fileUrl));
//       }
//       if (uploadedFiles.certificationFiles) {
//         const certFiles = Array.isArray(uploadedFiles.certificationFiles) 
//           ? uploadedFiles.certificationFiles 
//           : [uploadedFiles.certificationFiles];
//         certFiles.forEach(file => allFiles.push(file.fileUrl));
//       }
      
//       for (const fileUrl of allFiles) {
//         await deleteFileFromS3(fileUrl);
//       }
//     } catch (rollbackError) {
//       console.error("❌ [ERROR] Failed to rollback files:", rollbackError);
//     }

//     const message = errorEn.INTERNAL_SERVER_ERROR
//       ? (typeof errorEn.INTERNAL_SERVER_ERROR === "function"
//           ? errorEn.INTERNAL_SERVER_ERROR()
//           : errorEn.INTERNAL_SERVER_ERROR)
//       : "Internal server error";

//     return sendErrorResponse(res, message, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };


// export const createStreamerAccount = async (req, res) => {
//   try {
//     const { 
//       secretId, 
//       name, 
//       password, 
//       confirmPassword,
//       // Streamer profile fields
//       bio,
//       expertise,
//       experienceYears,
//       experienceDescription,
//       qualifications: qualificationsJson,
//       certifications: certificationsJson,
//       socialLinks: socialLinksJson
//     } = req.body;
    
//     // ✅ Get uploaded files from middleware
//     const uploadedFiles = req.fileUrls || {};
//     console.log("📁 [UPLOADED FILES in CONTROLLER]", JSON.stringify(uploadedFiles, null, 2));
    
//     // ✅ Validate secretId and temp store
//     const data = tempStore.get(secretId);
//     if (!data) {
//       return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
//     }

//     if (!data.isEmailVerified) {
//       return sendErrorResponse(res, errorEn.EMAIL_NOT_VERIFIED, HttpStatus.BAD_REQUEST);
//     }

//     if (password !== confirmPassword) {
//       return sendErrorResponse(res, errorEn.PASSWORD_NOT_MATCH, HttpStatus.BAD_REQUEST);
//     }
    
//     const email = data.email?.toLowerCase();

//     // ✅ Check if user already exists
//     const existingUser = await authenticationModel.findOne({ email });
//     if (existingUser) {
//       const message = errorEn.USER_ALREADY_REGISTERED
//         ? (typeof errorEn.USER_ALREADY_REGISTERED === "function"
//             ? errorEn.USER_ALREADY_REGISTERED("streamer")
//             : errorEn.USER_ALREADY_REGISTERED)
//         : "User already registered";

//       return sendErrorResponse(res, message, HttpStatus.CONFLICT);
//     }

//     // ✅ Validate required streamer fields
//     const requiredFields = ['bio', 'expertise', 'experienceYears', 'experienceDescription'];
//     const missingFields = requiredFields.filter(field => !req.body[field]);
    
//     if (missingFields.length > 0) {
//       return sendErrorResponse(
//         res, 
//         `The following fields are required for streamer registration: ${missingFields.join(', ')}`, 
//         HttpStatus.BAD_REQUEST
//       );
//     }

//     // ✅ Hash password
//     const hashedPassword = await genPassword(password);

//     // ✅ Parse JSON strings if they exist
//     let qualifications = [];
//     let certifications = [];
//     let socialLinks = {};
    
//     try {
//       if (qualificationsJson) {
//         qualifications = typeof qualificationsJson === 'string' 
//           ? JSON.parse(qualificationsJson) 
//           : qualificationsJson;
//       }
      
//       if (certificationsJson) {
//         certifications = typeof certificationsJson === 'string' 
//           ? JSON.parse(certificationsJson) 
//           : certificationsJson;
//       }
      
//       if (socialLinksJson) {
//         socialLinks = typeof socialLinksJson === 'string' 
//           ? JSON.parse(socialLinksJson) 
//           : socialLinksJson;
//       }
//     } catch (parseError) {
//       console.error("❌ [ERROR] Failed to parse JSON:", parseError);
//       return sendErrorResponse(
//         res, 
//         "Invalid JSON format in qualifications/certifications/socialLinks", 
//         HttpStatus.BAD_REQUEST
//       );
//     }

//     // ✅ Process uploaded files
//     // profilePic - single object
//     const profilePictureUrl = uploadedFiles.profilePic ? uploadedFiles.profilePic.fileUrl : "";
//     console.log("👤 [PROFILE PIC URL]:", profilePictureUrl);
    
//     // ✅ Attach certificate URLs to qualifications
//     if (qualifications && Array.isArray(qualifications)) {
//       const qualCertificates = uploadedFiles.qualificationCertificates || [];
//       console.log("📜 [QUALIFICATIONS FILES]:", qualCertificates);
      
//       qualifications = qualifications.map((qual, index) => ({
//         ...qual,
//         // अगर ऐरे में फाइल है तो उसका URL लो, नहीं तो खाली रखो
//         certificateUrl: qualCertificates[index] ? qualCertificates[index].fileUrl : "",
//         certificateFileName: qualCertificates[index] ? qualCertificates[index].fileName : "",
//         // सुनिश्चित करें कि year नंबर है
//         year: qual.year ? Number(qual.year) : null
//       }));
//     }
    
//     console.log("✅ [FINAL QUALIFICATIONS]:", qualifications);

//     // ✅ Attach certificate URLs to certifications
//     if (certifications && Array.isArray(certifications)) {
//       const certFiles = uploadedFiles.certificationFiles || [];
//       console.log("🎓 [CERTIFICATIONS FILES]:", certFiles);
      
//       certifications = certifications.map((cert, index) => ({
//         ...cert,
//         certificateUrl: certFiles[index] ? certFiles[index].fileUrl : "",
//         certificateFileName: certFiles[index] ? certFiles[index].fileName : "",
//         // डेट को Date ऑब्जेक्ट में कन्वर्ट करें
//         issueDate: cert.issueDate ? new Date(cert.issueDate) : null,
//         expiryDate: cert.expiryDate ? new Date(cert.expiryDate) : null
//       }));
//     }
    
//     console.log("✅ [FINAL CERTIFICATIONS]:", certifications);

//     // ✅ Create user object with streamer profile
//     const userData = {
//       name: name.trim(),
//       email: email.trim(),
//       password: hashedPassword,
//       role: 'STREAMER',
//       profilePic: profilePictureUrl,
//       isEmailVerified: true,
//       isActive: true,
//       streamerProfile: {
//         verificationStatus: 'PENDING',
//         verificationRequestDate: new Date(),
//         bio: bio.trim(),
//         expertise: Array.isArray(expertise) ? expertise : [expertise],
//         experienceYears: Number(experienceYears),
//         experienceDescription: experienceDescription.trim(),
//         qualifications: qualifications || [],
//         certifications: certifications || [],
//         socialLinks: socialLinks || {},
//         totalStreams: 0,
//         totalStudents: 0,
//         averageRating: 0,
//         totalEarnings: 0,
//         isProfileComplete: true
//       }
//     };

//     console.log("📝 [USER DATA TO SAVE]:", JSON.stringify(userData, null, 2));

//     // ✅ Save to database
//     const savedUser = await authenticationModel.create(userData);

//     // ✅ Remove temp store
//     tempStore.delete(secretId);

//     // ✅ Generate token for immediate login
//     const token = generateToken(savedUser);

//     // ✅ Prepare response data
//     const responseData = {
//       token,
//       userId: savedUser._id,
//       name: savedUser.name,
//       email: savedUser.email,
//       role: savedUser.role,
//       profilePic: savedUser.profilePic,
//       isEmailVerified: true,
//       isActive: savedUser.isActive,
//       createdAt: savedUser.createdAt,
//       streamerProfile: {
//         bio: savedUser.streamerProfile.bio,
//         expertise: savedUser.streamerProfile.expertise,
//         experienceYears: savedUser.streamerProfile.experienceYears,
//         experienceDescription: savedUser.streamerProfile.experienceDescription,
//         verificationStatus: savedUser.streamerProfile.verificationStatus,
//         verificationRequestDate: savedUser.streamerProfile.verificationRequestDate,
//         qualifications: savedUser.streamerProfile.qualifications.map(q => ({
//           degree: q.degree,
//           institute: q.institute,
//           year: q.year,
//           certificateUrl: q.certificateUrl,
//           certificateFileName: q.certificateFileName
//         })),
//         certifications: savedUser.streamerProfile.certifications.map(c => ({
//           name: c.name,
//           issuer: c.issuer,
//           issueDate: c.issueDate,
//           expiryDate: c.expiryDate,
//           certificateUrl: c.certificateUrl,
//           certificateFileName: c.certificateFileName
//         })),
//         socialLinks: savedUser.streamerProfile.socialLinks,
//         message: 'Streamer account created successfully. Your profile is pending admin verification.'
//       }
//     };

//     return sendSuccessResponse(
//       res,
//       responseData,
//       'Streamer account created successfully. Verification pending.',
//       HttpStatus.OK
//     );

//   } catch (err) {
//     console.error("❌ [ERROR] in createStreamerAccount:", err);

//     // ✅ Rollback uploaded files if user creation fails
//     try {
//       const uploadedFiles = req.fileUrls || {};
//       const allFiles = [];
      
//       // profilePic
//       if (uploadedFiles.profilePic && uploadedFiles.profilePic.fileUrl) {
//         allFiles.push(uploadedFiles.profilePic.fileUrl);
//       }
      
//       // qualificationCertificates
//       if (uploadedFiles.qualificationCertificates && Array.isArray(uploadedFiles.qualificationCertificates)) {
//         uploadedFiles.qualificationCertificates.forEach(file => {
//           if (file.fileUrl) allFiles.push(file.fileUrl);
//         });
//       }
      
//       // certificationFiles
//       if (uploadedFiles.certificationFiles && Array.isArray(uploadedFiles.certificationFiles)) {
//         uploadedFiles.certificationFiles.forEach(file => {
//           if (file.fileUrl) allFiles.push(file.fileUrl);
//         });
//       }
      
//       console.log("🔄 [ROLLBACK] Deleting files:", allFiles);
      
//       for (const fileUrl of allFiles) {
//         await deleteFileFromS3(fileUrl);
//       }
//     } catch (rollbackError) {
//       console.error("❌ [ERROR] Failed to rollback files:", rollbackError);
//     }

//     const message = errorEn.INTERNAL_SERVER_ERROR
//       ? (typeof errorEn.INTERNAL_SERVER_ERROR === "function"
//           ? errorEn.INTERNAL_SERVER_ERROR()
//           : errorEn.INTERNAL_SERVER_ERROR)
//       : "Internal server error";

//     return sendErrorResponse(res, message, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };


export const createStreamerAccount = async (req, res) => {
  try {
    const { 
      secretId, 
      name, 
      password, 
      confirmPassword,
      // Streamer profile fields
      bio,
      expertise,
      experienceYears,
      experienceDescription,
      qualifications: qualificationsJson,
      certifications: certificationsJson,
      socialLinks: socialLinksJson
    } = req.body;
    
    // ✅ DEBUG: Check what's coming in request
    console.log("🔑 [SECRET_ID RECEIVED]:", secretId);
    console.log("📂 [TEMP_STORE KEYS]:", Array.from(tempStore.keys()));
    console.log("📦 [TEMP_STORE DATA for this ID]:", tempStore.get(secretId));
    
    // ✅ Get uploaded files from middleware (EXACTLY like course controller)
    const uploadedFiles = req.fileUrls || {};
    console.log("📁 [UPLOADED FILES in CONTROLLER]", JSON.stringify(uploadedFiles, null, 2));
    
    // ✅ Validate secretId and temp store (WITH DEBUGGING)
    const data = tempStore.get(secretId);
    if (!data) {
      console.error("❌ [ERROR] Secret ID not found in tempStore:", secretId);
      console.error("📊 [TEMP_STORE DUMP]:", 
        Array.from(tempStore.keys()).map(key => ({ 
          key, 
          data: tempStore.get(key) 
        }))
      );
      return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
    }

    if (!data.isEmailVerified) {
      console.error("❌ [ERROR] Email not verified for secretId:", secretId);
      return sendErrorResponse(res, errorEn.EMAIL_NOT_VERIFIED, HttpStatus.BAD_REQUEST);
    }

    if (password !== confirmPassword) {
      return sendErrorResponse(res, errorEn.PASSWORD_NOT_MATCH, HttpStatus.BAD_REQUEST);
    }
    
    const email = data.email?.toLowerCase();
    console.log("📧 [EMAIL FROM TEMPSTORE]:", email);

    // ✅ Check if user already exists
    const existingUser = await authenticationModel.findOne({ email });
    if (existingUser) {
      const message = errorEn.USER_ALREADY_REGISTERED
        ? (typeof errorEn.USER_ALREADY_REGISTERED === "function"
            ? errorEn.USER_ALREADY_REGISTERED("streamer")
            : errorEn.USER_ALREADY_REGISTERED)
        : "User already registered";

      console.error("❌ [ERROR] User already exists:", email);
      return sendErrorResponse(res, message, HttpStatus.CONFLICT);
    }

    // ✅ Validate required streamer fields
    const requiredFields = ['bio', 'expertise', 'experienceYears', 'experienceDescription'];
    const missingFields = requiredFields.filter(field => !req.body[field]);
    
    if (missingFields.length > 0) {
      console.error("❌ [ERROR] Missing required fields:", missingFields);
      return sendErrorResponse(
        res, 
        `The following fields are required for streamer registration: ${missingFields.join(', ')}`, 
        HttpStatus.BAD_REQUEST
      );
    }

    // ✅ Hash password
    const hashedPassword = await genPassword(password);

    // ✅ Parse JSON strings if they exist
    let qualifications = [];
    let certifications = [];
    let socialLinks = {};
    
    try {
      if (qualificationsJson) {
        qualifications = typeof qualificationsJson === 'string' 
          ? JSON.parse(qualificationsJson) 
          : qualificationsJson;
        console.log("📜 [PARSED QUALIFICATIONS]:", qualifications);
      }
      
      if (certificationsJson) {
        certifications = typeof certificationsJson === 'string' 
          ? JSON.parse(certificationsJson) 
          : certificationsJson;
        console.log("🎓 [PARSED CERTIFICATIONS]:", certifications);
      }
      
      if (socialLinksJson) {
        socialLinks = typeof socialLinksJson === 'string' 
          ? JSON.parse(socialLinksJson) 
          : socialLinksJson;
        console.log("🔗 [PARSED SOCIAL LINKS]:", socialLinks);
      }
    } catch (parseError) {
      console.error("❌ [ERROR] Failed to parse JSON:", parseError);
      return sendErrorResponse(
        res, 
        "Invalid JSON format in qualifications/certifications/socialLinks", 
        HttpStatus.BAD_REQUEST
      );
    }

    // ✅ Process uploaded files (LIKE COURSE CONTROLLER)
    // profilePic - single object (maxCount: 1)
    let profilePictureUrl = "";
    let profilePicData = null;
    
    // Method 1: Check if uploadedFiles.profilePic is an object (single file)
    if (uploadedFiles.profilePic && typeof uploadedFiles.profilePic === 'object' && uploadedFiles.profilePic.fileUrl) {
      profilePicData = uploadedFiles.profilePic;
      profilePictureUrl = profilePicData.fileUrl;
    }
    // Method 2: Check if it's an array (backward compatibility)
    else if (uploadedFiles.profilePic && Array.isArray(uploadedFiles.profilePic) && uploadedFiles.profilePic.length > 0) {
      profilePicData = uploadedFiles.profilePic[0];
      profilePictureUrl = profilePicData.fileUrl;
    }
    
    console.log("👤 [PROFILE PIC PROCESSED]:", {
      url: profilePictureUrl,
      data: profilePicData
    });
    
    // ✅ Attach certificate URLs to qualifications
    if (qualifications && Array.isArray(qualifications)) {
      let qualCertificates = [];
      
      // Handle both array and single object cases
      if (uploadedFiles.qualificationCertificates) {
        if (Array.isArray(uploadedFiles.qualificationCertificates)) {
          qualCertificates = uploadedFiles.qualificationCertificates;
        } else {
          qualCertificates = [uploadedFiles.qualificationCertificates];
        }
      }
      
      console.log("📄 [QUALIFICATIONS FILES FOUND]:", qualCertificates.length);
      
      qualifications = qualifications.map((qual, index) => ({
        ...qual,
        certificateUrl: qualCertificates[index] ? qualCertificates[index].fileUrl : "",
        certificateFileName: qualCertificates[index] ? qualCertificates[index].fileName : "",
        year: qual.year ? Number(qual.year) : null
      }));
    }
    
    console.log("✅ [FINAL QUALIFICATIONS WITH FILES]:", qualifications);

    // ✅ Attach certificate URLs to certifications
    if (certifications && Array.isArray(certifications)) {
      let certFiles = [];
      
      // Handle both array and single object cases
      if (uploadedFiles.certificationFiles) {
        if (Array.isArray(uploadedFiles.certificationFiles)) {
          certFiles = uploadedFiles.certificationFiles;
        } else {
          certFiles = [uploadedFiles.certificationFiles];
        }
      }
      
      console.log("📑 [CERTIFICATIONS FILES FOUND]:", certFiles.length);
      
      certifications = certifications.map((cert, index) => ({
        ...cert,
        certificateUrl: certFiles[index] ? certFiles[index].fileUrl : "",
        certificateFileName: certFiles[index] ? certFiles[index].fileName : "",
        issueDate: cert.issueDate ? new Date(cert.issueDate) : null,
        expiryDate: cert.expiryDate ? new Date(cert.expiryDate) : null
      }));
    }
    
    console.log("✅ [FINAL CERTIFICATIONS WITH FILES]:", certifications);

    // ✅ Create user object with streamer profile
    const userData = {
      name: name.trim(),
      email: email.trim(),
      password: hashedPassword,
      role: 'STREAMER',
      profilePic: profilePictureUrl,
      isEmailVerified: true,
      isActive: true,
      streamerProfile: {
        verificationStatus: 'PENDING',
        verificationRequestDate: new Date(),
        bio: bio.trim(),
        expertise: typeof expertise === 'string' ? JSON.parse(expertise) : (Array.isArray(expertise) ? expertise : [expertise]),
        experienceYears: Number(experienceYears),
        experienceDescription: experienceDescription.trim(),
        qualifications: qualifications || [],
        certifications: certifications || [],
        socialLinks: socialLinks || {},
        totalStreams: 0,
        totalStudents: 0,
        averageRating: 0,
        totalEarnings: 0,
        isProfileComplete: true,
        // ✅ Store file metadata for reference
        fileMetadata: {
          profilePic: profilePicData,
          qualificationFiles: uploadedFiles.qualificationCertificates || [],
          certificationFiles: uploadedFiles.certificationFiles || []
        }
      }
    };

    console.log("📝 [USER DATA TO SAVE]:", JSON.stringify(userData, null, 2));

    // ✅ Save to database
    const savedUser = await authenticationModel.create(userData);

    // ✅ Remove temp store
    tempStore.delete(secretId);
    console.log("🗑️ [TEMP_STORE] Removed secretId:", secretId);

    // ✅ Generate token for immediate login
    const token = generateToken(savedUser);

    // ✅ Prepare response data
    const responseData = {
      token,
      userId: savedUser._id,
      name: savedUser.name,
      email: savedUser.email,
      role: savedUser.role,
      profilePic: savedUser.profilePic,
      isEmailVerified: true,
      isActive: savedUser.isActive,
      createdAt: savedUser.createdAt,
      streamerProfile: {
        bio: savedUser.streamerProfile.bio,
        expertise: savedUser.streamerProfile.expertise,
        experienceYears: savedUser.streamerProfile.experienceYears,
        experienceDescription: savedUser.streamerProfile.experienceDescription,
        verificationStatus: savedUser.streamerProfile.verificationStatus,
        verificationRequestDate: savedUser.streamerProfile.verificationRequestDate,
        qualifications: savedUser.streamerProfile.qualifications.map(q => ({
          degree: q.degree,
          institute: q.institute,
          year: q.year,
          certificateUrl: q.certificateUrl || "",
          certificateFileName: q.certificateFileName || ""
        })),
        certifications: savedUser.streamerProfile.certifications.map(c => ({
          name: c.name,
          issuer: c.issuer,
          issueDate: c.issueDate,
          expiryDate: c.expiryDate,
          certificateUrl: c.certificateUrl || "",
          certificateFileName: c.certificateFileName || ""
        })),
        socialLinks: savedUser.streamerProfile.socialLinks,
        message: 'Streamer account created successfully. Your profile is pending admin verification.'
      }
    };

    console.log("🎉 [SUCCESS] Streamer account created:", {
      userId: savedUser._id,
      email: savedUser.email
    });

    return sendSuccessResponse(
      res,
      responseData,
      'Streamer account created successfully. Verification pending.',
      HttpStatus.OK
    );

  } catch (err) {
    console.error("❌ [ERROR] in createStreamerAccount:", err);
    console.error("📋 [ERROR DETAILS]:", {
      message: err.message,
      stack: err.stack,
      name: err.name
    });

    // ✅ Rollback uploaded files if user creation fails
    try {
      const uploadedFiles = req.fileUrls || {};
      const allFiles = [];
      
      console.log("🔄 [ROLLBACK] Starting rollback for files...");
      
      // profilePic
      if (uploadedFiles.profilePic) {
        if (uploadedFiles.profilePic.fileUrl) {
          allFiles.push(uploadedFiles.profilePic.fileUrl);
        } else if (Array.isArray(uploadedFiles.profilePic)) {
          uploadedFiles.profilePic.forEach(file => {
            if (file.fileUrl) allFiles.push(file.fileUrl);
          });
        }
      }
      
      // qualificationCertificates
      if (uploadedFiles.qualificationCertificates) {
        const qualFiles = Array.isArray(uploadedFiles.qualificationCertificates) 
          ? uploadedFiles.qualificationCertificates 
          : [uploadedFiles.qualificationCertificates];
        
        qualFiles.forEach(file => {
          if (file.fileUrl) allFiles.push(file.fileUrl);
        });
      }
      
      // certificationFiles
      if (uploadedFiles.certificationFiles) {
        const certFiles = Array.isArray(uploadedFiles.certificationFiles) 
          ? uploadedFiles.certificationFiles 
          : [uploadedFiles.certificationFiles];
        
        certFiles.forEach(file => {
          if (file.fileUrl) allFiles.push(file.fileUrl);
        });
      }
      
      console.log("🗑️ [ROLLBACK] Files to delete:", allFiles);
      
      // Delete all files
      for (const fileUrl of allFiles) {
        try {
          await deleteFileFromS3(fileUrl);
          console.log(`✅ [ROLLBACK] Deleted: ${fileUrl}`);
        } catch (deleteError) {
          console.error(`❌ [ROLLBACK ERROR] Failed to delete ${fileUrl}:`, deleteError);
        }
      }
    } catch (rollbackError) {
      console.error("❌ [ERROR] Failed to rollback files:", rollbackError);
    }

    const message = errorEn.INTERNAL_SERVER_ERROR
      ? (typeof errorEn.INTERNAL_SERVER_ERROR === "function"
          ? errorEn.INTERNAL_SERVER_ERROR()
          : errorEn.INTERNAL_SERVER_ERROR)
      : "Internal server error";

    return sendErrorResponse(res, message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// authentication.controller.js में login function
// export const login = async (req, res) => {
//   try {
//     const { email, password } = req.body;

//     if (!email || !password) {
//       return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
//     }

//     const user = await authenticationModel.findOne({
//       email: email.toLowerCase()
//     });

//     if (user) {
//       const isMatch = await comparePass(password, user.password);
//       if (!isMatch) {
//         return sendErrorResponse(res, errorEn.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED);
//       }

//       // ✅ Check if streamer is active/suspended
//       if (user.role === "STREAMER") {
//         if (!user.canStreamerLogin()) {  // यहाँ method नाम बदला है
//           let errorMessage = "";
          
//           if (user.streamerProfile?.verificationStatus === "PENDING") {
//             errorMessage = "Your streamer account is pending approval. Please wait for admin approval.";
//           } else if (user.streamerProfile?.verificationStatus === "REJECTED") {
//             errorMessage = "Your streamer application was rejected. Please contact admin.";
//           } else if (user.streamerProfile?.verificationStatus === "SUSPENDED") {
//             const suspensionReason = user.streamerProfile.suspensionReason || "No reason provided";
//             const suspensionEnds = user.streamerProfile.suspensionEndsAt 
//               ? ` until ${user.streamerProfile.suspensionEndsAt.toDateString()}`
//               : "";
//             errorMessage = `Your streamer account is suspended${suspensionEnds}. Reason: ${suspensionReason}`;
//           }
          
//           return sendErrorResponse(res, errorMessage, HttpStatus.FORBIDDEN);
//         }
//       }

//       // Update last login
//       user.lastLogin = new Date();
//       await user.save();

//       const token = generateToken(user); 

//       // Prepare response data
//       const userData = {
//         token,
//         userId: user._id,
//         name: user.name,
//         email: user.email,
//         role: user.role,
//         profilePic: user.profilePic || "",
//         isActive: user.isActive,
//         lastLogin: user.lastLogin,
//         createdAt: user.createdAt,
//         updatedAt: user.updatedAt
//       };

//       // ✅ Add streamer profile if role is STREAMER
//       if (user.role === "STREAMER" && user.streamerProfile) {
//         userData.streamerProfile = {
//           verificationStatus: user.streamerProfile.verificationStatus,
//           verificationDate: user.streamerProfile.verificationDate,
//           bio: user.streamerProfile.bio,
//           expertise: user.streamerProfile.expertise,
//           experienceYears: user.streamerProfile.experienceYears,
//           averageRating: user.streamerProfile.averageRating,
//           totalStreams: user.streamerProfile.totalStreams,
//           totalStudents: user.streamerProfile.totalStudents
//         };
//       }

//       return sendSuccessResponse(res, userData, successEn.LOGIN_SUCCESS, HttpStatus.OK);
//     }

//     return sendErrorResponse(res, errorEn.EMAIL_NOT_FOUND, HttpStatus.NOT_FOUND);
//   } catch (error) {
//     console.error("Error in login:", error);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };



export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
 
    if (!email || !password) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }
 
    // Find user with email (case-insensitive)
    const user = await authenticationModel.findOne({
      email: email.toLowerCase()
    });
 
    if (user) {
      // Check password match
      const isMatch = await comparePass(password, user.password);
      if (!isMatch) {
        console.log(`Login failed: Password mismatch for ${email}`);
        return sendErrorResponse(res, errorEn.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED);
      }
 
      // ✅ DEBUG LOG - Check user data before verification
      console.log("=== LOGIN DEBUG ===");
      console.log("User email:", email);
      console.log("User role:", user.role);
      console.log("Streamer profile exists:", !!user.streamerProfile);
      console.log("Verification status:", user.streamerProfile?.verificationStatus);
      console.log("isActive:", user.isActive);
      console.log("isEmailVerified:", user.isEmailVerified);
      console.log("===================");
 
      // ✅ Check if user account is active
      if (!user.isActive) {
        return sendErrorResponse(res, "Your account has been deactivated. Please contact support.", HttpStatus.FORBIDDEN);
      }
 
      // ✅ Check email verification based on role
      if (user.role === "STREAMER") {
        // Streamer requires email verification
        if (!user.isEmailVerified) {
          return sendErrorResponse(res, "Please verify your email before logging in.", HttpStatus.FORBIDDEN);
        }
       
        // Check if streamerProfile exists
        if (!user.streamerProfile) {
          console.error(`Streamer ${email} has no streamerProfile`);
          return sendErrorResponse(res, "Streamer profile not configured. Please contact support.", HttpStatus.FORBIDDEN);
        }
 
        // Check if streamer can login using the method
        if (!user.canStreamerLogin()) {
          let errorMessage = "";
         
          if (user.streamerProfile.verificationStatus === "PENDING") {
            errorMessage = "Your streamer account is pending approval. Please wait for admin approval.";
          } else if (user.streamerProfile.verificationStatus === "REJECTED") {
            errorMessage = "Your streamer application was rejected. Please contact admin.";
          } else if (user.streamerProfile.verificationStatus === "SUSPENDED") {
            const suspensionReason = user.streamerProfile.suspensionReason || "No reason provided";
            const suspensionEnds = user.streamerProfile.suspensionEndsAt
              ? ` until ${new Date(user.streamerProfile.suspensionEndsAt).toLocaleDateString()}`
              : " indefinitely";
            errorMessage = `Your streamer account is suspended${suspensionEnds}. Reason: ${suspensionReason}`;
          } else {
            errorMessage = "Your streamer account is not approved to login.";
          }
         
          console.log(`Streamer login blocked for ${email}: ${errorMessage}`);
          return sendErrorResponse(res, errorMessage, HttpStatus.FORBIDDEN);
        }
       
        console.log(`Streamer ${email} approved to login. Status: ${user.streamerProfile.verificationStatus}`);
      } else if (user.role === "ADMIN" || user.role === "VIEWER") {
        // ADMIN and VIEWER don't require email verification
        // Just ensure streamerProfile is null
        if (user.streamerProfile) {
          console.warn(`Non-streamer user ${email} has streamerProfile. Clearing it.`);
          // Force clear streamerProfile for non-streamers
          user.streamerProfile = null;
        }
      } else {
        // For any other role, check email verification
        if (!user.isEmailVerified) {
          return sendErrorResponse(res, "Please verify your email before logging in.", HttpStatus.FORBIDDEN);
        }
      }
 
      // Update last login timestamp
      user.lastLogin = new Date();
      await user.save();
 
      // Generate JWT token
      const token = generateToken(user);
 
      // Prepare response data - Common for all roles
      const userData = {
        token,
        userId: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        profilePic: user.profilePic || "",
        phone: user.phone || "",
        isActive: user.isActive,
        isEmailVerified: user.isEmailVerified,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      };
 
      // ✅ Add streamer profile ONLY for STREAMER role
      if (user.role === "STREAMER" && user.streamerProfile) {
        userData.streamerProfile = {
          verificationStatus: user.streamerProfile.verificationStatus,
          verificationDate: user.streamerProfile.verificationDate,
          verificationRequestDate: user.streamerProfile.verificationRequestDate,
          bio: user.streamerProfile.bio,
          expertise: user.streamerProfile.expertise || [],
          experienceYears: user.streamerProfile.experienceYears,
          experienceDescription: user.streamerProfile.experienceDescription,
          averageRating: user.streamerProfile.averageRating,
          totalStreams: user.streamerProfile.totalStreams,
          totalStudents: user.streamerProfile.totalStudents,
          totalEarnings: user.streamerProfile.totalEarnings,
          qualifications: user.streamerProfile.qualifications || [],
          certifications: user.streamerProfile.certifications || [],
          socialLinks: user.streamerProfile.socialLinks || {}
        };
       
        // Add suspension info if suspended
        if (user.streamerProfile.verificationStatus === "SUSPENDED") {
          userData.streamerProfile.suspensionReason = user.streamerProfile.suspensionReason;
          userData.streamerProfile.suspendedAt = user.streamerProfile.suspendedAt;
          userData.streamerProfile.suspensionEndsAt = user.streamerProfile.suspensionEndsAt;
        }
      }
 
      // Log successful login
      console.log(`Successful login for ${email} with role ${user.role}`);
     
      return sendSuccessResponse(res, userData, successEn.LOGIN_SUCCESS, HttpStatus.OK);
    }
 
    // User not found
    console.log(`Login failed: User not found for ${email}`);
    return sendErrorResponse(res, errorEn.EMAIL_NOT_FOUND, HttpStatus.NOT_FOUND);
  } catch (error) {
    console.error("Error in login:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// 6. Send OTP for Forget Password
export const sendOtpForgetPassword = async (req, res) => {
  try {
    let { email } = req.body;

    if (!email) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    email = email.toLowerCase();

    const existingUser = await authenticationModel.findOne({ email });

    if (!existingUser) {
      return sendErrorResponse(res, errorEn.EMAIL_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const secretId = uuidv4();

    tempStore.set(secretId, {
      userId: existingUser._id,
      email: existingUser.email,
      role: existingUser.role,
      otp,
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    await sendOtpToEmail(existingUser.email, otp);

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

// 7. Verify OTP
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

// 8. Reset Password
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












// import HttpStatus from 'http-status-codes';
// import { v4 as uuidv4 } from 'uuid';
// import authenticationModel from '../../model/Authentication/authentication.model.js';
// import { sendOtpToEmail, sendOtpToPhone } from '../../middleware/sendOtpToMail.js';
// import { sendSuccessResponse, sendErrorResponse } from '../../responses/responses.js';
// import { errorEn, successEn } from '../../responses/message.js';
// import { genPassword, comparePass } from '../../utils/password.js';
// import { generateToken } from '../../middleware/authentication.js';

// export const tempStore = new Map(); 

// // 1. Send Email OTP
// export const sendEmailOtp = async (req, res) => {
//   try {
//     let { email, secretId } = req.body;

//     if (!email) {
//       return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
//     }

//     email = email.toLowerCase();

//     const otp = Math.floor(1000 + Math.random() * 9000).toString();

//     const id = secretId || uuidv4();

//     const oldData = tempStore.get(id) || {};
//     oldData.email = email;
//     oldData.emailOtp = otp;
//     oldData.expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes expiry

//     tempStore.set(id, oldData);

//     await sendOtpToEmail(email, otp);

//     // 👇 Send OTP in response (for testing only)
//     return sendSuccessResponse(
//       res,
//       { secretId: id, otp },
//       successEn.OTP_SENT,
//       HttpStatus.OK
//     );

//   } catch (err) {
//     console.error("Error in sendEmailOtp:", err);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // 2. Verify Email OTP
// export const verifyEmailOtp = async (req, res) => {
//   try {
//     const { secretId, otp } = req.body;
//     const data = tempStore.get(secretId);

//     if (!data || data.emailOtp !== otp) {
//       return sendErrorResponse(res, errorEn.INVALID_OTP, HttpStatus.UNAUTHORIZED);
//     }

//     data.isEmailVerified = true;
//     tempStore.set(secretId, data);

//     return sendSuccessResponse(res, { secretId }, successEn.EMAIL_VERIFIED, HttpStatus.OK);
//   } catch (err) {
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // 3. Send Phone OTP
// export const sendPhoneOtp = async (req, res) => {
//   try {
//     const { phone, secretId } = req.body;
//     if (!phone) {
//       return sendErrorResponse(
//         res,
//         errorEn.ALL_FIELDS_REQUIRED,
//         HttpStatus.BAD_REQUEST
//       );
//     }

//     const otp = Math.floor(1000 + Math.random() * 9000).toString();
//     const id = secretId || uuidv4();

//     const oldData = tempStore.get(id) || {};
//     oldData.phone = phone;
//     oldData.phoneOtp = otp;
//     oldData.expiresAt = Date.now() + 10 * 60 * 1000;

//     tempStore.set(id, oldData);

//     await sendOtpToPhone(phone, otp);

//     return sendSuccessResponse(
//       res,
//       { secretId: id, otp },
//       successEn.OTP_SENT,
//       HttpStatus.OK
//     );
//   } catch (err) {
//     return sendErrorResponse(
//       res,
//       errorEn.INTERNAL_SERVER_ERROR,
//       HttpStatus.INTERNAL_SERVER_ERROR
//     );
//   }
// };

// // 4. Verify Phone OTP
// export const verifyPhoneOtp = async (req, res) => {
//   try {
//     const { secretId, otp } = req.body;
//     const data = tempStore.get(secretId);

//     if (!data || data.phoneOtp !== otp) {
//       return sendErrorResponse(res, errorEn.INVALID_OTP, HttpStatus.UNAUTHORIZED);
//     }

//     data.isPhoneVerified = true;
//     tempStore.set(secretId, data);

//     return sendSuccessResponse(res, { secretId }, successEn.PHONE_VERIFIED, HttpStatus.OK);
//   } catch (err) {
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // 5. Check Temp Registration Status
// export const checkTempRegistrationStatus = async (req, res) => {
//   try {
//     const { secretId } = req.body;

//     if (!secretId) {
//       return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
//     }

//     const tempData = tempStore.get(secretId);

//     if (!tempData) {
//       return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
//     }

//     return sendSuccessResponse(
//       res,
//       {
//         secretId,
//         email: tempData.email || null,
//         phone: tempData.phone || null,
//         isEmailVerified: tempData.isEmailVerified || false,
//         isPhoneVerified: tempData.isPhoneVerified || false
//       },
//       successEn.TEMP_STATUS_FETCHED,
//       HttpStatus.OK
//     );

//   } catch (err) {
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // 6. Create Account
// export const createAccount = async (req, res) => {
//   try {
//     const { secretId, name, password, confirmPassword, role } = req.body;
//     const data = tempStore.get(secretId);

//     if (!data?.isEmailVerified) {
//       return sendErrorResponse(res, errorEn.EMAIL_NOT_VERIFIED, HttpStatus.BAD_REQUEST);
//     }

//     if (!data?.isPhoneVerified) {
//       return sendErrorResponse(res, errorEn.PHONE_NOT_VERIFIED, HttpStatus.BAD_REQUEST);
//     }

//     if (password !== confirmPassword) {
//       return sendErrorResponse(res, errorEn.PASSWORD_NOT_MATCH, HttpStatus.BAD_REQUEST);
//     }

//     const email = data.email?.toLowerCase();
//     const phone = data.phone;

//     const existingUser = await authenticationModel.findOne({
//       $or: [{ email }, { phone }]
//     });

//     if (existingUser) {
//       return sendErrorResponse(res, errorEn.USER_ALREADY_REGISTERED(role), HttpStatus.CONFLICT);
//     }

//     const hashedPassword = await genPassword(password);

//     const savedUser = await authenticationModel.create({
//       name,
//       email,
//       phone,
//       password: hashedPassword,
//       role
//     });

//     tempStore.delete(secretId);

//     return sendSuccessResponse(res, {
//       userId: savedUser._id,
//       isEmailVerified: true,
//       isPhoneVerified: true
//     }, successEn.REGISTERED(role), HttpStatus.OK);

//   } catch (err) {
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // 7. Login
// export const login = async (req, res) => {
//   try {
//     const { emailOrPhone, password } = req.body;

//     if (!emailOrPhone || !password) {
//       return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
//     }

//     const input = emailOrPhone?.toLowerCase();

//     const user = await authenticationModel.findOne({
//       $or: [{ email: input }, { phone: emailOrPhone }]
//     });

//     if (user) {
//       const isMatch = await comparePass(password, user.password);
//       if (!isMatch) {
//         return sendErrorResponse(res, errorEn.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED);
//       }

//       const token = generateToken(user); 

//       return sendSuccessResponse(res, {
//         token,
//         userId: user._id,           // User id
//         name: user.name,
//         email: user.email,
//         phone: user.phone,
//         role: user.role,
//         profilePic: user.profilePic || "",
//         isActive: user.isActive,
//         lastLogin: user.lastLogin,
//         createdAt: user.createdAt,
//         updatedAt: user.updatedAt
//       }, successEn.LOGIN_SUCCESS, HttpStatus.OK);
//     }

//     return sendErrorResponse(res, errorEn.EMAIL_OR_PHONE_NOT_FOUND, HttpStatus.NOT_FOUND);
//   } catch (error) {
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };


// // ✅ Send OTP for Forget Password// 1️⃣ Send OTP for Forget Password
// export const sendOtpForgetPassword = async (req, res) => {
//   try {
//     let { emailOrPhone } = req.body;

//     if (!emailOrPhone) {
//       return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
//     }

//     if (emailOrPhone.includes('@')) {
//       emailOrPhone = emailOrPhone.toLowerCase();
//     }

//     const existingUser = await authenticationModel.findOne({
//       $or: [
//         { email: emailOrPhone },
//         { phone: emailOrPhone }
//       ]
//     });

//     if (!existingUser) {
//       return sendErrorResponse(res, errorEn.EMAIL_OR_PHONE_NOT_FOUND, HttpStatus.NOT_FOUND);
//     }

//     const otp = Math.floor(1000 + Math.random() * 9000).toString();
//     const secretId = uuidv4();

//     tempStore.set(secretId, {
//       userId: existingUser._id,
//       email: existingUser.email,
//       phone: existingUser.phone,
//       role: existingUser.role,
//       otp,
//       expiresAt: Date.now() + 10 * 60 * 1000
//     });

//     if (emailOrPhone.includes('@')) {
//       await sendOtpToEmail(existingUser.email, otp);
//     } else {
//       await sendOtpToPhone(existingUser.phone, otp);
//     }

//     // OTP ko response me include kar rahe hain
//     return sendSuccessResponse(
//       res,
//       { secretId, otp },
//       successEn.OTP_SENT,
//       HttpStatus.OK
//     );

//   } catch (error) {
//     console.error("Error in sendOtpForgetPassword:", error);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };


// // 2️⃣ Verify OTP
// export const verifyOtpForResetPassword = async (req, res) => {
//   try {
//     const { otp, secretId } = req.body;

//     if (!otp || !secretId) {
//       return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
//     }

//     const storedData = tempStore.get(secretId);
//     if (!storedData) {
//       return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
//     }

//     if (Date.now() > storedData.expiresAt) {
//       tempStore.delete(secretId);
//       return sendErrorResponse(res, errorEn.OTP_EXPIRED, HttpStatus.UNAUTHORIZED);
//     }

//     if (storedData.otp !== otp) {
//       return sendErrorResponse(res, errorEn.INVALID_OTP, HttpStatus.UNAUTHORIZED);
//     }

//     storedData.isOtpVerified = true;
//     tempStore.set(secretId, storedData);

//     return sendSuccessResponse(res, { secretId }, successEn.OTP_VERIFIED, HttpStatus.OK);

//   } catch (error) {
//     console.error("Error in verifyOtpForResetPassword:", error);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // 3️⃣ Reset Password
// export const forgetPassword = async (req, res) => {
//   try {
//     const { secretId, newPassword, confirmPassword } = req.body;

//     if (!secretId || !newPassword || !confirmPassword) {
//       return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
//     }

//     if (newPassword !== confirmPassword) {
//       return sendErrorResponse(res, errorEn.PASSWORD_NOT_MATCH, HttpStatus.BAD_REQUEST);
//     }

//     const storedData = tempStore.get(secretId);
//     if (!storedData) {
//       return sendErrorResponse(res, errorEn.INVALID_SECRET_ID, HttpStatus.BAD_REQUEST);
//     }

//     if (!storedData.isOtpVerified) {
//       return sendErrorResponse(res, errorEn.OTP_NOT_VERIFIED, HttpStatus.UNAUTHORIZED);
//     }

//     if (Date.now() > storedData.expiresAt) {
//       tempStore.delete(secretId);
//       return sendErrorResponse(res, errorEn.OTP_EXPIRED, HttpStatus.UNAUTHORIZED);
//     }

//     const user = await authenticationModel.findById(storedData.userId);
//     if (!user) {
//       return sendErrorResponse(res, errorEn.USER_NOT_FOUND, HttpStatus.NOT_FOUND);
//     }

//     user.password = await genPassword(newPassword);
//     await user.save();

//     tempStore.delete(secretId);

//     return sendSuccessResponse(
//       res,
//       {
//         email: user.email,
//         userId: user._id,
//         message: "Your password has been updated successfully."
//       },
//       successEn.PASSWORD_RESET_SUCCESS,
//       HttpStatus.OK
//     );

//   } catch (error) {
//     console.error("Error in forgetPassword:", error);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };