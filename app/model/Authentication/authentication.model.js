import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
        name: {
          type: String,
          required: true,
          trim: true
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true
        },
        password: {
            type: String,
            required: true,
            minlength: 6
        },
        role: {
            type: String,
            enum: ["ADMIN", "STREAMER", "VIEWER"],
            default: "VIEWER"
        },
        profilePic: {
            type: String,
            default: ""
        },
        phone: {
            type: String,
            default: ""
        },
        isActive: {
            type: Boolean,
            default: true
        },
        lastLogin: {
            type: Date
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User"
        },
    resetPasswordToken: String,
    resetPasswordExpire: Date,
  },
  { timestamps: true }
);

const authenticationModel = mongoose.model("User", userSchema);

export default authenticationModel;