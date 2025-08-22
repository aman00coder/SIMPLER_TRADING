import mongoose from 'mongoose';
import HttpStatus from 'http-status-codes';
import { sendSuccessResponse, sendErrorResponse } from '../../responses/responses.js';
import { errorEn, successEn } from '../../responses/message.js';
import chatMessageModel from '../../model/liveChat/liveChat.model.js';
import { ROLE_MAP } from '../../constant/role.js';
import * as commonServices from "../../services/common.js";

export const sendMessage = async (req, res) => {
  try {
    const {
      receiverId,
      message,
      sessionId,
      type = 'TEXT',
      fileUrl,
      location,
      replyTo,
      mentions,
      forwardedFrom,
      customData,
      tags,
    } = req.body;

    const senderId = req.tokenData?.userId;

    if (!senderId) {
      return sendErrorResponse(res, 'Unauthorized: SenderId missing from token', HttpStatus.UNAUTHORIZED);
    }

    if (!message && (!fileUrl || fileUrl.length === 0) && !location) {
      return sendErrorResponse(res, 'Message, file or location is required', HttpStatus.BAD_REQUEST);
    }

    if (!receiverId && !sessionId) {
      return sendErrorResponse(res, 'Either receiverId or sessionId must be provided', HttpStatus.BAD_REQUEST);
    }

    let finalFileUrl = '';
    if (fileUrl && Array.isArray(fileUrl) && fileUrl.length > 0) {
      finalFileUrl = fileUrl[0]?.fileUrl || '';
    }

    const newMessage = new chatMessageModel({
      senderId,
      receiverId: receiverId || null,
      sessionId: sessionId || null,   // 👈 ab string save hoga
      message: message || '',
      type,
      fileUrl: finalFileUrl,
      location: location || null,
      replyTo: replyTo || null,
      mentions: mentions || [],
      forwardedFrom: forwardedFrom || null,
      customData: customData || {},
      tags: tags || [],
    });


    const savedMessage = await newMessage.save();


    // ✅ Socket emit using app's io
    const io = req.app.get("io");
    if (io && sessionId) {
      io.to(sessionId.toString()).emit("newMessage", savedMessage);
    }

    // 🟢 FIXED order
    return sendSuccessResponse(res, savedMessage, successEn.MESSAGE_SENT, HttpStatus.OK);

  } catch (error) {
    console.error("❌ sendMessage error:", error.message);
    return sendErrorResponse(res, errorEn.SOMETHING_WENT_WRONG, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

export const fetchMessages = async (req, res) => {
  try {
    const { sessionId, receiverId, limit = 50, skip = 0 } = req.query;

    if (!sessionId && !receiverId) {
      return sendErrorResponse(
        res,
        "Either sessionId or receiverId must be provided",
        HttpStatus.BAD_REQUEST
      );
    }

    const filter = { isDeleted: false };

    // expire filter
    filter.$or = [
      { expiresAt: { $exists: false } },
      { expiresAt: { $gt: new Date() } }
    ];

    // convert sessionId if possible
    if (sessionId) {
      filter.sessionId = mongoose.Types.ObjectId.isValid(sessionId)
        ? new mongoose.Types.ObjectId(sessionId)
        : sessionId;
    }

    // convert sender/receiver id if present
    if (receiverId) {
      const userId = mongoose.Types.ObjectId.isValid(req.tokenData.userId)
        ? new mongoose.Types.ObjectId(req.tokenData.userId)
        : req.tokenData.userId;

      const rId = mongoose.Types.ObjectId.isValid(receiverId)
        ? new mongoose.Types.ObjectId(receiverId)
        : receiverId;

      filter.$and = [
        {
          $or: [
            { senderId: userId, receiverId: rId },
            { senderId: rId, receiverId: userId }
          ]
        }
      ];
    }

    // 🔍 Debug logs
    console.log("👉 req.tokenData.userId:", req.tokenData.userId);
    console.log("👉 sessionId:", sessionId);
    console.log("👉 receiverId:", receiverId);
    console.log("👉 Final filter:", JSON.stringify(filter, null, 2));

    const messages = await chatMessageModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(Number(skip))
      .limit(Number(limit))
      .populate("senderId", "fullName email")
      .populate("receiverId", "fullName email")
      .populate({
        path: "replyTo",
        populate: { path: "senderId", select: "fullName email" }
      })
      .populate("reactions.userId", "fullName email")
      .populate("seenBy.userId", "fullName email")
      .lean();

    return sendSuccessResponse(
      res,
      messages.reverse(),
      "Messages fetched successfully",
      HttpStatus.OK
    );
  } catch (error) {
    console.error("❌ fetchMessages error:", error.message);
    return sendErrorResponse(
      res,
      "Internal server error",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};


// 🗑 Delete Message
export const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.tokenData.userId;

    // 🔍 Check if message exists
    const message = await chatMessageModel.findById(messageId)
      .populate("senderId", "fullName email")
      .populate("receiverId", "fullName email")
      .lean(); // ✅ lean use karna taaki plain object mile

    if (!message) {
      return sendErrorResponse(
        res,
        "Message not found",
        HttpStatus.NOT_FOUND
      );
    }

    // ✅ Only sender OR admin can delete
    if (
      message.senderId._id.toString() !== userId.toString() &&
      req.tokenData.role !== "admin"
    ) {
      return sendErrorResponse(
        res,
        "Not authorized to delete this message",
        HttpStatus.FORBIDDEN
      );
    }

    // 🔥 Delete
    await chatMessageModel.findByIdAndDelete(messageId);

    // 🟢 Real-time broadcast (optional)
    if (req.io) {
      req.io.to(message.sessionId?.toString()).emit("message_deleted", {
        messageId,
      });
    }

    return sendSuccessResponse(
      res,
      message,                           // ✅ deleted message ka data bheja
      "Message deleted successfully",
      HttpStatus.OK
    );
  } catch (error) {
    console.error("❌ deleteMessage error:", error.message);
    return sendErrorResponse(
      res,
      "Internal server error",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};


export const editMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { newMessage } = req.body;
    const userId = req.tokenData.userId; // ✅ same key as tokenData

    if (!newMessage || newMessage.trim() === "") {
      return sendErrorResponse(
        res,
        "New message text is required",  // ✅ message first
        HttpStatus.BAD_REQUEST           // ✅ status code second
      );
    }

    // 🔹 Pehle message find karo
    const message = await chatMessageModel.findById(messageId);
    if (!message) {
      return sendErrorResponse(
        res,
        "Message not found",
        HttpStatus.NOT_FOUND
      );
    }

    // 🔹 Sirf sender apna message edit kar sakta hai
    if (message.senderId.toString() !== userId) {
      return sendErrorResponse(
        res,
        "You can only edit your own messages",
        HttpStatus.FORBIDDEN
      );
    }

    // 🔹 Message update karo
    message.message = newMessage;
    message.isEdited = true;
    await message.save();

    // 🔹 Socket emit karo (real-time update for all participants)
    if (req.io) {
      req.io.to(message.sessionId?.toString()).emit("message_edited", {
        messageId: message._id,
        newMessage: message.message,
        isEdited: true,
      });
    }

    return sendSuccessResponse(
      res,
      message,                       // ✅ data first
      "Message edited successfully",  // ✅ message second
      HttpStatus.OK                   // ✅ status code last
    );
  } catch (error) {
    console.error("❌ editMessage error:", error.message);
    return sendErrorResponse(
      res,
      "Internal server error",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};




export const reactMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.tokenData.userId; 

    if (!emoji) {
      return sendErrorResponse(
        res,
        "Emoji is required",     
        HttpStatus.BAD_REQUEST  
      );
    }

    const message = await chatMessageModel.findById(messageId);
    if (!message) {
      return sendErrorResponse(
        res,
        "Message not found",
        HttpStatus.NOT_FOUND
      );
    }

    // 🔹 Check if user already reacted
    const existingReactionIndex = message.reactions.findIndex(
      (r) => r.userId.toString() === userId.toString()
    );

    if (existingReactionIndex > -1) {
      // If same emoji → remove reaction
      if (message.reactions[existingReactionIndex].emoji === emoji) {
        message.reactions.splice(existingReactionIndex, 1);
      } else {
        // If different emoji → update emoji
        message.reactions[existingReactionIndex].emoji = emoji;
      }
    } else {
      // Add new reaction
      message.reactions.push({ userId, emoji });
    }

    await message.save();

    return sendSuccessResponse(
      res,
      message,                       // ✅ data first
      "Reaction updated successfully",// ✅ message second
      HttpStatus.OK                   // ✅ status code last
    );
  } catch (error) {
    console.error("❌ reactMessage error:", error.message);
    return sendErrorResponse(
      res,
      "Internal server error",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};



export const pinMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.tokenData.userId;

    // 🔹 Find message
    const message = await chatMessageModel.findById(messageId);
    if (!message) {
      return sendErrorResponse(res, "Message not found", HttpStatus.NOT_FOUND);
    }

    // 🔹 Toggle pin/unpin
    if (message.isPinned) {
      message.isPinned = false;
      message.pinnedBy = null;
    } else {
      message.isPinned = true;
      message.pinnedBy = userId;
    }

    // 🔹 Save and get updated document
    const updatedMessage = await chatMessageModel.findByIdAndUpdate(
      messageId,
      { isPinned: message.isPinned, pinnedBy: message.pinnedBy },
      { new: true }
    )
      .populate("senderId", "fullName email")
      .populate("receiverId", "fullName email")
      .populate({
        path: "replyTo",
        populate: { path: "senderId", select: "fullName email" }
      })
      .populate("reactions.userId", "fullName email")
      .populate("seenBy.userId", "fullName email")
      .lean();

    // 🔹 Socket emit
    if (req.io) {
      req.io.to(updatedMessage.sessionId.toString()).emit("message_pinned", updatedMessage);
    }

    return sendSuccessResponse(
      res,
      updatedMessage,
      "Message pin status updated",
      HttpStatus.OK
    );
  } catch (error) {
    console.error("❌ Error in pinMessage:", error);
    return sendErrorResponse(res, "Something went wrong", HttpStatus.INTERNAL_SERVER_ERROR);
  }
};




export const markSeenMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.tokenData.userId;

    // 🔹 Message find karo (populate for nice response)
    const message = await chatMessageModel.findById(messageId)
      .populate("senderId", "fullName email")
      .populate("receiverId", "fullName email")
      .populate("reactions.userId", "fullName email")
      .populate("seenBy.userId", "fullName email"); // ✅ seenBy ka userId populate

    if (!message) {
      return sendErrorResponse(
        res,
        "Message not found",   
        HttpStatus.NOT_FOUND        
      );
    }

    // 🔹 Check if user already marked seen
    const alreadySeen = message.seenBy.some(
      (s) => s.userId.toString() === userId
    );

    if (!alreadySeen) {
      // ✅ Push object, not string
      message.seenBy.push({ userId, seenAt: new Date() });
      await message.save();
    }

    // 🔹 Real-time emit
    if (req.io) {
      req.io.to(message.sessionId.toString()).emit("message_seen", {
        messageId,
        seenBy: userId,
      });
    }

    // 🔹 Success response
    return sendSuccessResponse(
      res,
      message,                   // message data bheja jaa raha hai
      "Message marked as seen",      
      HttpStatus.OK                  
    );
  } catch (error) {
    console.error("❌ markSeenMessage error:", error);
    return sendErrorResponse(
      res,
      "Internal server error",       
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};


export const fetchThread = async (req, res) => {
  try {
    const { parentMessageId } = req.params;

    // 🔹 Parent message fetch karo
    const parentMessage = await chatMessageModel.findById(parentMessageId)
      .populate("senderId", "fullName email")
      .populate("reactions.userId", "fullName email");

    if (!parentMessage) {
      return sendErrorResponse(
        res,
        "Parent message not found", 
        HttpStatus.NOT_FOUND
      );
    }

    // 🔹 Sare replies fetch karo
    const replies = await chatMessageModel.find({ replyTo: parentMessageId })
      .populate("senderId", "fullName email")
      .populate("reactions.userId", "fullName email")
      .sort({ createdAt: 1 });

    // 🔹 Success response
    return sendSuccessResponse(
      res,
      { parentMessage, replies },   // data
      "Thread fetched successfully", // message
      HttpStatus.OK                  // status
    );
  } catch (error) {
    console.error("❌ fetchThread error:", error.message);
    return sendErrorResponse(
      res,
      "Something went wrong",                  // message
      HttpStatus.INTERNAL_SERVER_ERROR        // status code
    );
  }
};
