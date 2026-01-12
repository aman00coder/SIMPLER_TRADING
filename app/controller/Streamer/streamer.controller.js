// // controller/Streamer/streamer.controller.js
// import HttpStatus from 'http-status-codes';
// import authenticationModel from '../../model/Authentication/authentication.model.js';
// import { sendSuccessResponse, sendErrorResponse } from '../../responses/responses.js';
// import { errorEn, successEn } from '../../responses/message.js';

// // ✅ Streamer requests verification (after filling profile)
// export const requestStreamerVerification = async (req, res) => {
//   try {
//     const userId = req.tokenData.userId;
//     const profileData = req.body;

//     const user = await authenticationModel.findById(userId);
    
//     if (!user) {
//       return sendErrorResponse(res, errorEn.USER_NOT_FOUND, HttpStatus.NOT_FOUND);
//     }

//     if (user.role !== 'STREAMER') {
//       return sendErrorResponse(res, 'Only users with STREAMER role can request verification', HttpStatus.FORBIDDEN);
//     }

//     // Initialize streamerProfile if not exists
//     if (!user.streamerProfile) {
//       user.streamerProfile = {};
//     }

//     // Update profile data
//     user.streamerProfile = {
//       ...user.streamerProfile.toObject(),
//       ...profileData,
//       verificationStatus: 'PENDING',
//       verificationRequestDate: new Date()
//     };

//     await user.save();

//     return sendSuccessResponse(
//       res, 
//       { 
//         verificationStatus: user.streamerProfile.verificationStatus,
//         message: 'Verification request submitted. Waiting for admin approval.' 
//       }, 
//       'Verification request submitted successfully', 
//       HttpStatus.OK
//     );
//   } catch (error) {
//     console.error("Error in requestStreamerVerification:", error);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // ✅ Streamer updates profile
// export const updateStreamerProfile = async (req, res) => {
//   try {
//     const userId = req.tokenData.userId;
//     const profileData = req.body;

//     // If admin is updating, allow all fields
//     const isAdmin = req.tokenData.role === 1;
    
//     if (!isAdmin) {
//       // Remove fields that cannot be updated by streamer
//       delete profileData.verificationStatus;
//       delete profileData.verificationDate;
//       delete profileData.verifiedBy;
//       delete profileData.suspendedAt;
//       delete profileData.suspensionEndsAt;
//     }

//     const user = await authenticationModel.findById(userId);
    
//     if (!user) {
//       return sendErrorResponse(res, errorEn.USER_NOT_FOUND, HttpStatus.NOT_FOUND);
//     }

//     if (user.role !== 'STREAMER') {
//       return sendErrorResponse(res, 'Only streamers can update profile', HttpStatus.FORBIDDEN);
//     }

//     if (!user.streamerProfile) {
//       user.streamerProfile = {};
//     }

//     user.streamerProfile = {
//       ...user.streamerProfile.toObject(),
//       ...profileData
//     };

//     await user.save();

//     return sendSuccessResponse(
//       res, 
//       { 
//         streamerProfile: {
//           bio: user.streamerProfile.bio,
//           expertise: user.streamerProfile.expertise,
//           experienceYears: user.streamerProfile.experienceYears,
//           experienceDescription: user.streamerProfile.experienceDescription,
//           verificationStatus: user.streamerProfile.verificationStatus,
//           qualifications: user.streamerProfile.qualifications,
//           certifications: user.streamerProfile.certifications,
//           socialLinks: user.streamerProfile.socialLinks
//         }
//       }, 
//       'Profile updated successfully', 
//       HttpStatus.OK
//     );
//   } catch (error) {
//     console.error("Error in updateStreamerProfile:", error);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // ✅ Get streamer profile
// export const getStreamerProfile = async (req, res) => {
//   try {
//     const userId = req.query.userId || req.tokenData.userId;
//     const isAdmin = req.tokenData.role === 1; // ADMIN can view any profile

//     let queryUserId = userId;
    
//     // If not admin and trying to access other's profile
//     if (!isAdmin && userId && userId !== req.tokenData.userId) {
//       return sendErrorResponse(res, 'You can only view your own profile', HttpStatus.FORBIDDEN);
//     }

//     const user = await authenticationModel.findById(queryUserId)
//       .select('-password -resetPasswordToken -resetPasswordExpire');
    
