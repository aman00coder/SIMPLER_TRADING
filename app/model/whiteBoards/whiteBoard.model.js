// import mongoose from "mongoose";

// const whiteboardSchema = new mongoose.Schema(
//   {
//     // Basic info
//     whiteboardId: { type: String, unique: true, index: true },
//     title: { type: String, required: true, trim: true },
//     description: { type: String, default: "" },
//     createdByRole: { type: Number, required: true },
//     createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

//     participants: [
//       {
//         user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
//         role: { type: String, enum: ["owner", "editor", "viewer"], default: "editor" },
//         joinedAt: { type: Date, default: Date.now },
//         lastActive: { type: Date, default: Date.now },
//         cursorPosition: { type: mongoose.Schema.Types.Mixed, default: {} }
//       }
//     ],

//     canvasData: { type: mongoose.Schema.Types.Mixed, default: {} },

//     liveStream: {
//       isLive: { type: Boolean, default: false },
//       streamId: { type: String, default: null },
//       streamUrl: { type: String, default: null },
//       startTime: { type: Date },
//       endTime: { type: Date }
//     },

//     chatHistory: [
//       {
//         sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
//         message: String,
//         timestamp: { type: Date, default: Date.now }
//       }
//     ],

//     files: [
//       {
//         fileName: String,
//         fileUrl: String,
//         fileType: { type: String, default: null },
//         uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
//         uploadedAt: { type: Date, default: Date.now }
//       }
//     ],

//     versionHistory: [
//       {
//         data: mongoose.Schema.Types.Mixed,
//         updatedAt: { type: Date, default: Date.now },
//         updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
//       }
//     ],

//     isActive: { type: Boolean, default: true },
//     isDeleted : {type: Boolean, default: false},
//     isPublic: { type: Boolean, default: false },
//     accessType: { type: String, enum: ["public", "private", "restricted"], default: "private" },
//     status: { type: String, enum: ["active", "archived"], default: "active" },
//     clonedFrom: { type: mongoose.Schema.Types.ObjectId, ref: "Whiteboard", default: null },

//     passwordProtected: { type: Boolean, default: false },
//     boardPassword: { type: String, default: null },
//     whiteboardPassword: { type: String, default: null },
//     maxParticipants: { type: Number, default: 20 },

//     whiteboardUrl: [
//       {
//         fileName: String,
//         fileUrl: String,
//         fileType: String,
//         uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
//         uploadedAt: { type: Date, default: Date.now }
//       }
//     ],

//     whiteboardType: { type: String, default: null },
//     whiteboardSubType: { type: String, default: null },

//     lastActivity: { type: Date, default: Date.now },
//     totalEdits: { type: Number, default: 0 },
//     totalMessages: { type: Number, default: 0 },
//     tags: { type: [String], default: [] },

//     // CHANGE HERE: recordingUrl from String to Array of files
//     recordingUrl: [
//       {
//         fileName: String,
//         fileUrl: String,
//         fileType: String,
//         uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
//         uploadedAt: { type: Date, default: Date.now }
//       }
//     ],

//     isArchived: { type: Boolean, default: false },

//     currentSessionId: { type: String, default: null },
//     activeUsersCount: { type: Number, default: 0 }
//   },
//   { timestamps: true }
// );

// const whiteboardModel =
//   mongoose.models.Whiteboard || mongoose.model("Whiteboard", whiteboardSchema);

// export default whiteboardModel;



import mongoose from "mongoose";

