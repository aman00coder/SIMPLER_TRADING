import mongoose from "mongoose";

const whiteboardSchema = new mongoose.Schema(
  {
    // Basic info
    whiteboardId: { type: String, unique: true, index: true }, 
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    createdByRole: { type: Number, required: true }, 
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    participants: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        role: { type: String, enum: ["owner", "editor", "viewer"], default: "editor" },
        joinedAt: { type: Date, default: Date.now },
        lastActive: { type: Date, default: Date.now },
        cursorPosition: { type: mongoose.Schema.Types.Mixed, default: {} }
      }
    ],

    canvasData: { type: mongoose.Schema.Types.Mixed, default: {} },

    liveStream: {
      isLive: { type: Boolean, default: false },
      streamId: { type: String, default: null },
      streamUrl: { type: String, default: null },
      startTime: { type: Date },
      endTime: { type: Date }
    },

    chatHistory: [
      {
        sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        message: String,
        timestamp: { type: Date, default: Date.now }
      }
    ],

    files: [
      {
        fileName: String,
        fileUrl: String,
        fileType: { type: String, default: null },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        uploadedAt: { type: Date, default: Date.now }
      }
    ],

    versionHistory: [
      {
        data: mongoose.Schema.Types.Mixed,
        updatedAt: { type: Date, default: Date.now },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
      }
    ],

    isActive: { type: Boolean, default: true },
    isDeleted : {type: Boolean, default: false},
    isPublic: { type: Boolean, default: false },
    accessType: { type: String, enum: ["public", "private", "restricted"], default: "private" },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    clonedFrom: { type: mongoose.Schema.Types.ObjectId, ref: "Whiteboard", default: null },

    passwordProtected: { type: Boolean, default: false },
    boardPassword: { type: String, default: null },
    whiteboardPassword: { type: String, default: null },
    maxParticipants: { type: Number, default: 20 },

    whiteboardUrl: [
      {
        fileName: String,
        fileUrl: String,
        fileType: String,
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        uploadedAt: { type: Date, default: Date.now }
      }
    ],

    whiteboardType: { type: String, default: null },
    whiteboardSubType: { type: String, default: null },

    lastActivity: { type: Date, default: Date.now },
    totalEdits: { type: Number, default: 0 },
    totalMessages: { type: Number, default: 0 },
    tags: { type: [String], default: [] },

    // CHANGE HERE: recordingUrl from String to Array of files
    recordingUrl: [
      {
        fileName: String,
        fileUrl: String,
        fileType: String,
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        uploadedAt: { type: Date, default: Date.now }
      }
    ],

    isArchived: { type: Boolean, default: false },

    currentSessionId: { type: String, default: null },
    activeUsersCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

const whiteboardModel =
  mongoose.models.Whiteboard || mongoose.model("Whiteboard", whiteboardSchema);

export default whiteboardModel;
