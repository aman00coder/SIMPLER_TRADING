// model/liveSessions/liveeSession.model.js
import mongoose from "mongoose";
import { ROLE_MAP } from "../../constant/role.js";

const liveSessionSchema = new mongoose.Schema({
    // 🔹 Session Owner / Streamer
    streamerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    courseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Course",
        required: false
    },
    streamerRole: {
        type: Number,
        enum: [ROLE_MAP.STREAMER],
        default: ROLE_MAP.STREAMER
    },
    // 🔹 Session Info
    sessionId: {
        type: String,
        required: true,
        unique: true
    },
    roomCode: {
        type: String,
        required: true
    },
    title: {
        type: String,
        required: true
    },
    description: String,
    
    // Join link field
    joinLink: {
        type: String
    },

    // 🔹 Session Timing
    scheduledStartTime: { type: Date }, 
    actualStartTime: { type: Date },    
    endTime: { type: Date },

    // 🔹 Participants
    participants: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    }],
    allowedUsers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    }],

    // 🔹 Engagement
    whiteboardData: [{ type: Object }],
    whiteboardId: { type: mongoose.Schema.Types.ObjectId, ref: "Whiteboard" },
    chatMessages: [{ type: mongoose.Schema.Types.ObjectId, ref: "ChatMessage" }],

    // 🔹 Recordings array - UPDATED
    recordingUrl: [
        {
            fileUrl: {
                type: String,
                required: true
            },
            fileName: {
                type: String,
                required: true
            },
            fileType: {
                type: String,
                default: "video/mp4"
            },
            fileSize: {
                type: Number, // bytes mein
                default: 0
            },
            recordedAt: {
                type: Date,
                default: Date.now
            },
            duration: {
                type: Number, // seconds mein
                default: 0
            },
            recordedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User"
            },
            // New fields for better tracking
            s3Key: String, // S3 file key for deletion
            thumbnailUrl: String, // Recording thumbnail
            resolution: String, // e.g., "1920x1080"
            status: {
                type: String,
                enum: ["UPLOADING", "PROCESSING", "COMPLETED", "FAILED"],
                default: "COMPLETED"
            }
        }
    ],

    // 🔹 Session Controls
    maxParticipants: { type: Number, default: 100 },
    isPrivate: { type: Boolean, default: false },
    status: {
        type: String,
        enum: ["SCHEDULED", "ACTIVE", "PAUSED", "ENDED", "CANCELLED", "LIVE"],
        default: "SCHEDULED"
    },

    // 🔹 Analytics / Monitoring
    duration: { type: Number, default: 0 },
    totalJoins: { type: Number, default: 0 },
    peakParticipants: { type: Number, default: 0 },
    
    // Recording analytics
    totalRecordings: { type: Number, default: 0 },
    totalRecordingDuration: { type: Number, default: 0 }, // seconds
    
    feedback: [{ type: String }],
    ratings: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        rating: { type: Number, min: 1, max: 5 },
        comment: String
    }],

    // 🔹 Moderation
    isRecordingEnabled: { type: Boolean, default: true }, // Enable recording by default
    isChatEnabled: { type: Boolean, default: true },
    isWhiteboardEnabled: { type: Boolean, default: true },

    // 🔹 Ban management
    bannedParticipants: {
        type: [mongoose.Schema.Types.ObjectId],
        ref: "User",
        default: []
    },
    
    // Metadata
    metadata: {
        lastRecordingAt: Date,
        recordingCount: { type: Number, default: 0 }
    }
    
}, { timestamps: true });

// ✅ Virtual for easier access
liveSessionSchema.virtual('latestRecording').get(function() {
    if (this.recordingUrl && this.recordingUrl.length > 0) {
        return this.recordingUrl[this.recordingUrl.length - 1];
    }
    return null;
});

// ✅ Indexes for better performance
liveSessionSchema.index({ sessionId: 1 });
liveSessionSchema.index({ courseId: 1 });
liveSessionSchema.index({ streamerId: 1 });
liveSessionSchema.index({ status: 1 });
liveSessionSchema.index({ "metadata.lastRecordingAt": -1 });

export default mongoose.models.LiveSession || mongoose.model("LiveSession", liveSessionSchema);