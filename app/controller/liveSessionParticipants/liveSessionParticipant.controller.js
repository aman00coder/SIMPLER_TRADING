import mongoose from "mongoose";
import HttpStatus from "http-status-codes";
import liveSessionParticipantModel from "../../model/liveSessionParticipant/liveSessionParticipant.model.js";
import liveSessionModel from "../../model/liveSessions/liveeSession.model.js";
import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { ROLE_MAP } from "../../constant/role.js";
import { v4 as uuidv4 } from "uuid";

// ===========================
// Join Participant (BRD-compliant)
// ===========================
export const joinParticipant = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.tokenData?.userId;
        const userRole = req.tokenData?.role || ROLE_MAP.VIEWER;
        const socketId = req.body.socketId || req.headers["x-socket-id"];
        const deviceSessionId = req.body.deviceSessionId || uuidv4();

        if (!sessionId || !userId || !socketId) {
            return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
        }

        // ✅ Check session exists
        const sessionExists = await liveSessionModel.findOne({ sessionId });
        if (!sessionExists) {
            return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        // ✅ Find participant for same session + device
        let participant = await liveSessionParticipantModel.findOne({ sessionId, userId, deviceSessionId });

        if (participant) {
            if (participant.status === "LEFT") {
                participant.status = "JOINED";
                participant.joinedAt = new Date();
                participant.leftAt = null;
                participant.isActiveDevice = true;
                participant.socketId = socketId;
                participant.lastActiveAt = new Date();
                participant.activityLog.push({ type: "join", timestamp: new Date() });
                await participant.save();
            } else {
                return sendErrorResponse(res, "User already joined this session on this device", HttpStatus.BAD_REQUEST);
            }
        } else {
            // ✅ Create new participant record
            participant = await liveSessionParticipantModel.create({
                sessionId,
                userId,
                role: userRole,
                socketId,
                deviceSessionId,
                status: "JOINED",
                isActiveDevice: true,
                ipAddress: req.ip,
                deviceInfo: req.headers["user-agent"],
                joinedAt: new Date(),
                micStatus: true,
                camStatus: true,
                handRaised: false,
                reactions: [],
                screenShareStatus: false,
                chatMessagesCount: 0,
                activityLog: [{ type: "join", timestamp: new Date() }],
                lastActiveAt: new Date(),
            });
        }

        // ✅ Update session stats
        const totalActive = await liveSessionParticipantModel.countDocuments({ sessionId, status: "JOINED" });
        await liveSessionModel.updateOne(
            { sessionId },
            {
                $inc: { totalJoins: 1 },
                $set: { peakParticipants: Math.max(totalActive, sessionExists.peakParticipants || 0) },
                $addToSet: { participants: userId },
                $setOnInsert: { actualStartTime: new Date() } // ensure start time is captured
            }
        );

        // ✅ Whiteboard sync
        if (sessionExists.whiteboardId) {
            await whiteboardModel.findByIdAndUpdate(
                sessionExists.whiteboardId,
                {
                    $addToSet: {
                        participants: {
                            user: userId,
                            role: userRole === ROLE_MAP.STREAMER ? "editor" : "viewer",
                            joinedAt: new Date(),
                        }
                    }
                }
            );
        }

        // ✅ Emit socket event
        const io = req.app.get("io");
        if (io) {
            io.to(sessionId).emit("participant:joined", {
                sessionId,
                userId,
                deviceSessionId,
                socketId,
                role: participant.role,
                status: participant.status,
            });
        }

        return sendSuccessResponse(res, participant, successEn.CREATED, HttpStatus.CREATED);

    } catch (error) {
        console.error("joinParticipant error:", error);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};