const whiteboardSchema = new mongoose.Schema(
  {
    // Basic info
    whiteboardId: {
      type: String,
      unique: true,
      index: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      default: ""
    },
    createdByRole: {
      type: Number,
      required: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    // 🔹 Har whiteboard ek hi LiveSession ke saath linked hoga
    liveSessionId: {
      type: String, // ObjectId => String
      required: true,
    },
    // Participants & permissions
    participants: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User"
        },
        role: {
          type: String,
          enum: ["owner", "editor", "viewer"],
          default: "editor"
        },
        joinedAt: {
          type: Date,
          default: Date.now
        },
        lastActive: {
          type: Date,
          default: Date.now
        },
        cursorPosition: {
          type: mongoose.Schema.Types.Mixed,
          default: {}
        },
        canDraw: {
          type: Boolean,
          default: true
        },
        canErase: {
          type: Boolean,
          default: true
        },
        canUploadFiles: {
          type: Boolean,
          default: true
        },
        canRecord: {
          type: Boolean,
          default: true
        }
      }
    ],

    // Canvas & drawing tools
    canvasData: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    toolSettings: {
      color: {
        type: String,
        default: "#000000"
      },
      thickness: {
        type: Number,
        default: 2
      },
      shape: {
        type: String,
        default: "pen"
      },
      opacity: {
        type: Number,
        default: 1
      }
    },
    selectedTool: {
      type: String,
      default: "pen"
    },
    layers: [
      {
        layerId: String,
        name: String,
        isVisible: {
          type: Boolean,
          default: true
        },
        zIndex: {
          type: Number,
          default: 0
        }
      }
    ],

    // Undo / Redo
    undoStack: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },
    redoStack: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },

    // Live streaming
    liveStream: {
      isLive: {
        type: Boolean,
        default: false
      },
      streamId: {
        type: String,
        default: null
      },
      streamUrl: {
        type: String,
        default: null
      },
      startTime: {
        type: Date
      },
      endTime: {
        type: Date
      },
      activeMentors: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      activeEditors: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
    },

    // Chat & collaboration
    chatHistory: [
      {
        sender: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User"
        },
        message: String,
        timestamp: {
          type: Date,
          default: Date.now
        },
        isEdited: {
          type: Boolean,
          default: false
        }
      }
    ],
    typingStatus: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User"
        },
        isTyping: {
          type: Boolean,
          default: false
        },
        lastUpdated: { 
          type: Date,
          default: Date.now
        }
      }
    ],
    cursorHistory: [
      { userId: mongoose.Schema.Types.ObjectId, position: mongoose.Schema.Types.Mixed, timestamp: Date }
    ],

    // Files & attachments
    files: [
      {
        fileName: String,
        fileUrl: String,
        fileType: {
          type: String,
          default: null
        },
        uploadedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User"
        },
        uploadedAt: {
          type: Date,
          default: Date.now
        }
      }
    ],

    // Versioning & history
    versionHistory: [
      {
        data: mongoose.Schema.Types.Mixed,
        updatedAt: {
          type: Date,
          default: Date.now
        },
        updatedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User"
        },
        versionTag: {
          type: String,
          default: null
        }
      }
    ],
    versionTags: {
      type: [String],
      default: []
    },

    // Security & access
    isActive: {
      type: Boolean,
      default: true
    },
    isDeleted: {
      type: Boolean,
      default: false
    },
    isPublic: {
      type: Boolean,
      default: false
    },
    accessType: {
      type: String,
      enum: ["public", "private", "restricted"],
      default: "private"
    },
    status: {
      type: String,
      enum: ["active", "archived"],
      default: "active"
    },
    clonedFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Whiteboard",
      default: null
    },
    passwordProtected: {
      type: Boolean,
      default: false
    },
    boardPassword: {
      type: String,
      default: null
    },
    whiteboardPassword: {
      type: String,
      default: null
    },
    maxParticipants: {
      type: Number,
      default: 20
    },
    accessLogs: [{ userId: mongoose.Schema.Types.ObjectId, action: String, timestamp: Date }],

    // Recordings & replay
    recordingUrl: [
      {
        fileName: String,
        fileUrl: String,
        fileType: String,
        uploadedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User"
        },
        uploadedAt: {
          type: Date,
          default: Date.now
        },
        duration: {
          type: Number,
          default: 0
        },
        resolution: {
          type: String,
          default: null
        },
        format: {
          type: String,
          default: null
        }
      }
    ],
    replayAvailable: {
      type: Boolean,
      default: false
    },
    replayData: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },

    // Metadata
    whiteboardUrl: [
      {
        fileName: String,
        fileUrl: String,
        fileType: String,
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        uploadedAt: { type: Date, default: Date.now }
      }
    ],
    whiteboardType: {
      type: String,
      default: null
    },
    whiteboardSubType: {
      type: String,
      default: null
    },
    category: {
      type: String,
      default: null
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      default: null
    },

    // ⚠️ linkedSessionIds hata diya (Case 2 ke liye zarurat nahi)
    // linkedSessionIds: [{ type: String }],

    favoriteBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    tagsDetailed: [{ tag: String, createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" } }],

    // Analytics
    lastActivity: {
      type: Date,
      default: Date.now
    },
    totalEdits: {
      type: Number,
      default: 0
    },
    totalMessages: {
      type: Number,
      default: 0
    },
    totalDrawActions: {
      type: Number,
      default: 0
    },
    totalErases: {
      type: Number,
      default: 0
    },
    totalFilesUploaded: {
      type: Number,
      default: 0
    },
    totalViewers: {
      type: Number,
      default: 0
    },
    activeUsersCount: {
      type: Number,
      default: 0
    },

    // Current session info
    currentSessionId: {
      type: String,
      default: null
    },
    isArchived: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

const whiteboardModel =
  mongoose.models.Whiteboard || mongoose.model("Whiteboard", whiteboardSchema);

export default whiteboardModel;

