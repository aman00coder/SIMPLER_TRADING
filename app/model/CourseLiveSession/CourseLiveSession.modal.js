// models/liveSessions/courseLiveSession.model.js
import mongoose from "mongoose";
import { ROLE_MAP } from "../../constant/role.js";

const courseLiveSessionSchema = new mongoose.Schema({
  // 🔹 Basic Session Info
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ""
  },
  
  // 🔹 Unique Identifiers
  sessionId: {
    type: String,
    required: true,
    unique: true
  },
  roomCode: {
    type: String,
    required: true,
    unique: true
  },
  
  // 🔹 Course Link (IMPORTANT)
  courseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Course",
    required: true
  },
  
  // 🔹 Streamer Info
  streamerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  
  // 🔹 Join Link (Course ke liye bhi yahi)
  joinLink: {
    type: String,
    required: true
  },
  
  // 🔹 Timing
  startTime: {
    type: Date,
    default: Date.now
  },
  endTime: {
    type: Date
  },
  duration: {
    type: Number, // minutes
    default: 60
  },
  
  // 🔹 Status
  status: {
    type: String,
    enum: ["SCHEDULED", "LIVE", "ENDED", "CANCELLED"],
    default: "LIVE"
  },
  
  // 🔹 Participants Count
  participantsCount: {
    type: Number,
    default: 0
  },
  maxParticipants: {
    type: Number,
    default: 100
  },
  
  // 🔹 Media Settings
  isRecording: {
    type: Boolean,
    default: false
  },
  recordingUrl: {
    type: String
  },
  
  // 🔹 Metadata
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes
courseLiveSessionSchema.index({ sessionId: 1 });
courseLiveSessionSchema.index({ courseId: 1 });
courseLiveSessionSchema.index({ streamerId: 1 });
courseLiveSessionSchema.index({ status: 1 });

export default mongoose.models.CourseLiveSession || 
  mongoose.model("CourseLiveSession", courseLiveSessionSchema);