// ===========================
// Leave Participant
// ===========================
export const leaveParticipant = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.tokenData?.userId;
        const deviceSessionId = req.body.deviceSessionId; // specific device session (important for multi-device)

        if (!sessionId || !userId || !deviceSessionId) {
            return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
        }

        // ✅ Find participant for this device
        const participant = await liveSessionParticipantModel.findOne({ sessionId, userId, deviceSessionId });
        if (!participant) {
            return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        // ✅ Mark as LEFT (don't delete - keep audit)
        participant.status = "LEFT";
        participant.leftAt = new Date();
        participant.isActiveDevice = false;

        // calculate session duration (minutes)
        if (participant.joinedAt) {
            const durationMs = new Date() - new Date(participant.joinedAt);
            participant.durationConnected += Math.floor(durationMs / 60000); // add to total duration
        }

        // push activity log
        participant.activityLog.push({ type: "leave", timestamp: new Date() });

        await participant.save();

        // ✅ Emit socket event
        const io = req.app.get("io");
        if (io) {
            io.to(sessionId).emit("participant:left", {
                sessionId,
                userId,
                deviceSessionId,
                message: "Participant has left the session"
            });
        }

        return sendSuccessResponse(res, null, successEn.SESSION_LEFT, HttpStatus.OK);

    } catch (error) {
        console.error("leaveParticipant error:", error);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};


