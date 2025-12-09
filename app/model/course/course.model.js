// models/course/course.model.js
import mongoose from "mongoose";

const liveClassSchema = new mongoose.Schema(
  {
    sessionId: { 
      type: String, 
      required: true 
    },
    sessionTitle: { 
      type: String, 
      required: true 
    },
    description: {
      type: String,
      default: ""
    },
    joinLink: { 
      type: String, 
      required: true
    },
    roomCode: { 
      type: String, 
      required: true 
    },
    scheduleAt: { 
      type: Date, 
      default: Date.now 
    },
    startTime: {
      type: Date
    },
    endTime: {
      type: Date
    },
    duration: { 
      type: Number,
      default: 60 
    },
    mentor: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User",
      required: true 
    },
    mentorName: {
      type: String
    },
    status: { 
      type: String, 
      enum: ["SCHEDULED", "LIVE", "ENDED", "CANCELLED"],
      default: "LIVE" 
    },
    currentParticipants: {
      type: Number,
      default: 0
    },
    maxParticipants: {
      type: Number,
      default: 100
    },
    isPrivate: {
      type: Boolean,
      default: false
    },
    recordingUrl: {
      type: String
    },
    thumbnail: {
      type: String
    },
    chatEnabled: {
      type: Boolean,
      default: true
    },
    whiteboardEnabled: {
      type: Boolean,
      default: true
    },
    // 🔹 Timestamps
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  },
  { _id: true }
);

const courseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      required: true
    },
    thumbnail: {
      type: String
    },
    category: {
      type: String,
      required: true
    },
    tags: [{ type: String }],

    level: {
      type: String,
      enum: ["Beginner", "Intermediate", "Advanced"],
      default: "Beginner"
    },  

    price: {
      type: Number,
      default: 0
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    language: {
      type: String,
      default: "English"
    },

    duration: { 
      type: Number, 
      default: 0
    },

    rating: {
      type: Number,
      default: 0
    },

    enrolledUsers: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        enrolledAt: { type: Date, default: Date.now },
        progress: { type: Number, default: 0 }, // percentage
        completedLectures: [{ type: mongoose.Schema.Types.ObjectId }],
        lastAccessed: { type: Date }
      }
    ],

    isActive: {
      type: Boolean,
      default: true
    },

    lectures: [
      {
        title: { type: String, required: true },
        type: { type: String, enum: ["video", "pdf", "ppt", "note"], default: "video" },
        url: { type: String },
        duration: { type: Number },
        isPreviewFree: { type: Boolean, default: false }
      }
    ],

    // ✅ UPDATED: Live Classes with validation middleware
    liveClasses: [liveClassSchema],

    quizzes: [
      {
        question: { type: String },
        options: [{ type: String }],
        correctAnswer: { type: String },
        explanation: { type: String }
      }
    ],

    assignments: [
      {
        title: { type: String },
        description: { type: String },
        dueDate: { type: Date },
        resources: [{ type: String }]
      }
    ]
  },
  { timestamps: true }
);

// ✅ Middleware to clean invalid liveClasses before validation
courseSchema.pre('validate', function(next) {
  if (this.liveClasses && Array.isArray(this.liveClasses)) {
    // Filter out invalid liveClasses that are missing required fields
    this.liveClasses = this.liveClasses.filter(liveClass => {
      // Check if liveClass exists and has required fields
      if (!liveClass) return false;
      
      // Check for required fields
      const hasRequiredFields = 
        liveClass.sessionId && 
        liveClass.sessionTitle && 
        liveClass.joinLink && 
        liveClass.roomCode &&
        liveClass.mentor;
      
      // Only keep if all required fields are present
      return hasRequiredFields;
    });
  }
  next();
});

// ✅ Middleware to clean invalid liveClasses before saving
courseSchema.pre('save', function(next) {
  if (this.liveClasses && Array.isArray(this.liveClasses)) {
    // Ensure each liveClass has updatedAt set
    this.liveClasses = this.liveClasses.map(liveClass => {
      if (liveClass && liveClass._id) {
        return {
          ...liveClass,
          updatedAt: new Date()
        };
      }
      return liveClass;
    }).filter(liveClass => liveClass !== null);
  }
  next();
});

// ✅ Static method to clean invalid liveClasses in existing documents
courseSchema.statics.cleanInvalidLiveClasses = async function() {
  try {
    const courses = await this.find({});
    let cleanedCount = 0;
    
    for (const course of courses) {
      if (course.liveClasses && Array.isArray(course.liveClasses)) {
        const originalLength = course.liveClasses.length;
        
        // Filter invalid liveClasses
        course.liveClasses = course.liveClasses.filter(liveClass => {
          if (!liveClass) return false;
          
          const hasRequiredFields = 
            liveClass.sessionId && 
            liveClass.sessionTitle && 
            liveClass.joinLink && 
            liveClass.roomCode &&
            liveClass.mentor;
          
          return hasRequiredFields;
        });
        
        if (course.liveClasses.length !== originalLength) {
          await course.save({ validateBeforeSave: false });
          cleanedCount++;
          console.log(`Cleaned course: ${course._id}, removed ${originalLength - course.liveClasses.length} invalid liveClasses`);
        }
      }
    }
    
    console.log(`✅ Cleaned ${cleanedCount} courses with invalid liveClasses`);
    return cleanedCount;
  } catch (error) {
    console.error("❌ Error cleaning invalid liveClasses:", error);
    throw error;
  }
};

// ✅ Method to safely add a liveClass with validation
courseSchema.methods.addLiveClass = function(liveClassData) {
  // Validate required fields
  const requiredFields = ['sessionId', 'sessionTitle', 'joinLink', 'roomCode', 'mentor'];
  const missingFields = requiredFields.filter(field => !liveClassData[field]);
  
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields for liveClass: ${missingFields.join(', ')}`);
  }
  
  // Add timestamps
  const now = new Date();
  const liveClassWithTimestamps = {
    ...liveClassData,
    createdAt: now,
    updatedAt: now,
    scheduleAt: liveClassData.scheduleAt || now
  };
  
  this.liveClasses.push(liveClassWithTimestamps);
  return this;
};

// Index for better performance
courseSchema.index({ "liveClasses.sessionId": 1 }, { sparse: true });
courseSchema.index({ "liveClasses.mentor": 1 }, { sparse: true });
courseSchema.index({ "liveClasses.status": 1 }, { sparse: true });
courseSchema.index({ "liveClasses.scheduleAt": 1 }, { sparse: true });

const Course = mongoose.model("Course", courseSchema);

// ✅ Run cleanup on startup (optional)
Course.cleanInvalidLiveClasses().catch(err => {
  console.error("Failed to clean invalid liveClasses on startup:", err);
});

export default Course;