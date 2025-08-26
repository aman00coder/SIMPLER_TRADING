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
        const { sessionId, roomCode } = req.body; // frontend can send either
        const userId = req.tokenData?.userId;
        const userRole = req.tokenData?.role || ROLE_MAP.VIEWER;
        const socketId = req.body.socketId || req.headers["x-socket-id"];
        const deviceSessionId = req.body.deviceSessionId || uuidv4();

        if (!userId || !socketId || (!sessionId && !roomCode)) {
            return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
        }

        // 🔹 Resolve sessionId from roomCode if not provided
        let sessionExists;
        if (sessionId) {
            sessionExists = await liveSessionModel.findOne({ sessionId });
        } else if (roomCode) {
            sessionExists = await liveSessionModel.findOne({ roomCode, status: "ACTIVE" });
        }

        if (!sessionExists) {
            return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        const actualSessionId = sessionExists.sessionId;

        // 🔹 Rest of the code uses actualSessionId instead of sessionId
        let participant = await liveSessionParticipantModel.findOne({ sessionId: actualSessionId, userId, deviceSessionId });

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
            participant = await liveSessionParticipantModel.create({
                sessionId: actualSessionId,
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

        // 🔹 Update session stats & whiteboard sync
        const totalActive = await liveSessionParticipantModel.countDocuments({ sessionId: actualSessionId, status: "JOINED" });
        await liveSessionModel.updateOne(
            { sessionId: actualSessionId },
            {
                $inc: { totalJoins: 1 },
                $set: { peakParticipants: Math.max(totalActive, sessionExists.peakParticipants || 0) },
                $addToSet: { participants: userId },
                $setOnInsert: { actualStartTime: new Date() }
            }
        );

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

        // 🔹 Emit socket event
        const io = req.app.get("io");
        if (io) {
            io.to(actualSessionId).emit("participant:joined", {
                sessionId: actualSessionId,
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
        const { sessionId, roomCode } = req.body;
        const userId = req.tokenData?.userId;
        const deviceSessionId = req.body.deviceSessionId;

        if (!userId || !deviceSessionId || (!sessionId && !roomCode)) {
            return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
        }

        // 🔹 Resolve sessionId from roomCode if not provided
        let sessionExists;
        if (sessionId) {
            sessionExists = await liveSessionModel.findOne({ sessionId });
        } else if (roomCode) {
            sessionExists = await liveSessionModel.findOne({ roomCode, status: "ACTIVE" });
        }

        if (!sessionExists) {
            return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        const actualSessionId = sessionExists.sessionId;

        const participant = await liveSessionParticipantModel.findOne({ sessionId: actualSessionId, userId, deviceSessionId });
        if (!participant) {
            return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        participant.status = "LEFT";
        participant.leftAt = new Date();
        participant.isActiveDevice = false;

        if (participant.joinedAt) {
            const durationMs = new Date() - new Date(participant.joinedAt);
            participant.durationConnected += Math.floor(durationMs / 60000);
        }

        participant.activityLog.push({ type: "leave", timestamp: new Date() });
        await participant.save();

        const io = req.app.get("io");
        if (io) {
            io.to(actualSessionId).emit("participant:left", {
                sessionId: actualSessionId,
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
    const { sessionId, roomCode, participantId } = req.body;
    const { reason } = req.body;
    const moderatorId = req.tokenData?.userId;

    if (!participantId || !moderatorId || (!sessionId && !roomCode)) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    let sessionExists;
    if (sessionId) sessionExists = await liveSessionModel.findOne({ sessionId });
    else if (roomCode) sessionExists = await liveSessionModel.findOne({ roomCode, status: "ACTIVE" });

    if (!sessionExists) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
    const actualSessionId = sessionExists.sessionId;

    const participant = await liveSessionParticipantModel.findOne({ _id: participantId, sessionId: actualSessionId });
    if (!participant) return sendErrorResponse(res, "Participant not found in this session", HttpStatus.NOT_FOUND);

    participant.status = "KICKED";
    participant.actionBy = moderatorId;
    participant.reason = reason || "Removed by moderator";
    participant.leftAt = new Date();
    participant.isActiveDevice = false;

    if (participant.joinedAt) {
      const durationMs = new Date() - new Date(participant.joinedAt);
      participant.durationConnected += Math.floor(durationMs / 60000);
    }

    participant.activityLog.push({ type: "kick", timestamp: new Date(), value: reason || "Removed by moderator", actionBy: moderatorId });
    await participant.save();

    const io = req.app.get("io");
    if (io) {
      io.to(actualSessionId).emit("participant:kicked", { sessionId: actualSessionId, participantId, userId: participant.userId, actionBy: moderatorId, reason: participant.reason });
      io.to(participant.socketId).emit("session:kicked", { sessionId: actualSessionId, reason: participant.reason });
    }

    return sendSuccessResponse(res, participant, "Participant kicked successfully", HttpStatus.OK);

  } catch (error) {
    console.error("Error in kickParticipant:", error);
    return sendErrorResponse(res, error.message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};



export const toggleBanParticipant = async (req, res) => {
  try {
    const { sessionId, roomCode, participantId } = req.body;
    const { reason } = req.body;
    const moderatorId = req.tokenData?.userId;

    if (!participantId || !moderatorId || (!sessionId && !roomCode)) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    let sessionExists;
    if (sessionId) sessionExists = await liveSessionModel.findOne({ sessionId });
    else if (roomCode) sessionExists = await liveSessionModel.findOne({ roomCode, status: "ACTIVE" });

    if (!sessionExists) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
    const actualSessionId = sessionExists.sessionId;

    const participant = await liveSessionParticipantModel.findOne({ _id: participantId, sessionId: actualSessionId });
    if (!participant) return sendErrorResponse(res, "Participant not found in this session", HttpStatus.NOT_FOUND);

    const io = req.app.get("io");

    if (participant.status === "BANNED") {
      participant.status = "ACTIVE";
      participant.actionBy = moderatorId;
      participant.reason = null;
      participant.leftAt = null;
      participant.isActiveDevice = true;

      participant.activityLog.push({ type: "unban", timestamp: new Date(), value: "Unbanned by moderator", actionBy: moderatorId });
      await participant.save();

      if (io) io.to(actualSessionId).emit("participant:unbanned", { sessionId: actualSessionId, participantId, userId: participant.userId, actionBy: moderatorId });

      return sendSuccessResponse(res, participant, "Participant unbanned successfully", HttpStatus.OK);
    }

    participant.status = "BANNED";
    participant.actionBy = moderatorId;
    participant.reason = reason || "Banned by moderator";
    participant.leftAt = new Date();
    participant.isActiveDevice = false;

    if (participant.joinedAt) {
      const durationMs = new Date() - new Date(participant.joinedAt);
      participant.durationConnected += Math.floor(durationMs / 60000);
    }

    participant.activityLog.push({ type: "ban", timestamp: new Date(), value: reason || "Banned by moderator", actionBy: moderatorId });
    await participant.save();

    if (io) {
      io.to(actualSessionId).emit("participant:banned", { sessionId: actualSessionId, participantId, userId: participant.userId, actionBy: moderatorId, reason: participant.reason });
      io.to(participant.socketId).emit("session:banned", { sessionId: actualSessionId, reason: participant.reason });
    }

    return sendSuccessResponse(res, participant, "Participant banned successfully", HttpStatus.OK);

  } catch (error) {
    console.error("Error in toggleBanParticipant:", error);
    return sendErrorResponse(res, error.message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};



// Helper to get session by sessionId or roomCode
const getSessionByIdOrCode = async ({ sessionId, roomCode }) => {
    if (sessionId) return await liveSessionModel.findOne({ sessionId });
    if (roomCode) return await liveSessionModel.findOne({ roomCode, status: "ACTIVE" });
    return null;
};

// ===========================
// Get All Participants (with role)
// ===========================
export const getSessionParticipants = async (req, res) => {
    try {
        const { sessionId, roomCode } = req.params;

        const session = await getSessionByIdOrCode({ sessionId, roomCode });
        if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

        const participants = await liveSessionParticipantModel.find({ sessionId: session.sessionId })
            .populate("userId", "name email role avatar");

        if (!participants.length) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

        const response = {
            sessionId: session.sessionId,
            totalParticipants: participants.length,
            activeParticipants: participants.filter(p => p.status === "JOINED").length,
            participants: participants.map(p => ({
                _id: p._id,
                user: p.userId,
                role: p.role,
                status: p.status,
                socketId: p.socketId,
                deviceSessionId: p.deviceSessionId,
                isActiveDevice: p.isActiveDevice,
                joinedAt: p.joinedAt,
                leftAt: p.leftAt,
                ipAddress: p.ipAddress,
                deviceInfo: p.deviceInfo,
                handRaised: p.handRaised,
                micStatus: p.micStatus,
                camStatus: p.camStatus,
                screenShareStatus: p.screenShareStatus,
                reactions: p.reactions,
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
        const { sessionId, roomCode, userId } = req.params;

        if (!userId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

        const session = await getSessionByIdOrCode({ sessionId, roomCode });
        if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

        const participant = await liveSessionParticipantModel.findOne({
            sessionId: session.sessionId,
            userId
        }).populate("userId", "name email role avatar");

        if (!participant) return sendErrorResponse(res, errorEn.LIVE_SESSION_PARTICIPANT_NOT_FOUND, HttpStatus.NOT_FOUND);

        const response = {
            sessionId: session.sessionId,
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
                handRaised: participant.handRaised,
                micStatus: participant.micStatus,
                camStatus: participant.camStatus,
                screenShareStatus: participant.screenShareStatus,
                reactions: participant.reactions,
                chatMessagesCount: participant.chatMessagesCount,
                durationConnected: participant.durationConnected,
                lastActiveAt: participant.lastActiveAt,
                actionBy: participant.actionBy,
                reason: participant.reason,
                activityLog: participant.activityLog,
            }
        };

        return sendSuccessResponse(res, response, successEn.DATA_FOUND, HttpStatus.OK);

    } catch (error) {
        console.error("getSingleParticipant error:", error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};

// ===========================
// Update Engagement
// ===========================
export const updateEngagement = async (req, res) => {
    try {
        const { sessionId, roomCode, participantId } = req.params;
        const userId = req.tokenData?.userId;
        const updates = req.body;

        if (!participantId || !userId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

        const session = await getSessionByIdOrCode({ sessionId, roomCode });
        if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

        const participant = await liveSessionParticipantModel.findOne({ _id: participantId, sessionId: session.sessionId });
        if (!participant) return sendErrorResponse(res, errorEn.LIVE_SESSION_PARTICIPANT_NOT_FOUND, HttpStatus.NOT_FOUND);

        const activityLogs = [];

        if (updates.micStatus !== undefined) {
            participant.micStatus = updates.micStatus;
            activityLogs.push({ type: "mic", value: updates.micStatus ? "ON" : "OFF", actionBy: userId });
        }

        if (updates.camStatus !== undefined) {
            participant.camStatus = updates.camStatus;
            activityLogs.push({ type: "cam", value: updates.camStatus ? "ON" : "OFF", actionBy: userId });
        }

        if (updates.handRaised !== undefined) {
            participant.handRaised = updates.handRaised;
            activityLogs.push({ type: "hand", value: updates.handRaised ? "RAISED" : "LOWERED", actionBy: userId });
        }

        if (updates.screenShareStatus !== undefined) {
            participant.screenShareStatus = updates.screenShareStatus;
            activityLogs.push({ type: "screenShare", value: updates.screenShareStatus ? "STARTED" : "STOPPED", actionBy: userId });
        }

        if (updates.reaction) {
            participant.reactions.push(updates.reaction);
            activityLogs.push({ type: "reaction", value: updates.reaction, actionBy: userId });
        }

        if (updates.chatMessagesCount !== undefined) {
            participant.chatMessagesCount += Number(updates.chatMessagesCount);
            activityLogs.push({ type: "chat", value: `+${updates.chatMessagesCount} message(s)`, actionBy: userId });
        }

        if (updates.pollResponse) {
            participant.pollResponses.push(updates.pollResponse);
            activityLogs.push({ type: "poll", value: JSON.stringify(updates.pollResponse), actionBy: userId });
        }

        if (updates.notesTaken !== undefined) {
            participant.notesTaken = updates.notesTaken;
            activityLogs.push({ type: "notes", value: updates.notesTaken ? "TAKEN" : "NOT TAKEN", actionBy: userId });
        }

        if (updates.durationConnected !== undefined) {
            participant.durationConnected += Number(updates.durationConnected);
            activityLogs.push({ type: "time", value: `+${updates.durationConnected} sec connected`, actionBy: userId });
        }

        participant.lastActiveAt = new Date();

        if (activityLogs.length > 0) participant.activityLog.push(...activityLogs);

        await participant.save();

        const io = req.app.get("io");
        if (io) {
            io.to(session.sessionId).emit("participant:engagementUpdated", { participantId: participant._id, updates });
        }

        return sendSuccessResponse(res, participant, "Engagement updated successfully", HttpStatus.OK);

    } catch (error) {
        console.error("Error in updateEngagement:", error);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};

// ===========================
// Update Network Stats
// ===========================
export const updateNetworkStats = async (req, res) => {
    try {
        const { sessionId, roomCode, participantId } = req.params;
        const userId = req.tokenData?.userId;
        const { networkQuality, latency, jitter, packetLoss } = req.body;

        if (!participantId || !userId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

        const session = await getSessionByIdOrCode({ sessionId, roomCode });
        if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

        const participant = await liveSessionParticipantModel.findOne({ _id: participantId, sessionId: session.sessionId });
        if (!participant) return sendErrorResponse(res, errorEn.LIVE_SESSION_PARTICIPANT_NOT_FOUND, HttpStatus.NOT_FOUND);

        if (networkQuality !== undefined) participant.networkQuality = networkQuality;
        if (latency !== undefined) participant.latency = latency;
        if (jitter !== undefined) participant.jitter = jitter;
        if (packetLoss !== undefined) participant.packetLoss = packetLoss;

        participant.lastActiveAt = new Date();

        participant.activityLog.push({
            type: "network",
            value: JSON.stringify({ networkQuality: participant.networkQuality, latency: participant.latency, jitter: participant.jitter, packetLoss: participant.packetLoss }),
            actionBy: userId,
        });

        await participant.save();

        const io = req.app.get("io");
        if (io) {
            io.to(session.sessionId).emit("participant:networkUpdated", { participantId: participant._id, networkQuality: participant.networkQuality, latency: participant.latency, jitter: participant.jitter, packetLoss: participant.packetLoss });
        }

        return sendSuccessResponse(res, participant, "Network stats updated successfully", HttpStatus.OK);

    } catch (error) {
        console.error("Error in updateNetworkStats:", error);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};

// ===========================
// Update Chat Count
// ===========================
export const updateChatCount = async (req, res) => {
    try {
        const { sessionId, roomCode, participantId } = req.params;
        const userId = req.tokenData?.userId;
        const { count } = req.body;

        if (!participantId || !userId || count === undefined) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

        const increment = Number(count);
        if (isNaN(increment)) return sendErrorResponse(res, "Chat count must be a valid number", HttpStatus.BAD_REQUEST);

        const session = await getSessionByIdOrCode({ sessionId, roomCode });
        if (!session) return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);

        const participant = await liveSessionParticipantModel.findOne({ _id: participantId, sessionId: session.sessionId });
        if (!participant) return sendErrorResponse(res, errorEn.LIVE_SESSION_PARTICIPANT_NOT_FOUND, HttpStatus.NOT_FOUND);

        participant.chatMessagesCount += increment;
        participant.lastActiveAt = new Date();

        participant.activityLog.push({
            type: "chat",
            value: `+${increment} message(s)`,
            actionBy: userId,
        });

        await participant.save();

        const io = req.app.get("io");
        if (io) {
            io.to(session.sessionId).emit("participant:chatUpdated", { participantId: participant._id, chatMessagesCount: participant.chatMessagesCount, lastActiveAt: participant.lastActiveAt });
        }

        return sendSuccessResponse(res, participant, "Chat count updated successfully", HttpStatus.OK);

    } catch (error) {
        console.error("Error in updateChatCount:", error);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};

