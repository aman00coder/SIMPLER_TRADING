import mongoose from "mongoose";
import HttpStatus from "http-status-codes";
import liveSessionParticipantModel from "../../model/liveSessionParticipant/liveSessionParticipant.model.js";
import liveSessionModel from "../../model/liveSessions/liveeSession.model.js";
import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { ROLE_MAP } from "../../constant/role.js";
import { v4 as uuidv4 } from "uuid";
import { getIO } from "../../services/socket.integrated.js"; // ✅ add this

// ===========================
// Join Participant (BRD-compliant)
// ===========================
export const joinParticipant = async (req, res) => {
  try {
    const {
      sessionId,
      deviceSessionId,
      role,
      networkStats,
      engagementStats,
      geoLocation,
      socketId,
    } = req.body;

    const userId = req.tokenData.userId;

    let session = await liveSessionModel.findOne({ sessionId });
    if (!session) {
      return sendErrorResponse(res, "Session not found", 404);
    }

    const isBanned = session.bannedParticipants?.includes(userId);
    if (isBanned) {
      return sendErrorResponse(res, "You are banned from this session", 403);
    }

    const existingParticipant = await liveSessionParticipantModel.findOne({
      sessionId,
      userId,
      deviceSessionId,
    });
    if (existingParticipant) {
      return sendErrorResponse(res, "Already joined", 400);
    }

    const participant = new liveSessionParticipantModel({
      sessionId,
      userId,
      deviceSessionId,
      role,
      socketId,
      networkStats,
      engagementStats,
      geoLocation,
    });
    await participant.save();

    session.participants.push(userId);
    await session.save();

    // ✅ Inform socket (client will continue WebRTC flow using socket events)
    getIO().to(socketId).emit("participant_joined", {
      userId,
      sessionId,
      role,
    });

    return sendSuccessResponse(
      res,
      participant,
      "Participant joined successfully",
      200
    );
  } catch (error) {
    return sendErrorResponse(res, error.message, 500);
  }
};




// ===========================
// Leave Participant
// ===========================
export const leaveParticipant = async (req, res) => {
  try {
    const { sessionId, deviceSessionId } = req.body;
    const participantId = req.tokenData._id;

    const participant = await liveSessionParticipantModel.findOne({
      sessionId,
      participantId,
      deviceSessionId,
    });

    if (!participant) {
      return sendErrorResponse(res, "Participant not found", 404);
    }

    // Transport cleanup
    if (global.transports?.[sessionId]?.[deviceSessionId]) {
      try {
        await global.transports[sessionId][deviceSessionId].close();
      } catch {}
      delete global.transports[sessionId][deviceSessionId];
    }

    // Remove participant
    await liveSessionModel.findByIdAndUpdate(sessionId, {
      $pull: { participants: participant._id },
    });
    await participant.remove();

    getIO().to(sessionId).emit("participant:leave", { participantId });

    return sendSuccessResponse(res, null, "Left session", 200);
  } catch (error) {
    return sendErrorResponse(res, error.message, 500);
  }
};


// ===========================
// Kick Participant
// ===========================
export const kickParticipant = async (req, res) => {
  try {
    const { sessionId, participantId } = req.body;

    const participant = await liveSessionParticipantModel.findOne({
      sessionId,
      participantId,
    });
    if (!participant) {
      return sendErrorResponse(res, "Participant not found", 404);
    }

    // Cleanup transport
    if (global.transports?.[sessionId]?.[participant.deviceSessionId]) {
      try {
        await global.transports[sessionId][
          participant.deviceSessionId
        ].close();
      } catch {}
      delete global.transports[sessionId][participant.deviceSessionId];
    }

    await liveSessionModel.findByIdAndUpdate(sessionId, {
      $pull: { participants: participant._id },
    });
    await participant.remove();

    getIO().to(sessionId).emit("participant:kicked", { participantId });

    return sendSuccessResponse(res, null, "Participant kicked", 200);
  } catch (error) {
    return sendErrorResponse(res, error.message, 500);
  }
};

// ===========================
// Toggle Ban Participant
// ===========================
export const toggleBanParticipant = async (req, res) => {
  try {
    const { sessionId, participantId } = req.body;
    const session = await liveSessionModel.findById(sessionId);

    if (!session) {
      return sendErrorResponse(res, "Session not found", 404);
    }

    const isBanned = session.bannedParticipants.includes(participantId);
    if (isBanned) {
      session.bannedParticipants.pull(participantId);
      await session.save();
      return sendSuccessResponse(res, null, "Participant unbanned", 200);
    } else {
      session.bannedParticipants.push(participantId);
      await session.save();

      // Transport cleanup
      if (global.transports?.[sessionId]?.[participantId]) {
        try {
          await global.transports[sessionId][participantId].close();
        } catch {}
        delete global.transports[sessionId][participantId];
      }

      return sendSuccessResponse(res, null, "Participant banned", 200);
    }
  } catch (error) {
    return sendErrorResponse(res, error.message, 500);
  }
};

