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
    duration: { type: Number }, 
        rating: {
            type: Number,
            default: 0
        },
    enrolledUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
        isActive: {
            type: Boolean,
            default: true
        },
  },
  { timestamps: true }
);

export default mongoose.model("Course", courseSchema);
