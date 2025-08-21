import mongoose from "mongoose";
import HttpStatus from "http-status-codes";
import { v4 as uuidv4 } from "uuid";
import whiteBoardModel from "../../model/whiteBoards/whiteBoard.model.js"
import * as commonServices from "../../services/common.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { genPassword } from "../../utils/password.js";
import { deleteFileFromS3 } from "../../middleware/aws.s3.js";
import { initWhiteboardRTC } from "../../services/socket.webrtc.js"; 

/* =======================
   Utilities (compact & fast)
   ======================= */
  
const safeJsonParse = (val, fallback = null) => {
  if (val === undefined || val === null) return fallback;
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
};

const toBoolean = (val, fallback = false) => {
  if (val === undefined || val === null) return fallback;
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return !!val;
  if (typeof val === "string") return val.toLowerCase() === "true";
  return fallback;
};

const toNumber = (val, fallback = 0) => {
  if (val === undefined || val === null || val === "") return fallback;
  const n = Number(val);
  return Number.isNaN(n) ? fallback : n;
};

const isObjectId = (val) => mongoose.Types.ObjectId.isValid(val);

/**
 * Convert array of items where item[key] is an id string to ObjectId form.
 * Returns same array if invalid input.
 */
const convertObjectIdArray = (arr, key) => {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => {
      if (!item || typeof item !== "object" || !item[key]) return null;
      const id = item[key];
      if (isObjectId(id)) return { ...item, [key]: new mongoose.Types.ObjectId(id) };
      return null;
    })
    .filter(Boolean);
};

/**
 * Build file objects from multer `req.files[field]` entries.
 * Each file => { fileName, fileUrl, fileType, uploadedBy, uploadedAt }
 */
const buildUploadedFiles = (fileEntries = [], uploaderId) => {
  if (!Array.isArray(fileEntries) || fileEntries.length === 0) return [];
  return fileEntries.map((f) => ({
    fileName: f.originalname,
    fileUrl: f.location || f.path,
    fileType: f.mimetype,
    uploadedBy: uploaderId,
    uploadedAt: new Date(),
  }));
};

/**
 * Delete S3 files present in oldFiles but not in newFiles (based on fileUrl).
 * Runs deletions concurrently and swallows errors (logs only).
 */
const deleteRemovedFiles = async (oldFiles = [], newFiles = []) => {
  if (!Array.isArray(oldFiles) || oldFiles.length === 0) return;
  if (!Array.isArray(newFiles)) newFiles = [];
  const oldUrls = oldFiles.map((f) => f.fileUrl).filter(Boolean);
  const newUrls = newFiles.map((f) => f.fileUrl).filter(Boolean);
  const toDelete = oldUrls.filter((u) => !newUrls.includes(u));
  if (toDelete.length === 0) return;
  await Promise.all(
    toDelete.map(async (url) => {
      try {
        await deleteFileFromS3(url);
      } catch (err) {
        console.warn("Failed to delete file from S3:", url, err?.message || err);
      }
    })
  );
};

/* =======================
   CREATE WHITEBOARD
   ======================= */

