// models/Authentication/authentication.model.js
import mongoose from "mongoose";

const streamerProfileSchema = new mongoose.Schema({
  bio: {
    type: String,
    default: ""
  },
  expertise: [{
    type: String
  }],
  experienceYears: {
    type: Number,
    default: 0
  },
  experienceDescription: {
    type: String,
    default: ""
  },
  
  verificationStatus: {
    type: String,
    enum: ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"],
    default: "PENDING"
  },
  verificationRequestDate: {
    type: Date,
    default: null
  },
  verificationDate: {
    type: Date,
    default: null
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  suspensionReason: {
    type: String,
    default: ""
  },
  suspendedAt: {
    type: Date,
    default: null
  },
  suspensionEndsAt: {
    type: Date,
    default: null
  },
  
  qualifications: [{
    degree: String,
    institute: String,
    year: Number,
    certificateUrl: String
  }],
  certifications: [{
    name: String,
    issuer: String,
    issueDate: Date,
    expiryDate: Date,
    certificateUrl: String
  }],
  socialLinks: {
    youtube: { type: String, default: "" },
    linkedin: { type: String, default: "" },
    twitter: { type: String, default: "" },
    github: { type: String, default: "" },
    portfolio: { type: String, default: "" }
  },
  
  totalStreams: {
    type: Number,
    default: 0
  },
  totalStudents: {
    type: Number,
    default: 0
  },
  averageRating: {
    type: Number,
    default: 0
  },
  totalEarnings: {
    type: Number,
    default: 0
  },
  
  bankDetails: {
    accountName: { type: String, default: "" },
    accountNumber: { type: String, default: "" },
    ifscCode: { type: String, default: "" },
    bankName: { type: String, default: "" }
  },
  
  notificationPreferences: {
    emailNotifications: { type: Boolean, default: true },
    smsNotifications: { type: Boolean, default: false },
    streamReminders: { type: Boolean, default: true }
  }
}, { _id: false });

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    password: {
      type: String,
      required: true,
      minlength: 6
    },
    role: {
      type: String,
      enum: ["ADMIN", "STREAMER", "VIEWER"],
      default: "VIEWER"
    },
    
    streamerProfile: {
      type: streamerProfileSchema,
      default: null
    },
    
    profilePic: {
      type: String,
      default: ""
    },
    phone: {
      type: String,
      default: ""
    },
    isActive: {
      type: Boolean,
      default: true
    },
    lastLogin: {
      type: Date
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    
    resetPasswordToken: String,
    resetPasswordExpire: Date,
    
    isEmailVerified: {
      type: Boolean,
      default: false
    },
    emailVerificationToken: String,
    emailVerificationExpire: Date
  },
  { timestamps: true }
);

// Middleware to handle streamer profile - FIXED VERSION
userSchema.pre('save', function(next) {
  // Clear streamerProfile for non-STREAMER roles
  if (this.role !== 'STREAMER') {
    this.streamerProfile = null;
  } else {
    // Only for STREAMER role
    if (!this.streamerProfile) {
      this.streamerProfile = {
        verificationStatus: 'PENDING',
        verificationRequestDate: new Date()
      };
    } else if (this.streamerProfile.verificationStatus === 'SUSPENDED') {
      // Auto-reactivate if suspension period is over
      if (this.streamerProfile.suspensionEndsAt && new Date() > this.streamerProfile.suspensionEndsAt) {
        this.streamerProfile.verificationStatus = 'APPROVED';
        this.streamerProfile.suspensionReason = "";
        this.streamerProfile.suspendedAt = null;
        this.streamerProfile.suspensionEndsAt = null;
      }
    }
  }
  next();
});

// Method to check if streamer can login - FIXED VERSION
userSchema.methods.canStreamerLogin = function() {
  // Only for STREAMER role
  if (this.role !== 'STREAMER') {
    return false; // ADMIN और VIEWER के लिए false
  }
  
  // Ensure streamerProfile exists
  if (!this.streamerProfile) {
    return false;
  }
  
  // Check suspension
  if (this.streamerProfile.verificationStatus === 'SUSPENDED') {
    if (this.streamerProfile.suspensionEndsAt && new Date() > this.streamerProfile.suspensionEndsAt) {
      // Auto-reactivate
      this.streamerProfile.verificationStatus = 'APPROVED';
      this.streamerProfile.suspensionReason = "";
      this.streamerProfile.suspendedAt = null;
      this.streamerProfile.suspensionEndsAt = null;
      return true;
    }
    return false;
  }
  
  return this.streamerProfile.verificationStatus === 'APPROVED';
};

// New method to check if user can login (for all roles)
userSchema.methods.canLogin = function() {
  // Check basic active status
  if (!this.isActive) {
    return { canLogin: false, reason: "Account is deactivated" };
  }
  
  // Check email verification if required
  if (!this.isEmailVerified) {
    return { canLogin: false, reason: "Email not verified" };
  }
  
  // Role-specific checks
  if (this.role === "STREAMER") {
    if (!this.streamerProfile) {
      return { canLogin: false, reason: "Streamer profile not found" };
    }
    
    const canStreamerLogin = this.canStreamerLogin();
    if (!canStreamerLogin) {
      let reason = "";
      switch (this.streamerProfile.verificationStatus) {
        case "PENDING":
          reason = "Streamer account pending approval";
          break;
        case "REJECTED":
          reason = "Streamer application rejected";
          break;
        case "SUSPENDED":
          reason = `Streamer account suspended. Reason: ${this.streamerProfile.suspensionReason || "No reason provided"}`;
          break;
        default:
          reason = "Streamer account not approved";
      }
      return { canLogin: false, reason };
    }
  }
  
  // ADMIN and VIEWER can always login (if active and email verified)
  return { canLogin: true, reason: "" };
};

// Method to get user profile for response
userSchema.methods.getProfileForResponse = function() {
  const profile = {
    userId: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    profilePic: this.profilePic || "",
    phone: this.phone || "",
    isActive: this.isActive,
    isEmailVerified: this.isEmailVerified,
    lastLogin: this.lastLogin,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
  
  // Add streamer profile only for STREAMER role
  if (this.role === "STREAMER" && this.streamerProfile) {
    profile.streamerProfile = {
      verificationStatus: this.streamerProfile.verificationStatus,
      verificationDate: this.streamerProfile.verificationDate,
      verificationRequestDate: this.streamerProfile.verificationRequestDate,
      bio: this.streamerProfile.bio,
      expertise: this.streamerProfile.expertise || [],
      experienceYears: this.streamerProfile.experienceYears,
      averageRating: this.streamerProfile.averageRating,
      totalStreams: this.streamerProfile.totalStreams,
      totalStudents: this.streamerProfile.totalStudents,
      totalEarnings: this.streamerProfile.totalEarnings
    };
  }
  
  return profile;
};

// Static method to find by email with role check
userSchema.statics.findByEmail = async function(email, role = null) {
  const query = { email: email.toLowerCase() };
  if (role) {
    query.role = role;
  }
  return await this.findOne(query);
};

// Static method to create user with proper defaults
userSchema.statics.createUser = async function(userData) {
  const user = new this(userData);
  
  // Set streamerProfile for STREAMER role
  if (user.role === 'STREAMER' && !user.streamerProfile) {
    user.streamerProfile = {
      verificationStatus: 'PENDING',
      verificationRequestDate: new Date()
    };
  }
  
  return await user.save();
};

const authenticationModel = mongoose.model("User", userSchema);

export default authenticationModel;