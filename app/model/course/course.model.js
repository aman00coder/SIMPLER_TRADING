import mongoose from "mongoose";

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

    enrolledUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    isActive: {
      type: Boolean,
      default: true
    },

    // ✅ New Fields for Phase 3 (BRD Base)
    lectures: [
      {
        title: { type: String, required: true },
        type: { type: String, enum: ["video", "pdf", "ppt", "note"], default: "video" },
        url: { type: String }, // file/video link (AWS/Cloudinary)
        duration: { type: Number }, // in minutes
        isPreviewFree: { type: Boolean, default: false }
      }
    ],

    liveClasses: [
      {
        title: { type: String },
        scheduleAt: { type: Date }, // scheduled date & time
        duration: { type: Number }, // minutes
        mentor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        meetLink: { type: String } // Zoom/Google Meet/WebRTC link
      }
    ],

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
        resources: [{ type: String }] // file links
      }
    ]
  },
  { timestamps: true }
);

export default mongoose.model("Course", courseSchema);
