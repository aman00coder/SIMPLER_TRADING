// import mongoose from "mongoose";
// import { ROLE_MAP } from "../../constant/role.js"; 

// const liveSessionSchema = new mongoose.Schema({
//     // 🔹 Session Owner / Streamer
//     streamerId: {
//         type: mongoose.Schema.Types.ObjectId,
//         ref: "User",
//         required: true
//     },
//         courseId: {
//         type: mongoose.Schema.Types.ObjectId,
//         ref: "Course",
//         required: false // initially optional, aap required bana sakte hain
//     },
//     streamerRole: {
//         type: Number,
//         enum: [ROLE_MAP.STREAMER],
//         default: ROLE_MAP.STREAMER
//     },
//     // 🔹 Session Info
//     sessionId: {
//         type: String,
//         required: true,
//         unique: true
//     },
//     roomCode: {
//         type: String,
//         required: true
//     },
//     title: {
//         type: String,
//         required: true
//     },
//     description: String,

//     // 🔹 Session Timing
//     scheduledStartTime: { type: Date }, 
//     actualStartTime: { type: Date },    
//     endTime: { type: Date },

//     // 🔹 Participants
//     participants: [{
//         type: mongoose.Schema.Types.ObjectId,
//         ref: "User"
//     }],
//     allowedUsers: [{
//         type: mongoose.Schema.Types.ObjectId,
//         ref: "User"
//     }],

//     // 🔹 Engagement
//     whiteboardData: [{ type: Object }],
//     whiteboardId: { type: mongoose.Schema.Types.ObjectId, ref: "Whiteboard" },
//     chatMessages: [{ type: mongoose.Schema.Types.ObjectId, ref: "ChatMessage" }],
//     recordingUrl: String,

//     // 🔹 Session Controls
//     maxParticipants: { type: Number, default: 100 },
//     isPrivate: { type: Boolean, default: false },
//     status: {
//         type: String,
//         enum: ["SCHEDULED", "ACTIVE", "PAUSED", "ENDED", "CANCELLED"],
//         default: "SCHEDULED"
//     },

//     // 🔹 Analytics / Monitoring
//     duration: { type: Number, default: 0 }, // total duration in minutes
//     totalJoins: { type: Number, default: 0 }, // total joins count
//     peakParticipants: { type: Number, default: 0 }, // max concurrent participants
//     feedback: [{ type: String }],
//     ratings: [{
//         userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
//         rating: { type: Number, min: 1, max: 5 },
//         comment: String
//     }],

//     // 🔹 Moderation
//     isRecordingEnabled: { type: Boolean, default: false },
//     isChatEnabled: { type: Boolean, default: true },
//     isWhiteboardEnabled: { type: Boolean, default: true },

//     // 🔹 🚀 Add this field for ban management
//     bannedParticipants: {
//         type: [mongoose.Schema.Types.ObjectId],
//         ref: "User",
//         default: []
//     }
// }, { timestamps: true });

// // ✅ OverwriteModelError fix
// export default mongoose.models.LiveSession || mongoose.model("LiveSession", liveSessionSchema);





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
        required: false // initially optional, aap required bana sakte hain
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
    
    // ✅ ADDED: Join link field
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
    recordingUrl: String,

    // 🔹 Session Controls
    maxParticipants: { type: Number, default: 100 },
    isPrivate: { type: Boolean, default: false },
    status: {
        type: String,
        enum: ["SCHEDULED", "ACTIVE", "PAUSED", "ENDED", "CANCELLED","LIVE"],
        default: "SCHEDULED"
    },

    // 🔹 Analytics / Monitoring
    duration: { type: Number, default: 0 }, // total duration in minutes
    totalJoins: { type: Number, default: 0 }, // total joins count
    peakParticipants: { type: Number, default: 0 }, // max concurrent participants
    feedback: [{ type: String }],
    ratings: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        rating: { type: Number, min: 1, max: 5 },
        comment: String
    }],

    // 🔹 Moderation
    isRecordingEnabled: { type: Boolean, default: false },
    isChatEnabled: { type: Boolean, default: true },
    isWhiteboardEnabled: { type: Boolean, default: true },

    // 🔹 🚀 Add this field for ban management
    bannedParticipants: {
        type: [mongoose.Schema.Types.ObjectId],
        ref: "User",
        default: []
    }
    
    // ❌ NO NEED TO ADD sessionType field - using courseId check instead
}, { timestamps: true });

// ✅ Indexes for better performance
liveSessionSchema.index({ sessionId: 1 });
liveSessionSchema.index({ courseId: 1 });
liveSessionSchema.index({ streamerId: 1 });
liveSessionSchema.index({ status: 1 });

// ✅ OverwriteModelError fix
export default mongoose.models.LiveSession || mongoose.model("LiveSession", liveSessionSchema);