// ===========================
// Get Session Participants
// ===========================
const getSessionByIdOrCode = async ({ sessionId, roomCode }) => {
    if (sessionId) return await liveSessionModel.findOne({ sessionId });
    if (roomCode) return await liveSessionModel.findOne({ roomCode, status: "ACTIVE" });
    return null;
};

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
// Helper Function
// ===========================
const findSessionAndParticipant = async ({ sessionId, roomCode, participantId, userId }) => {
    if (!participantId || !userId) return { error: errorEn.ALL_FIELDS_REQUIRED };

    const session = await getSessionByIdOrCode({ sessionId, roomCode });
    if (!session) return { error: errorEn.LIVE_SESSION_NOT_FOUND };

    const participant = await liveSessionParticipantModel.findOne({
        _id: participantId,
        sessionId: session.sessionId,
    });
    if (!participant) return { error: errorEn.LIVE_SESSION_PARTICIPANT_NOT_FOUND };

    return { session, participant };
};

// ===========================
// Update Engagement
// ===========================
export const updateEngagement = async (req, res) => {
    try {
        const { sessionId, roomCode, participantId } = req.params;
        const userId = req.tokenData?.userId;
        const updates = req.body;

        const { error, session, participant } =
            await findSessionAndParticipant({ sessionId, roomCode, participantId, userId });
        if (error) return sendErrorResponse(res, error, HttpStatus.BAD_REQUEST);

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

        // socket emit
        req.app.get("io")?.to(session.sessionId).emit("participant:engagementUpdated", {
            participantId: participant._id,
            updates,
        });

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

        const { error, session, participant } =
            await findSessionAndParticipant({ sessionId, roomCode, participantId, userId });
        if (error) return sendErrorResponse(res, error, HttpStatus.BAD_REQUEST);

        if (networkQuality !== undefined) participant.networkQuality = networkQuality;
        if (latency !== undefined) participant.latency = latency;
        if (jitter !== undefined) participant.jitter = jitter;
        if (packetLoss !== undefined) participant.packetLoss = packetLoss;

        participant.lastActiveAt = new Date();
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

        req.app.get("io")?.to(session.sessionId).emit("participant:networkUpdated", {
            participantId: participant._id,
            networkQuality: participant.networkQuality,
            latency: participant.latency,
            jitter: participant.jitter,
            packetLoss: participant.packetLoss,
        });

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

        const increment = Number(count);
        if (isNaN(increment)) return sendErrorResponse(res, "Chat count must be a valid number", HttpStatus.BAD_REQUEST);

        const { error, session, participant } =
            await findSessionAndParticipant({ sessionId, roomCode, participantId, userId });
        if (error) return sendErrorResponse(res, error, HttpStatus.BAD_REQUEST);

        participant.chatMessagesCount += increment;
        participant.lastActiveAt = new Date();

        participant.activityLog.push({
            type: "chat",
            value: `+${increment} message(s)`,
            actionBy: userId,
        });

        await participant.save();

        req.app.get("io")?.to(session.sessionId).emit("participant:chatUpdated", {
            participantId: participant._id,
            chatMessagesCount: participant.chatMessagesCount,
            lastActiveAt: participant.lastActiveAt,
        });

        return sendSuccessResponse(res, participant, "Chat count updated successfully", HttpStatus.OK);
    } catch (error) {
        console.error("Error in updateChatCount:", error);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};


// Connect transport
export const connectTransport = async (req, res) => {
  try {
    const { sessionId, deviceSessionId, dtlsParameters } = req.body;

    const transport = global.transports?.[sessionId]?.[deviceSessionId];
    if (!transport) return sendErrorResponse(res, "Transport not found", 404);

    await transport.connect({ dtlsParameters });
    return sendSuccessResponse(res, null, "Transport connected", 200);
  } catch (error) {
    return sendErrorResponse(res, error.message, 500);
  }
};

// Produce media
export const produce = async (req, res) => {
  try {
    const { sessionId, deviceSessionId, kind, rtpParameters } = req.body;

    const transport = global.transports?.[sessionId]?.[deviceSessionId];
    if (!transport) return sendErrorResponse(res, "Transport not found", 404);

    const producer = await transport.produce({ kind, rtpParameters });
    if (!global.producers) global.producers = {};
    if (!global.producers[sessionId]) global.producers[sessionId] = {};
    global.producers[sessionId][deviceSessionId] = producer;

    getIO()
      .to(sessionId)
      .emit("webrtc:newProducer", { producerId: producer.id, kind });

    return sendSuccessResponse(
      res,
      { producerId: producer.id },
      "Producer created",
      200
    );
  } catch (error) {
    return sendErrorResponse(res, error.message, 500);
  }
};

// Consume media
export const consume = async (req, res) => {
  try {
    const { sessionId, deviceSessionId, producerId, rtpCapabilities } = req.body;
    const router = global.mediasoupRouters?.[sessionId];
    if (!router) return sendErrorResponse(res, "Router not found", 404);

    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return sendErrorResponse(res, "Cannot consume", 400);
    }

    const transport = global.transports?.[sessionId]?.[deviceSessionId];
    if (!transport) return sendErrorResponse(res, "Transport not found", 404);

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: false,
    });

    return sendSuccessResponse(
      res,
      {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      },
      "Consumer created",
      200
    );
  } catch (error) {
    return sendErrorResponse(res, error.message, 500);
  }
};