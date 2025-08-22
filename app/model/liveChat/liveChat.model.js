import mongoose from "mongoose";

const chatMessageSchema = new mongoose.Schema(
  {
    // 🔹 Sender
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // 🔹 Optional 1:1 receiver (future use)
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },

    // 🔹 Live session group chat
// chatMessage.model.js
    sessionId: {
      type: String,   // 👈 UUID string ke liye
      required: function () {
        return !this.receiverId;
      },
    },
    // 🔹 Message content
    message: { type: String },
    type: {
      type: String,
      enum: ["TEXT", "IMAGE", "VIDEO", "FILE", "AUDIO", "LINK", "LOCATION"],
      default: "TEXT",
    },
    fileUrl: { type: String }, // IMAGE/VIDEO/FILE/AUDIO
    location: {
      latitude: Number,
      longitude: Number,
    },

    // 🔹 Reply / Thread
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: "ChatMessage" },

    // 🔹 Reactions
    reactions: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        emoji: String,
      },
    ],

    seenBy: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        seenAt: { type: Date, default: Date.now },
      },
    ],

    // 🔹 Moderation
    isDeleted: { type: Boolean, default: false },
    isPinned: { type: Boolean, default: false },
    pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    isEdited: { type: Boolean, default: false },
    editedAt: { type: Date },
    moderatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // 🔹 Mentions (optional, future feature)
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    isEdited: {
      type: Boolean,
      default: false,
    },

    // 🔹 Ephemeral messages (optional)
    expiresAt: { type: Date },

    // 🔹 Forwarded / Shared messages
    forwardedFrom: { type: mongoose.Schema.Types.ObjectId, ref: "ChatMessage" },

    // 🔹 Metadata / Tags
    tags: [String],
    customData: { type: Object },
  },
  { timestamps: true }
);

export default mongoose.models.ChatMessage ||
  mongoose.model("ChatMessage", chatMessageSchema);