//     if (!user) {
//       return sendErrorResponse(res, errorEn.USER_NOT_FOUND, HttpStatus.NOT_FOUND);
//     }

//     if (user.role !== 'STREAMER') {
//       return sendErrorResponse(res, 'User is not a streamer', HttpStatus.BAD_REQUEST);
//     }

//     const responseData = {
//       user: {
//         _id: user._id,
//         name: user.name,
//         email: user.email,
//         role: user.role,
//         profilePic: user.profilePic,
//         phone: user.phone,
//         isActive: user.isActive,
//         createdAt: user.createdAt
//       }
//     };

//     // Add streamer profile if exists
//     if (user.streamerProfile) {
//       responseData.streamerProfile = {
//         bio: user.streamerProfile.bio,
//         expertise: user.streamerProfile.expertise,
//         experienceYears: user.streamerProfile.experienceYears,
//         experienceDescription: user.streamerProfile.experienceDescription,
//         verificationStatus: user.streamerProfile.verificationStatus,
//         verificationRequestDate: user.streamerProfile.verificationRequestDate,
//         verificationDate: user.streamerProfile.verificationDate,
//         suspensionReason: isAdmin ? user.streamerProfile.suspensionReason : undefined,
//         suspendedAt: isAdmin ? user.streamerProfile.suspendedAt : undefined,
//         suspensionEndsAt: isAdmin ? user.streamerProfile.suspensionEndsAt : undefined,
//         qualifications: user.streamerProfile.qualifications,
//         certifications: user.streamerProfile.certifications,
//         socialLinks: user.streamerProfile.socialLinks,
//         totalStreams: user.streamerProfile.totalStreams,
//         totalStudents: user.streamerProfile.totalStudents,
//         averageRating: user.streamerProfile.averageRating,
//         totalEarnings: user.streamerProfile.totalEarnings
//       };

//       // Add verifiedBy info if admin is viewing
//       if (isAdmin && user.streamerProfile.verifiedBy) {
//         const verifiedByUser = await authenticationModel.findById(user.streamerProfile.verifiedBy)
//           .select('name email');
//         responseData.streamerProfile.verifiedBy = verifiedByUser;
//       }
//     }

//     return sendSuccessResponse(
//       res, 
//       responseData, 
//       'Profile fetched successfully', 
//       HttpStatus.OK
//     );
//   } catch (error) {
//     console.error("Error in getStreamerProfile:", error);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };

// // ✅ Streamer dashboard stats
// export const getStreamerDashboard = async (req, res) => {
//   try {
//     const userId = req.tokenData.userId;

//     const user = await authenticationModel.findById(userId);
    
//     if (!user || user.role !== 'STREAMER') {
//       return sendErrorResponse(res, 'Only streamers can access dashboard', HttpStatus.FORBIDDEN);
//     }

//     // Check if streamer is approved
//     if (user.streamerProfile?.verificationStatus !== 'APPROVED') {
//       return sendSuccessResponse(
//         res,
//         {
//           message: 'Your account is pending approval. Please wait for admin verification.',
//           verificationStatus: user.streamerProfile?.verificationStatus || 'PENDING'
//         },
//         'Dashboard data',
//         HttpStatus.OK
//       );
//     }

//     const dashboardData = {
//       profile: {
//         name: user.name,
//         verificationStatus: user.streamerProfile?.verificationStatus || 'PENDING',
//         rating: user.streamerProfile?.averageRating || 0,
//         totalStudents: user.streamerProfile?.totalStudents || 0,
//         totalStreams: user.streamerProfile?.totalStreams || 0,
//         totalEarnings: user.streamerProfile?.totalEarnings || 0
//       },
//       quickStats: {
//         upcomingStreams: 0, // You'll need to populate this from your course/liveClass model
//         completedStreams: user.streamerProfile?.totalStreams || 0,
//         activeStudents: 0, // You'll need to calculate this
//         totalRevenue: user.streamerProfile?.totalEarnings || 0
//       },
//       recentActivity: [],
//       notifications: []
//     };

//     return sendSuccessResponse(
//       res, 
//       dashboardData, 
//       'Dashboard data fetched successfully', 
//       HttpStatus.OK
//     );
//   } catch (error) {
//     console.error("Error in getStreamerDashboard:", error);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };