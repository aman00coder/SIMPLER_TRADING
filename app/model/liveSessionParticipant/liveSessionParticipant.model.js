import mongoose from "mongoose";
import { ROLE_MAP } from "../../constant/role.js";

const liveSessionParticipantSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,  //
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // 🔹 Device / Socket
    socketId: { type: String, required: true },  // realtime socket mapping
    deviceSessionId: { type: String },           // multi-device support
    isActiveDevice: { type: Boolean, default: true },
    deviceInfo: { type: String },                // e.g. browser, OS
    ipAddress: { type: String },

    // 🔹 Role & Status
    role: {
      type: Number,
      enum: Object.values(ROLE_MAP),
      default: ROLE_MAP.VIEWER,
    },
    status: {
      type: String,
      enum: ["JOINED", "LEFT", "KICKED", "BANNED", "ACTIVE"], // ✅ ACTIVE added
      default: "JOINED",
    },
    actionBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // moderator/admin
    reason: { type: String }, // reason for kick/ban

    // 🔹 Timestamps
    joinedAt: { type: Date, default: Date.now },
    leftAt: { type: Date },
    lastActiveAt: { type: Date },
    durationConnected: { type: Number, default: 0 }, // in seconds

    // 🔹 Network Monitoring
    networkQuality: {
      type: String,
      enum: ["poor", "average", "good"],
    },
    latency: { type: Number }, // in ms
    jitter: { type: Number },  // extra: network jitter
    packetLoss: { type: Number }, // %

    // 🔹 Engagement Tracking
    micStatus: { type: Boolean, default: true },
    camStatus: { type: Boolean, default: true },
    handRaised: { type: Boolean, default: false },
    screenShareStatus: { type: Boolean, default: false },
    reactions: { type: [String], default: [] },
    chatMessagesCount: { type: Number, default: 0 },
    pollResponses: { type: [mongoose.Schema.Types.Mixed], default: [] },
    notesTaken: { type: Boolean, default: false },

    // 🔹 Activity Log (audit trail)
    activityLog: {
      type: [
        {
          type: { 
            type: String, 
            enum: [
              "join", "leave", "kick", "ban", "unban", // ✅ unban added
              "mic", "cam", "hand", "reaction", 
              "chat", "screenShare", "poll"
            ] 
          },
          value: { type: String }, // e.g. reaction emoji, poll answer
          timestamp: { type: Date, default: Date.now },
          actionBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // who triggered
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

export default mongoose.models.LiveSessionParticipant ||
  mongoose.model("LiveSessionParticipant", liveSessionParticipantSchema);