export const createWhiteboard = async (req, res) => {
  try {
    const createdBy = req.tokenData?.userId;
    const createdByRole = req.tokenData?.role;

    if (!createdBy)
      return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.UNAUTHORIZED);

    const body = { ...req.body };

    // parse fields safely
    const parseWithLog = (key, fallback) => safeJsonParse(body[key], fallback);

    let participants = parseWithLog("participants", []);
    const canvasData = parseWithLog("canvasData", {});
    const liveStream = parseWithLog("liveStream", {});
    const chatHistory = parseWithLog("chatHistory", []);
    const versionHistory = parseWithLog("versionHistory", []);
    const tags = parseWithLog("tags", []);
    const filesFromBody = parseWithLog("files", []);
    const whiteboardUrlFromBody = parseWithLog("whiteboardUrl", []);
    const recordingUrlFromBody = parseWithLog("recordingUrl", []);
    const toolSettings = parseWithLog("toolSettings", {});

    const maxParticipants = toNumber(body.maxParticipants, 20);
    const isActive = toBoolean(body.isActive, true);
    const isPublic = toBoolean(body.isPublic, false);
    const passwordProtected = toBoolean(body.passwordProtected, false);
    const isArchived = toBoolean(body.isArchived, false);

    // multer files
    const uploadedWhiteboardUrl = buildUploadedFiles(req.files?.whiteboardUrl, createdBy);
    const uploadedRecordingUrl = buildUploadedFiles(req.files?.recordingUrl, createdBy);
    const uploadedFiles = [
      ...buildUploadedFiles(req.files?.file, createdBy),
      ...buildUploadedFiles(req.files?.files, createdBy),
    ];

    const dedupeFiles = (arr) => {
      const seen = new Set();
      return arr.filter((f) => f?.fileUrl && !seen.has(f.fileUrl) && seen.add(f.fileUrl));
    };

    const whiteboardUrl = dedupeFiles([...whiteboardUrlFromBody, ...uploadedWhiteboardUrl]);
    const recordingUrl = dedupeFiles([...recordingUrlFromBody, ...uploadedRecordingUrl]);
    const files = dedupeFiles([...filesFromBody, ...uploadedFiles]);

    const participantsObj = convertObjectIdArray(participants, "user");
    const chatHistoryObj = convertObjectIdArray(chatHistory, "sender");
    const versionHistoryObj = convertObjectIdArray(versionHistory, "updatedBy");

    if (!participantsObj.find(p => p.user.toString() === createdBy.toString()))
      participantsObj.push({ user: new mongoose.Types.ObjectId(createdBy), role: "owner" });

    const clonedFrom = body.clonedFrom && isObjectId(body.clonedFrom)
      ? new mongoose.Types.ObjectId(body.clonedFrom)
      : null;

    let boardPassword = null, whiteboardPassword = null;
    if (passwordProtected) {
      if (!body.boardPassword && !body.whiteboardPassword)
        return sendErrorResponse(res, errorEn.WHITEBOARD_PASSWORD_REQUIRED, HttpStatus.BAD_REQUEST);
      if (body.boardPassword) boardPassword = await genPassword(body.boardPassword);
      if (body.whiteboardPassword) whiteboardPassword = await genPassword(body.whiteboardPassword);
    }

    const lastActivity = body.lastActivity ? new Date(body.lastActivity) : new Date();
    const totalEdits = toNumber(body.totalEdits, 0);
    const totalMessages = toNumber(body.totalMessages, 0);
    const activeUsersCount = toNumber(body.activeUsersCount, 0);

    // validations
    const validations = [
      [!body.title, errorEn.WHITEBOARD_TITLE_REQUIRED],
      [!body.whiteboardType, errorEn.WHITEBOARD_TYPE_REQUIRED],
      [!participantsObj || participantsObj.length === 0, errorEn.WHITEBOARD_PARTICIPANTS_REQUIRED],
      [!body.currentSessionId, errorEn.WHITEBOARD_SESSIONID_REQUIRED],
      [!["public", "private", "restricted"].includes(body.accessType), errorEn.WHITEBOARD_ACCESS_TYPE_REQUIRED],
      [!["active", "archived"].includes(body.status), errorEn.WHITEBOARD_STATUS_REQUIRED],
      [!canvasData, errorEn.WHITEBOARD_CANVAS_REQUIRED],
      [maxParticipants <= 0, errorEn.WHITEBOARD_MAX_PARTICIPANTS_REQUIRED],
    ];
    for (const [fail, msg] of validations) if (fail) return sendErrorResponse(res, msg, HttpStatus.BAD_REQUEST);

    if (liveStream && Object.keys(liveStream).length > 0) {
      if (typeof liveStream.isLive !== "boolean")
        return sendErrorResponse(res, errorEn.WHITEBOARD_LIVESTREAM_REQUIRED, HttpStatus.BAD_REQUEST);
      if (liveStream.isLive && !liveStream.streamUrl)
        return sendErrorResponse(res, errorEn.WHITEBOARD_LIVESTREAM_REQUIRED, HttpStatus.BAD_REQUEST);
      if (liveStream.isLive && !body.currentSessionId)
        return sendErrorResponse(res, errorEn.WHITEBOARD_SESSIONID_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    const dataToSave = {
      whiteboardId: body.whiteboardId || uuidv4(),
      title: body.title,
      description: body.description,
      createdBy,
      createdByRole,
      participants: participantsObj,
      canvasData,
      toolSettings,
      selectedTool: body.selectedTool || "pen",
      layers: parseWithLog("layers", []),
      undoStack: parseWithLog("undoStack", []),
      redoStack: parseWithLog("redoStack", []),
      liveStream,
      chatHistory: chatHistoryObj,
      typingStatus: parseWithLog("typingStatus", []),
      cursorHistory: parseWithLog("cursorHistory", []),
      files,
      versionHistory: versionHistoryObj,
      versionTags: parseWithLog("versionTags", []),
      isActive,
      isPublic,
      accessType: body.accessType,
      clonedFrom,
      passwordProtected,
      boardPassword,
      whiteboardPassword,
      maxParticipants,
      whiteboardUrl,
      whiteboardType: body.whiteboardType,
      whiteboardSubType: body.whiteboardSubType || null,
      lastActivity,
      totalEdits,
      totalMessages,
      totalDrawActions: toNumber(body.totalDrawActions, 0),
      totalErases: toNumber(body.totalErases, 0),
      totalFilesUploaded: toNumber(body.totalFilesUploaded, 0),
      totalViewers: toNumber(body.totalViewers, 0),
      tags,
      tagsDetailed: parseWithLog("tagsDetailed", []),
      recordingUrl,
      replayAvailable: toBoolean(body.replayAvailable, false),
      replayData: parseWithLog("replayData", {}),
      isArchived,
      currentSessionId: body.currentSessionId,
      activeUsersCount,
      status: body.status,
    };

    const created = await commonServices.create(whiteBoardModel, dataToSave);
    if (!created) return sendErrorResponse(res, errorEn.WHITEBOARD_NOT_CREATED, HttpStatus.BAD_REQUEST);

    initWhiteboardRTC(created.whiteboardId, created._id, createdBy);

    const safeResponse = created.toObject();
    delete safeResponse.boardPassword;
    delete safeResponse.whiteboardPassword;

    return sendSuccessResponse(res, safeResponse, successEn.WHITEBOARD_CREATED, HttpStatus.CREATED);

  } catch (err) {
    console.error("🔥 createWhiteboard error:", err);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};




/* =======================
   GET WHITEBOARD
   ======================= */


export const getAllWhiteboards = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    // Filters
    const filters = {};
    if (req.query.isActive !== undefined) filters.isActive = req.query.isActive === "true";
    if (req.query.isArchived !== undefined) filters.isArchived = req.query.isArchived === "true";
    if (req.query.status) filters.status = req.query.status;
    if (req.query.accessType) filters.accessType = req.query.accessType;
    if (req.query.createdBy) filters.createdBy = req.query.createdBy;

    // Populate related fields (all fields)
    const populateFields = [
      { path: "createdBy" },
      { path: "participants.user" },
      { path: "versionHistory.updatedBy" },
      // { path: "favoriteBy" },
      // { path: "projectId" },
      // { path: "clonedFrom" }
    ];

    // Fetch whiteboards
    const whiteboards = await whiteBoardModel
      .find(filters)
      .populate(populateFields)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Remove sensitive fields
    const whiteboardsSafe = whiteboards.map(wb => {
      delete wb.boardPassword;
      delete wb.whiteboardPassword;
      return wb;
    });

    const total = await commonServices.count(whiteBoardModel, filters);

    return sendSuccessResponse(
      res,
      {
        data: whiteboardsSafe,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      successEn.WHITEBOARD_FETCHED,
      HttpStatus.OK
    );

  } catch (err) {
    console.error("🔥 getAllWhiteboards error:", err);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


/* =======================
   GET SINGLE WHITEBOARD
   ======================= */

export const getSingleWhiteboard = async (req, res) => {
  try {
    const { whiteboardId } = req.params;

    if (!whiteboardId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    const query = isObjectId(whiteboardId)
      ? { _id: new mongoose.Types.ObjectId(whiteboardId) }
      : { whiteboardId };

    // Populate related fields (all data, no select)
    const populateFields = [
      { path: "createdBy" },
      { path: "participants.user" },
      { path: "versionHistory.updatedBy" },
      // { path: "favoriteBy" },
      // { path: "projectId" },
      // { path: "clonedFrom" }
    ];

    const whiteboard = await whiteBoardModel
      .findOne(query)
      .populate(populateFields)
      .lean();

    if (!whiteboard) {
      return sendErrorResponse(res, errorEn.WHITEBOARD_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // Remove sensitive fields
    delete whiteboard.boardPassword;
    delete whiteboard.whiteboardPassword;

    return sendSuccessResponse(res, whiteboard, successEn.WHITEBOARD_FETCHED, HttpStatus.OK);

  } catch (err) {
    console.error("🔥 getSingleWhiteboard error:", err);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};




/* =======================;
   UPDATE WHITEBOARD
   ======================= */

export const updateWhiteBoard = async (req, res) => {
  try {
    const { whiteboardId } = req.params;
    const updatedBy = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    if (!whiteboardId) return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);

    const query = isObjectId(whiteboardId)
      ? { _id: new mongoose.Types.ObjectId(whiteboardId) }
      : { whiteboardId };

    const existingWhiteboard = await commonServices.findOne(whiteBoardModel, query);
    if (!existingWhiteboard) return sendErrorResponse(res, errorEn.WHITEBOARD_NOT_FOUND, HttpStatus.NOT_FOUND);

    // permission checks
    if (userRole === 3) return sendErrorResponse(res, errorEn.WHITEBOARD_ACCESS_STUDENT_DENIED, HttpStatus.FORBIDDEN);
    if (userRole === 2 && ![1, 2].includes(existingWhiteboard.createdByRole)) {
      return sendErrorResponse(res, errorEn.WHITEBOARD_ACCESS_TEACHER_DENIED, HttpStatus.FORBIDDEN);
    }

    const body = { ...req.body };

    // parse incoming fields or fallback
    const parseOrExisting = (key, fallback) => {
      const val = body[key];
      if (val === undefined) return fallback;
      const parsed = safeJsonParse(val, val);
      return parsed === null ? fallback : parsed;
    };

    let participantsRaw = parseOrExisting("participants", existingWhiteboard.participants);
    const canvasData = parseOrExisting("canvasData", existingWhiteboard.canvasData);
    const liveStream = parseOrExisting("liveStream", existingWhiteboard.liveStream);
    const chatHistoryRaw = parseOrExisting("chatHistory", existingWhiteboard.chatHistory);
    const versionHistoryRaw = parseOrExisting("versionHistory", existingWhiteboard.versionHistory);
    const tags = parseOrExisting("tags", existingWhiteboard.tags);
    const filesFromBody = parseOrExisting("files", existingWhiteboard.files);
    const whiteboardUrlFromBody = parseOrExisting("whiteboardUrl", existingWhiteboard.whiteboardUrl);
    const recordingUrlFromBody = parseOrExisting("recordingUrl", existingWhiteboard.recordingUrl);

    const isActive = toBoolean(body.isActive, existingWhiteboard.isActive);
    const isPublic = toBoolean(body.isPublic, existingWhiteboard.isPublic);
    const passwordProtected = toBoolean(body.passwordProtected, existingWhiteboard.passwordProtected);
    const isArchived = toBoolean(body.isArchived, existingWhiteboard.isArchived);
    const maxParticipants = toNumber(body.maxParticipants, existingWhiteboard.maxParticipants);

    // process uploaded files
    const uploadedWhiteboardUrl = buildUploadedFiles(req.files?.whiteboardUrl, updatedBy);
    const uploadedRecordingUrl = buildUploadedFiles(req.files?.recordingUrl, updatedBy);
    const uploadedFiles = [
      ...buildUploadedFiles(req.files?.file, updatedBy),
      ...buildUploadedFiles(req.files?.files, updatedBy),
    ];

    // merge + dedupe arrays
    const dedupeFiles = (arr) => {
      const seen = new Set();
      return arr.filter(f => f?.fileUrl && !seen.has(f.fileUrl) && seen.add(f.fileUrl));
    };
    const whiteboardUrl = dedupeFiles([...whiteboardUrlFromBody, ...uploadedWhiteboardUrl]);
    const recordingUrl = dedupeFiles([...recordingUrlFromBody, ...uploadedRecordingUrl]);
    const files = dedupeFiles([...filesFromBody, ...uploadedFiles]);

    // convert ids
    let participants = convertObjectIdArray(participantsRaw, "user");
    const chatHistory = convertObjectIdArray(chatHistoryRaw, "sender");
    const versionHistory = convertObjectIdArray(versionHistoryRaw, "updatedBy");

    // ensure creator is always a participant
    if (!participants.find(p => p.user.toString() === existingWhiteboard.createdBy.toString())) {
      participants.push({ user: new mongoose.Types.ObjectId(existingWhiteboard.createdBy), role: "owner" });
    }

    const clonedFrom = body.clonedFrom && isObjectId(body.clonedFrom)
      ? new mongoose.Types.ObjectId(body.clonedFrom)
      : existingWhiteboard.clonedFrom || null;

    // password hashing
    let boardPassword = existingWhiteboard.boardPassword || null;
    let whiteboardPassword = existingWhiteboard.whiteboardPassword || null;

    if (passwordProtected) {
      const promises = [];
      if (body.boardPassword) promises.push(genPassword(body.boardPassword));
      else promises.push(Promise.resolve(boardPassword));

      if (body.whiteboardPassword) promises.push(genPassword(body.whiteboardPassword));
      else promises.push(Promise.resolve(whiteboardPassword));

      const [bHash, wHash] = await Promise.all(promises);
      boardPassword = bHash;
      whiteboardPassword = wHash;
    } else {
      boardPassword = null;
      whiteboardPassword = null;
    }

    // Dates & numbers fallback
    const lastActivity = body.lastActivity ? new Date(body.lastActivity) : existingWhiteboard.lastActivity;
    const totalEdits = body.totalEdits !== undefined ? toNumber(body.totalEdits, existingWhiteboard.totalEdits) : existingWhiteboard.totalEdits;
    const totalMessages = body.totalMessages !== undefined ? toNumber(body.totalMessages, existingWhiteboard.totalMessages) : existingWhiteboard.totalMessages;
    const activeUsersCount = body.activeUsersCount !== undefined ? toNumber(body.activeUsersCount, existingWhiteboard.activeUsersCount) : existingWhiteboard.activeUsersCount;

    const dataToUpdate = {
      title: body.title ?? existingWhiteboard.title,
      description: body.description ?? existingWhiteboard.description,
      participants,
      canvasData,
      liveStream,
      chatHistory,
      files,
      versionHistory,
      isActive,
      isPublic,
      accessType: body.accessType ?? existingWhiteboard.accessType,
      clonedFrom,
      passwordProtected,
      boardPassword,
      whiteboardPassword,
      maxParticipants,
      whiteboardUrl,
      whiteboardType: body.whiteboardType ?? existingWhiteboard.whiteboardType,
      whiteboardSubType: body.whiteboardSubType ?? existingWhiteboard.whiteboardSubType,
      lastActivity,
      totalEdits,
      totalMessages,
      tags,
      recordingUrl,
      isArchived,
      currentSessionId: body.currentSessionId ?? existingWhiteboard.currentSessionId,
      activeUsersCount,
      status: body.status ?? existingWhiteboard.status,
      updatedAt: new Date(),
    };

    // delete removed files
    await Promise.all([
      deleteRemovedFiles(existingWhiteboard.whiteboardUrl || [], whiteboardUrl),
      deleteRemovedFiles(existingWhiteboard.recordingUrl || [], recordingUrl),
      deleteRemovedFiles(existingWhiteboard.files || [], files),
    ]);

    const updatedWhiteboard = await commonServices.findOneAndUpdate(whiteBoardModel, query, dataToUpdate);
    if (!updatedWhiteboard) return sendErrorResponse(res, errorEn.FAILED_TO_UPDATE, HttpStatus.CONFLICT);

    // emit to socket
    if (io && updatedWhiteboard.whiteboardId) {
      io.to(updatedWhiteboard.whiteboardId).emit("whiteboard_updated", {
        whiteboardId: updatedWhiteboard.whiteboardId,
        canvasData: updatedWhiteboard.canvasData,
        participants: updatedWhiteboard.participants,
        files: updatedWhiteboard.files
      });
    }

    const safeResponse = updatedWhiteboard.toObject();
    delete safeResponse.boardPassword;
    delete safeResponse.whiteboardPassword;

    return sendSuccessResponse(res, safeResponse, successEn.WHITEBOARD_UPDATED, HttpStatus.OK);

  } catch (err) {
    console.error("🔥 updateWhiteBoard error:", err);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


/* =======================
   SOFT DELETE WHITEBOARD (with S3 file deletion)
   ======================= */
export const softDeleteWhiteboard = async (req, res) => {
  try {
    const { whiteboardId } = req.params;

    if (!whiteboardId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    // whiteboardId can be ObjectId or custom string id
    const query = isObjectId(whiteboardId)
      ? { _id: new mongoose.Types.ObjectId(whiteboardId), isDeleted: { $ne: true } }
      : { whiteboardId, isDeleted: { $ne: true } };

    const entry = await whiteBoardModel.findOne(query);
    if (!entry) {
      return sendErrorResponse(res, errorEn.WHITEBOARD_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // ✅ Delete files from S3 if they exist
    const allFiles = [
      ...(entry.files || []),
      ...(entry.whiteboardUrl || []),
      ...(entry.recordingUrl || [])
    ];

    if (allFiles.length > 0) {
      await Promise.all(
        allFiles.map(async (file) => {
          if (file?.fileUrl) {
            try {
              await deleteFileFromS3(file.fileUrl);
            } catch (err) {
              console.warn("Failed to delete file from S3:", file.fileUrl, err?.message);
            }
          }
        })
      );
    }

    // Mark as deleted
    entry.isDeleted = true;
    entry.deletedAt = new Date();
    await entry.save();

    if (io && entry.whiteboardId) {
        io.to(entry.whiteboardId).emit("whiteboard_deleted", { whiteboardId: entry.whiteboardId });
    }
    
    return sendSuccessResponse(res, entry, successEn.WHITEBOARD_DELETED, HttpStatus.OK);
  } catch (err) {
    console.error("🔥 softDeleteWhiteboard error:", err);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

/* =======================
   RESTORE WHITEBOARD
   ======================= */
export const restoreWhiteboard = async (req, res) => {
  try {
    const { whiteboardId } = req.params;

    if (!whiteboardId) {
      return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
    }

    const query = isObjectId(whiteboardId)
      ? { _id: new mongoose.Types.ObjectId(whiteboardId), isDeleted: true }
      : { whiteboardId, isDeleted: true };

    const entry = await whiteBoardModel.findOne(query);
    if (!entry) {
      return sendErrorResponse(res, errorEn.NO_DELETED_WHITEBOARD, HttpStatus.NOT_FOUND);
    }

    entry.isDeleted = false;
    entry.deletedAt = null;
    await entry.save();

    // Emit realtime event if io available
    if (io && entry.whiteboardId) {
      io.to(entry.whiteboardId).emit("whiteboard_restored", { whiteboardId: entry.whiteboardId });
    }

    return sendSuccessResponse(res, entry, successEn.WHITEBOARD_RESTORED, HttpStatus.OK);
  } catch (err) {
    console.error("🔥 restoreWhiteboard error:", err);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


