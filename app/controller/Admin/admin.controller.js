// controller/Admin/admin.controller.js
import HttpStatus from 'http-status-codes';
import authenticationModel from '../../model/Authentication/authentication.model.js';
import { sendSuccessResponse, sendErrorResponse } from '../../responses/responses.js';
import { errorEn, successEn } from '../../responses/message.js';


// Controller for getting all streamers with complete profile data
export const getAllStreamers = async (req, res) => {
  try {
    const { 
      status, 
      search, 
      page = 1, 
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc' 
    } = req.query;

    const query = { role: 'STREAMER' };
    
    // Filter by verification status
    if (status && status !== 'ALL') {
      query['streamerProfile.verificationStatus'] = status;
    }
    
    // Search by name, email, expertise or experience description
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { 'streamerProfile.expertise': { $regex: search, $options: 'i' } },
        { 'streamerProfile.bio': { $regex: search, $options: 'i' } },
        { 'streamerProfile.experienceDescription': { $regex: search, $options: 'i' } }
      ];
    }

    const sortOptions = {};
    if (sortBy === 'verificationStatus') {
      sortOptions['streamerProfile.verificationStatus'] = sortOrder === 'desc' ? -1 : 1;
    } else if (sortBy === 'totalStudents') {
      sortOptions['streamerProfile.totalStudents'] = sortOrder === 'desc' ? -1 : 1;
    } else if (sortBy === 'totalStreams') {
      sortOptions['streamerProfile.totalStreams'] = sortOrder === 'desc' ? -1 : 1;
    } else if (sortBy === 'averageRating') {
      sortOptions['streamerProfile.averageRating'] = sortOrder === 'desc' ? -1 : 1;
    } else if (sortBy === 'experienceYears') {
      sortOptions['streamerProfile.experienceYears'] = sortOrder === 'desc' ? -1 : 1;
    } else {
      sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;
    }

    const streamers = await authenticationModel.find(query)
      .select('-password -resetPasswordToken -resetPasswordExpire -emailVerificationToken -emailVerificationExpire')
      .sort(sortOptions)
      .skip((page - 1) * parseInt(limit))
      .limit(parseInt(limit));

    // Format response with ALL streamer profile data
    const formattedStreamers = streamers.map(streamer => ({
      _id: streamer._id,
      name: streamer.name,
      email: streamer.email,
      profilePic: streamer.profilePic,
      phone: streamer.phone,
      isActive: streamer.isActive,
      isEmailVerified: streamer.isEmailVerified,
      lastLogin: streamer.lastLogin,
      createdAt: streamer.createdAt,
      updatedAt: streamer.updatedAt,
      streamerProfile: {
        // Basic Information
        bio: streamer.streamerProfile?.bio || "",
        expertise: streamer.streamerProfile?.expertise || [],
        experienceYears: streamer.streamerProfile?.experienceYears || 0,
        experienceDescription: streamer.streamerProfile?.experienceDescription || "",
        
        // Verification Information
        verificationStatus: streamer.streamerProfile?.verificationStatus || 'PENDING',
        verificationRequestDate: streamer.streamerProfile?.verificationRequestDate,
        verificationDate: streamer.streamerProfile?.verificationDate,
        verifiedBy: streamer.streamerProfile?.verifiedBy,
        suspensionReason: streamer.streamerProfile?.suspensionReason || "",
        suspendedAt: streamer.streamerProfile?.suspendedAt,
        suspensionEndsAt: streamer.streamerProfile?.suspensionEndsAt,
        
        // Qualifications & Certifications
        qualifications: streamer.streamerProfile?.qualifications || [],
        certifications: streamer.streamerProfile?.certifications || [],
        
        // Social Links
        socialLinks: streamer.streamerProfile?.socialLinks || {
          youtube: "",
          linkedin: "",
          twitter: "",
          github: "",
          portfolio: ""
        },
        
        // Statistics
        totalStreams: streamer.streamerProfile?.totalStreams || 0,
        totalStudents: streamer.streamerProfile?.totalStudents || 0,
        averageRating: streamer.streamerProfile?.averageRating || 0,
        totalEarnings: streamer.streamerProfile?.totalEarnings || 0,
        
        // Bank Details (Admin ko dikhane ke liye)
        bankDetails: streamer.streamerProfile?.bankDetails || {
          accountName: "",
          accountNumber: "",
          ifscCode: "",
          bankName: ""
        },
        
        // Notification Preferences
        notificationPreferences: streamer.streamerProfile?.notificationPreferences || {
          emailNotifications: true,
          smsNotifications: false,
          streamReminders: true
        }
      }
    }));

    const total = await authenticationModel.countDocuments(query);

    return sendSuccessResponse(
      res, 
      {
        streamers: formattedStreamers,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }, 
      'Streamers fetched successfully', 
      HttpStatus.OK
    );
  } catch (error) {
    console.error("Error in getAllStreamers:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// Additional endpoint to get single streamer with complete details (for admin)
export const getStreamerById = async (req, res) => {
  try {
    const { id } = req.params;

    const streamer = await authenticationModel.findOne({
      _id: id,
      role: 'STREAMER'
    }).select('-password -resetPasswordToken -resetPasswordExpire -emailVerificationToken -emailVerificationExpire');

    if (!streamer) {
      return sendErrorResponse(res, "Streamer not found", HttpStatus.NOT_FOUND);
    }

    // Format response with ALL streamer profile data
    const formattedStreamer = {
      _id: streamer._id,
      name: streamer.name,
      email: streamer.email,
      profilePic: streamer.profilePic,
      phone: streamer.phone,
      isActive: streamer.isActive,
      isEmailVerified: streamer.isEmailVerified,
      lastLogin: streamer.lastLogin,
      createdAt: streamer.createdAt,
      updatedAt: streamer.updatedAt,
      streamerProfile: {
        // Basic Information
        bio: streamer.streamerProfile?.bio || "",
        expertise: streamer.streamerProfile?.expertise || [],
        experienceYears: streamer.streamerProfile?.experienceYears || 0,
        experienceDescription: streamer.streamerProfile?.experienceDescription || "",
        
        // Verification Information
        verificationStatus: streamer.streamerProfile?.verificationStatus || 'PENDING',
        verificationRequestDate: streamer.streamerProfile?.verificationRequestDate,
        verificationDate: streamer.streamerProfile?.verificationDate,
        verifiedBy: streamer.streamerProfile?.verifiedBy,
        suspensionReason: streamer.streamerProfile?.suspensionReason || "",
        suspendedAt: streamer.streamerProfile?.suspendedAt,
        suspensionEndsAt: streamer.streamerProfile?.suspensionEndsAt,
        
        // Qualifications & Certifications
        qualifications: streamer.streamerProfile?.qualifications || [],
        certifications: streamer.streamerProfile?.certifications || [],
        
        // Social Links
        socialLinks: streamer.streamerProfile?.socialLinks || {
          youtube: "",
          linkedin: "",
          twitter: "",
          github: "",
          portfolio: ""
        },
        
        // Statistics
        totalStreams: streamer.streamerProfile?.totalStreams || 0,
        totalStudents: streamer.streamerProfile?.totalStudents || 0,
        averageRating: streamer.streamerProfile?.averageRating || 0,
        totalEarnings: streamer.streamerProfile?.totalEarnings || 0,
        
        // Bank Details
        bankDetails: streamer.streamerProfile?.bankDetails || {
          accountName: "",
          accountNumber: "",
          ifscCode: "",
          bankName: ""
        },
        
        // Notification Preferences
        notificationPreferences: streamer.streamerProfile?.notificationPreferences || {
          emailNotifications: true,
          smsNotifications: false,
          streamReminders: true
        }
      }
    };

    return sendSuccessResponse(
      res, 
      formattedStreamer, 
      'Streamer details fetched successfully', 
      HttpStatus.OK
    );
  } catch (error) {
    console.error("Error in getStreamerById:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Approve streamer
export const approveStreamer = async (req, res) => {
  try {
    const { streamerId } = req.params;
    const adminId = req.tokenData.userId;

    const streamer = await authenticationModel.findById(streamerId);
    
    if (!streamer || streamer.role !== 'STREAMER') {
      return sendErrorResponse(res, 'Streamer not found', HttpStatus.NOT_FOUND);
    }

    if (!streamer.streamerProfile) {
      streamer.streamerProfile = {};
    }

    // Check if already approved
    if (streamer.streamerProfile.verificationStatus === 'APPROVED') {
      return sendErrorResponse(res, 'Streamer is already approved', HttpStatus.BAD_REQUEST);
    }

    streamer.streamerProfile.verificationStatus = 'APPROVED';
    streamer.streamerProfile.verificationDate = new Date();
    streamer.streamerProfile.verifiedBy = adminId;
    streamer.streamerProfile.suspensionReason = "";
    streamer.streamerProfile.suspendedAt = null;
    streamer.streamerProfile.suspensionEndsAt = null;
    
    await streamer.save();

    return sendSuccessResponse(
      res, 
      { 
        message: 'Streamer approved successfully',
        streamer: {
          id: streamer._id,
          name: streamer.name,
          email: streamer.email,
          verificationStatus: streamer.streamerProfile.verificationStatus
        }
      }, 
      'Streamer approved', 
      HttpStatus.OK
    );
  } catch (error) {
    console.error("Error in approveStreamer:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Suspend streamer
export const suspendStreamer = async (req, res) => {
  try {
    const { streamerId } = req.params;
    const { reason, suspensionDays } = req.body;
    const adminId = req.tokenData.userId;

    if (!reason) {
      return sendErrorResponse(res, 'Suspension reason is required', HttpStatus.BAD_REQUEST);
    }

    const streamer = await authenticationModel.findById(streamerId);
    
    if (!streamer || streamer.role !== 'STREAMER') {
      return sendErrorResponse(res, 'Streamer not found', HttpStatus.NOT_FOUND);
    }

    if (!streamer.streamerProfile) {
      streamer.streamerProfile = {};
    }

    streamer.streamerProfile.verificationStatus = 'SUSPENDED';
    streamer.streamerProfile.suspendedAt = new Date();
    streamer.streamerProfile.suspensionReason = reason;
    streamer.streamerProfile.verifiedBy = adminId;
    
    if (suspensionDays) {
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + parseInt(suspensionDays));
      streamer.streamerProfile.suspensionEndsAt = endDate;
    } else {
      // If no suspension days, set to 7 days default
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 7);
      streamer.streamerProfile.suspensionEndsAt = endDate;
    }
    
    await streamer.save();

    return sendSuccessResponse(
      res, 
      { 
        message: 'Streamer suspended successfully',
        streamer: {
          id: streamer._id,
          name: streamer.name,
          email: streamer.email,
          verificationStatus: streamer.streamerProfile.verificationStatus,
          suspensionEndsAt: streamer.streamerProfile.suspensionEndsAt,
          suspensionReason: streamer.streamerProfile.suspensionReason
        }
      }, 
      'Streamer suspended', 
      HttpStatus.OK
    );
  } catch (error) {
    console.error("Error in suspendStreamer:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Get streamer statistics (admin)
export const getStreamerStats = async (req, res) => {
  try {
    const stats = await authenticationModel.aggregate([
      { $match: { role: 'STREAMER' } },
      {
        $group: {
          _id: '$streamerProfile.verificationStatus',
          count: { $sum: 1 },
          totalStreams: { $sum: { $ifNull: ['$streamerProfile.totalStreams', 0] } },
          totalStudents: { $sum: { $ifNull: ['$streamerProfile.totalStudents', 0] } },
          totalEarnings: { $sum: { $ifNull: ['$streamerProfile.totalEarnings', 0] } },
          avgRating: { $avg: { $ifNull: ['$streamerProfile.averageRating', 0] } }
        }
      }
    ]);

    const totalStreamers = await authenticationModel.countDocuments({ role: 'STREAMER' });
    
    // Calculate counts
    const pendingCount = stats.find(s => s._id === 'PENDING')?.count || 0;
    const approvedCount = stats.find(s => s._id === 'APPROVED')?.count || 0;
    const suspendedCount = stats.find(s => s._id === 'SUSPENDED')?.count || 0;
    const rejectedCount = stats.find(s => s._id === 'REJECTED')?.count || 0;

    // Calculate totals
    const totalStreams = stats.reduce((sum, stat) => sum + (stat.totalStreams || 0), 0);
    const totalStudents = stats.reduce((sum, stat) => sum + (stat.totalStudents || 0), 0);
    const totalEarnings = stats.reduce((sum, stat) => sum + (stat.totalEarnings || 0), 0);

    return sendSuccessResponse(
      res, 
      {
        totals: {
          totalStreamers,
          totalStreams,
          totalStudents,
          totalEarnings
        },
        statusBreakdown: {
          pending: pendingCount,
          approved: approvedCount,
          suspended: suspendedCount,
          rejected: rejectedCount
        },
        details: stats
      }, 
      'Streamer statistics fetched', 
      HttpStatus.OK
    );
  } catch (error) {
    console.error("Error in getStreamerStats:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Reactivate streamer (remove suspension)
export const reactivateStreamer = async (req, res) => {
  try {
    const { streamerId } = req.params;
    const adminId = req.tokenData.userId;

    const streamer = await authenticationModel.findById(streamerId);
    
    if (!streamer || streamer.role !== 'STREAMER') {
      return sendErrorResponse(res, 'Streamer not found', HttpStatus.NOT_FOUND);
    }

    if (!streamer.streamerProfile) {
      streamer.streamerProfile = {};
    }

    if (streamer.streamerProfile.verificationStatus !== 'SUSPENDED') {
      return sendErrorResponse(res, 'Streamer is not suspended', HttpStatus.BAD_REQUEST);
    }

    streamer.streamerProfile.verificationStatus = 'APPROVED';
    streamer.streamerProfile.suspensionReason = "";
    streamer.streamerProfile.suspendedAt = null;
    streamer.streamerProfile.suspensionEndsAt = null;
    streamer.streamerProfile.verifiedBy = adminId;
    
    await streamer.save();

    return sendSuccessResponse(
      res, 
      { 
        message: 'Streamer reactivated successfully',
        streamer: {
          id: streamer._id,
          name: streamer.name,
          email: streamer.email,
          verificationStatus: streamer.streamerProfile.verificationStatus
        }
      }, 
      'Streamer reactivated', 
      HttpStatus.OK
    );
  } catch (error) {
    console.error("Error in reactivateStreamer:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};