export const kickParticipant = async (req, res) => {
  try {
    const { sessionId, participantId } = req.params;
    const { reason } = req.body;
    const moderatorId = req.tokenData?.userId;

    if (!sessionId || !participantId || !moderatorId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    // 🔹 Find participant in this session
    const participant = await liveSessionParticipantModel.findOne({
      _id: participantId,
      sessionId: sessionId,
    });

    if (!participant) {
      return sendErrorResponse(
        res,
        "Participant not found in this session",
        HttpStatus.NOT_FOUND
      );
    }

    // ✅ Update participant status to KICKED (do not delete - keep history)
    participant.status = "KICKED";
    participant.actionBy = moderatorId;
    participant.reason = reason || "Removed by moderator";
    participant.leftAt = new Date();
    participant.isActiveDevice = false;

    // ✅ Calculate connected duration
    if (participant.joinedAt) {
      const durationMs = new Date() - new Date(participant.joinedAt);
      participant.durationConnected += Math.floor(durationMs / 60000);
    }

    // ✅ Add activity log entry
    participant.activityLog.push({
      type: "kick",
      timestamp: new Date(),
      value: reason || "Removed by moderator",
      actionBy: moderatorId,
    });

    await participant.save();

    // ✅ Emit socket event (notify others + participant itself)
    const io = req.app.get("io");
    if (io) {
      io.to(sessionId).emit("participant:kicked", {
        sessionId,
        participantId,
        userId: participant.userId,
        actionBy: moderatorId,
        reason: participant.reason,
      });

      // Also notify kicked user directly
      io.to(participant.socketId).emit("session:kicked", {
        sessionId,
        reason: participant.reason,
      });
    }

    return sendSuccessResponse(
      res,
      participant,
      "Participant kicked successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("Error in kickParticipant:", error);
    return sendErrorResponse(res, error.message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


export const toggleBanParticipant = async (req, res) => {
  try {
    const { sessionId, participantId } = req.params;
    const { reason } = req.body;
    const moderatorId = req.tokenData?.userId;

    if (!sessionId || !participantId || !moderatorId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    // 🔹 Find participant in this session
    const participant = await liveSessionParticipantModel.findOne({
      _id: participantId,
      sessionId,
    });

    if (!participant) {
      return sendErrorResponse(res, "Participant not found in this session", HttpStatus.NOT_FOUND);
    }

    const io = req.app.get("io");

    // 🔄 If already banned → UNBAN
    if (participant.status === "BANNED") {
      participant.status = "ACTIVE";
      participant.actionBy = moderatorId;
      participant.reason = null;
      participant.leftAt = null;
      participant.isActiveDevice = true;

      // ✅ Activity log
      participant.activityLog.push({
        type: "unban",
        timestamp: new Date(),
        value: "Unbanned by moderator",
        actionBy: moderatorId,
      });

      await participant.save();

      if (io) {
        io.to(sessionId).emit("participant:unbanned", {
          sessionId,
          participantId,
          userId: participant.userId,
          actionBy: moderatorId,
        });
      }

      return sendSuccessResponse(res, participant, "Participant unbanned successfully", HttpStatus.OK);
    }

    // 🔄 Else → BAN
    participant.status = "BANNED";
    participant.actionBy = moderatorId;
    participant.reason = reason || "Banned by moderator";
    participant.leftAt = new Date();
    participant.isActiveDevice = false;

    // ✅ Calculate connected duration
    if (participant.joinedAt) {
      const durationMs = new Date() - new Date(participant.joinedAt);
      participant.durationConnected += Math.floor(durationMs / 60000);
    }

    // ✅ Add activity log entry
    participant.activityLog.push({
      type: "ban",
      timestamp: new Date(),
      value: reason || "Banned by moderator",
      actionBy: moderatorId,
    });

    await participant.save();

    // ✅ Emit socket events
    if (io) {
      io.to(sessionId).emit("participant:banned", {
        sessionId,
        participantId,
        userId: participant.userId,
        actionBy: moderatorId,
        reason: participant.reason,
      });

      io.to(participant.socketId).emit("session:banned", {
        sessionId,
        reason: participant.reason,
      });
    }

    return sendSuccessResponse(res, participant, "Participant banned successfully", HttpStatus.OK);

  } catch (error) {
    console.error("Error in toggleBanParticipant:", error);
    return sendErrorResponse(res, error.message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


// Get All Participants (with role)
// ===========================
export const getSessionParticipants = async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    const participants = await liveSessionParticipantModel.find({ sessionId })
      .populate("userId", "name email role avatar"); // ✅ Added avatar for UI

    if (!participants.length) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // ✅ Group response
    const response = {
      sessionId,
      totalParticipants: participants.length,
      activeParticipants: participants.filter(p => p.status === "JOINED").length,
      participants: participants.map(p => ({
        _id: p._id,
        user: p.userId,  // populated user object
        role: p.role,
        status: p.status,
        socketId: p.socketId,
        deviceSessionId: p.deviceSessionId,
        isActiveDevice: p.isActiveDevice,
        joinedAt: p.joinedAt,
        leftAt: p.leftAt,
        ipAddress: p.ipAddress,
        deviceInfo: p.deviceInfo,

        // Engagement
        handRaised: p.handRaised,
        micStatus: p.micStatus,
        camStatus: p.camStatus,
        screenShareStatus: p.screenShareStatus,
        reactions: p.reactions,

        // Monitoring
        chatMessagesCount: p.chatMessagesCount,
        durationConnected: p.durationConnected,
        lastActiveAt: p.lastActiveAt,
      }))
    };

    return sendSuccessResponse(res, response, successEn.DATA_FOUND, HttpStatus.OK);

  } catch (error) {
    console.error("getSessionParticipants error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ===========================
// Get Single Participant
// ===========================
export const getSingleParticipant = async (req, res) => {
  try {
    const { sessionId, userId } = req.params;

    if (!sessionId || !userId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    // 🔹 Check session exists
    const sessionExists = await liveSessionModel.findOne({ sessionId });
    if (!sessionExists) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // 🔹 Find participant
    const participant = await liveSessionParticipantModel.findOne({
      sessionId,
      userId,
    }).populate("userId", "name email role avatar"); // ✅ added avatar for UI

    if (!participant) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_PARTICIPANT_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // ✅ Structured response with full model fields
    const response = {
      sessionId,
      participant: {
        _id: participant._id,
        user: participant.userId,  
        role: participant.role,
        status: participant.status,
        socketId: participant.socketId,
        deviceSessionId: participant.deviceSessionId,
        isActiveDevice: participant.isActiveDevice,
        joinedAt: participant.joinedAt,
        leftAt: participant.leftAt,
        ipAddress: participant.ipAddress,
        deviceInfo: participant.deviceInfo,

        // Engagement
        handRaised: participant.handRaised,
        micStatus: participant.micStatus,
        camStatus: participant.camStatus,
        screenShareStatus: participant.screenShareStatus,
        reactions: participant.reactions,

        // Monitoring
        chatMessagesCount: participant.chatMessagesCount,
        durationConnected: participant.durationConnected,
        lastActiveAt: participant.lastActiveAt,

        // Moderation
        actionBy: participant.actionBy,
        reason: participant.reason,

        // Logs
        activityLog: participant.activityLog,
      },
    };

    return sendSuccessResponse(res, response, successEn.DATA_FOUND, HttpStatus.OK);

  } catch (error) {
    console.error("getSingleParticipant error:", error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


export const updateEngagement = async (req, res) => {
  try {
    const { sessionId, participantId } = req.params;
    const userId = req.tokenData?.userId;
    const updates = req.body; // e.g. { micStatus: false, reaction: "👍" }

    if (!sessionId || !participantId || !userId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    // 🔹 Find participant in this session
    const participant = await liveSessionParticipantModel.findOne({
      _id: participantId,
      sessionId,
    });

    if (!participant) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_PARTICIPANT_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // 🔹 Track activity log entries
    const activityLogs = [];

    // ✅ Mic
    if (updates.micStatus !== undefined) {
      participant.micStatus = updates.micStatus;
      activityLogs.push({
        type: "mic",
        value: updates.micStatus ? "ON" : "OFF",
        actionBy: userId,
      });
    }

    // ✅ Camera
    if (updates.camStatus !== undefined) {
      participant.camStatus = updates.camStatus;
      activityLogs.push({
        type: "cam",
        value: updates.camStatus ? "ON" : "OFF",
        actionBy: userId,
      });
    }

    // ✅ Hand Raise
    if (updates.handRaised !== undefined) {
      participant.handRaised = updates.handRaised;
      activityLogs.push({
        type: "hand",
        value: updates.handRaised ? "RAISED" : "LOWERED",
        actionBy: userId,
      });
    }

    // ✅ Screen Share
    if (updates.screenShareStatus !== undefined) {
      participant.screenShareStatus = updates.screenShareStatus;
      activityLogs.push({
        type: "screenShare",
        value: updates.screenShareStatus ? "STARTED" : "STOPPED",
        actionBy: userId,
      });
    }

    // ✅ Reactions
    if (updates.reaction) {
      participant.reactions.push(updates.reaction);
      activityLogs.push({
        type: "reaction",
        value: updates.reaction,
        actionBy: userId,
      });
    }

    // ✅ Chat Messages Count
    if (updates.chatMessagesCount !== undefined) {
      participant.chatMessagesCount += Number(updates.chatMessagesCount);
      activityLogs.push({
        type: "chat",
        value: `+${updates.chatMessagesCount} message(s)`,
        actionBy: userId,
      });
    }

    // ✅ Poll Responses
    if (updates.pollResponse) {
      participant.pollResponses.push(updates.pollResponse);
      activityLogs.push({
        type: "poll",
        value: JSON.stringify(updates.pollResponse),
        actionBy: userId,
      });
    }

    // ✅ Notes Taken
    if (updates.notesTaken !== undefined) {
      participant.notesTaken = updates.notesTaken;
      activityLogs.push({
        type: "notes",
        value: updates.notesTaken ? "TAKEN" : "NOT TAKEN",
        actionBy: userId,
      });
    }

    // ✅ Update engagement time (tracking)
    if (updates.durationConnected !== undefined) {
      participant.durationConnected += Number(updates.durationConnected);
      activityLogs.push({
        type: "time",
        value: `+${updates.durationConnected} sec connected`,
        actionBy: userId,
      });
    }

    // ✅ Last Active
    participant.lastActiveAt = new Date();

    // 🔹 Push logs into activityLog
    if (activityLogs.length > 0) {
      participant.activityLog.push(...activityLogs);
    }

    // 🔹 Save changes
    await participant.save();

    // ✅ Emit socket event (real-time update to session room)
    const io = req.app.get("io");
    if (io) {
      io.to(sessionId).emit("participant:engagementUpdated", {
        participantId: participant._id,
        updates,
      });
    }

    return sendSuccessResponse(res, participant, "Engagement updated successfully", HttpStatus.OK);

  } catch (error) {
    console.error("Error in updateEngagement:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


export const updateNetworkStats = async (req, res) => {
  try {
    const { sessionId, participantId } = req.params;
    const userId = req.tokenData?.userId;
    const { networkQuality, latency, jitter, packetLoss } = req.body;

    if (!sessionId || !participantId || !userId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    // 🔹 Find participant
    const participant = await liveSessionParticipantModel.findOne({
      _id: participantId,
      sessionId,
    });

    if (!participant) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_PARTICIPANT_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // 🔹 Update stats only if provided
    if (networkQuality !== undefined) participant.networkQuality = networkQuality;
    if (latency !== undefined) participant.latency = latency;
    if (jitter !== undefined) participant.jitter = jitter;
    if (packetLoss !== undefined) participant.packetLoss = packetLoss;

    participant.lastActiveAt = new Date();

    // 🔹 Add activity log entry
    participant.activityLog.push({
      type: "network",
      value: JSON.stringify({
        networkQuality: participant.networkQuality,
        latency: participant.latency,
        jitter: participant.jitter,
        packetLoss: participant.packetLoss,
      }),
      actionBy: userId,
    });

    await participant.save();

    // ✅ Emit real-time network update event
    const io = req.app.get("io");
    if (io) {
      io.to(sessionId).emit("participant:networkUpdated", {
        participantId: participant._id,
        networkQuality: participant.networkQuality,
        latency: participant.latency,
        jitter: participant.jitter,
        packetLoss: participant.packetLoss,
      });
    }

    return sendSuccessResponse(
      res,
      participant,
      "Network stats updated successfully",
      HttpStatus.OK
    );
  } catch (error) {
    console.error("Error in updateNetworkStats:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

export const updateChatCount = async (req, res) => {
  try {
    const { sessionId, participantId } = req.params;
    const userId = req.tokenData?.userId;
    const { count } = req.body; // e.g. { "count": 1 }

    if (!sessionId || !participantId || !userId || count === undefined) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    // 🔹 Validate count (must be integer)
    const increment = Number(count);
    if (isNaN(increment)) {
      return sendErrorResponse(res, "Chat count must be a valid number", HttpStatus.BAD_REQUEST);
    }

    // 🔹 Find participant
    const participant = await liveSessionParticipantModel.findOne({
      _id: participantId,
      sessionId,
    });

    if (!participant) {
      return sendErrorResponse(res, errorEn.LIVE_SESSION_PARTICIPANT_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // 🔹 Increment chat count
    participant.chatMessagesCount += increment;
    participant.lastActiveAt = new Date();

    // 🔹 Add activity log
    participant.activityLog.push({
      type: "chat",
      value: `+${increment} message(s)`,
      actionBy: userId,
    });

    await participant.save();

    // ✅ Emit real-time event
    const io = req.app.get("io");
    if (io) {
      io.to(sessionId).emit("participant:chatUpdated", {
        participantId: participant._id,
        chatMessagesCount: participant.chatMessagesCount,
        lastActiveAt: participant.lastActiveAt,
      });
    }

    return sendSuccessResponse(
      res,
      participant,
      "Chat count updated successfully",
      HttpStatus.OK
    );
  } catch (error) {
    console.error("Error in updateChatCount:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};
