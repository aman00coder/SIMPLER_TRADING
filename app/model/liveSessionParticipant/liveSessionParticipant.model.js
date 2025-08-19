import mongoose from "mongoose";
import { ROLE_MAP } from "../../constant/role.js"; 

const liveSessionParticipantSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,   
      ref: "LiveSession",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    socketId: {
      type: String,
      required: true,
    },

    role: {
      type: Number,
      enum: Object.values(ROLE_MAP),
      default: ROLE_MAP.VIEWER,
    },

    status: {
      type: String,
      enum: ["JOINED", "LEFT", "KICKED", "BANNED"],
      default: "JOINED",
    },

    joinedAt: {
      type: Date,
      default: Date.now,
    },
    leftAt: {
      type: Date,
    },

    deviceInfo: {
      type: String,
    },

    ipAddress: {
      type: String,
    },
  },
  { timestamps: true }
);

export default mongoose.models.LiveSessionParticipant ||
 mongoose.model("LiveSessionParticipant", liveSessionParticipantSchema);
