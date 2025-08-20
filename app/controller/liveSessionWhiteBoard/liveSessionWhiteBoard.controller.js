import mongoose from "mongoose";
import HttpStatus from "http-status-codes";
import { v4 as uuidv4 } from "uuid";
import liveSessionModel from "../../model/LiveSessions/liveSession.model.js";
import whiteBoardModel from "../../model/whiteBoards/whiteBoard.model.js";
import * as commonServices from "../../services/common.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { getIO } from "../../services/socket.webrtc.js"; 
import { ROLE_MAP } from "../../constant/role.js";

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

export const saveliveSessionRecording = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.tokenData?.userId;

    if (!sessionId || !userId) {
      return sendErrorResponse(
        res,
        errorEn.ALL_FIELDS_REQUIRED,
        HttpStatus.BAD_REQUEST
      );
    }

    const sessionExists = await liveSessionModel.findOne({ sessionId });
    if (!sessionExists) {
      return sendErrorResponse(
        res,
        errorEn.LIVE_SESSION_NOT_FOUND,
        HttpStatus.NOT_FOUND
      );
    }

    // 🟢 Uploaded files from form-data
    const recordings = buildUploadedFiles(
      req.files?.recording || req.files?.recordingUrl, 
      userId
    );
    const files = buildUploadedFiles(
      req.files?.files || req.files?.file, 
      userId
    );

    console.log("🎯 Incoming recordings:", recordings);
    console.log("🎯 Incoming files:", files);

    // 🟢 Find existing whiteboard
    const whiteboard = await whiteBoardModel.findOne({ currentSessionId: sessionId });
    if (!whiteboard) {
      return sendErrorResponse(res, errorEn.WHITEBOARD_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    console.log("📂 Existing recordings in DB:", whiteboard.recordingUrl);
    console.log("📂 Existing files in DB:", whiteboard.files);

    // 🟢 Already saved urls
    const existingRecordingUrls = new Set(whiteboard.recordingUrl.map(f => f.fileUrl));
    const existingFileUrls = new Set(whiteboard.files.map(f => f.fileUrl));

    // 🟢 Filter new
    const newRecordings = (recordings || []).filter(f => !existingRecordingUrls.has(f.fileUrl));
    const newFiles = (files || []).filter(f => !existingFileUrls.has(f.fileUrl));

    console.log("🆕 New recordings to save:", newRecordings);
    console.log("🆕 New files to save:", newFiles);

    // 🟢 Append only new ones
    if (newRecordings.length > 0) {
      whiteboard.recordingUrl.push(...newRecordings);
    }
    if (newFiles.length > 0) {
      whiteboard.files.push(...newFiles);
    }

    whiteboard.updatedAt = new Date();
    await whiteboard.save();

    console.log("✅ Whiteboard after save:", whiteboard);

    return sendSuccessResponse(
      res,
      {
        whiteboard,
        newlyAdded: {
          recordings: newRecordings,
          files: newFiles,
        },
      },
      successEn.WHITEBOARD_UPDATED,
      HttpStatus.OK
    );
  } catch (error) {
    console.error("❌ Error in saveliveSessionRecording:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


export const getAllLiveSessionRecording = async (req, res) => {
    try {
        const { sessionId } = req.params;

        if (!sessionId) {
            return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
        }

        // ✅ Step 1: Check session exist karta hai ya nahi
        const sessionExists = await liveSessionModel.findOne({ sessionId });
        if (!sessionExists) {
            return sendErrorResponse(res, errorEn.LIVE_SESSION_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        // ✅ Step 2: Session se related whiteboard fetch karo
        const whiteBoard = await whiteBoardModel.findOne({ currentSessionId: sessionId });
        if (!whiteBoard) {
            return sendErrorResponse(res, errorEn.WHITEBOARD_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        // ✅ Step 3: Whiteboard ke andar se recordings aur files return karo
        const data = {
            recordings: whiteBoard.recordingUrl || [],
            files: whiteBoard.files || []
        };

        return sendSuccessResponse(res, data, successEn.DETAILS_FETCH, HttpStatus.OK);

    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};


export const saveWhiteBoardRecording = async (req, res) => {
    try {
        const { whiteBoardId } = req.params;
        const userId = req.tokenData?.userId;

        if (!whiteBoardId || !userId) {
            return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
        }
        const existingWhiteboard = await whiteBoardModel.findOne({ whiteboardId: whiteBoardId });
        if (!existingWhiteboard) {
            return sendErrorResponse(res, errorEn.WHITEBOARD_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        const uploadedRecordings = buildUploadedFiles(req.files?.recording, userId);
        const uploadedFiles = buildUploadedFiles(req.files?.files, userId);

        const dedupeFiles = (arr) => {
            const seen = new Set();
            return arr.filter(f => f?.fileUrl && !seen.has(f.fileUrl) && seen.add(f.fileUrl));
        };

        const newRecordingUrl = dedupeFiles([...existingWhiteboard.recordingUrl, ...uploadedRecordings]);
        const newFiles = dedupeFiles([...existingWhiteboard.files, ...uploadedFiles]);

        // ✅ Update whiteboard document
        existingWhiteboard.recordingUrl = newRecordingUrl;
        existingWhiteboard.files = newFiles;
        await existingWhiteboard.save();

        return sendSuccessResponse(res, existingWhiteboard, successEn.WHITEBOARD_UPDATED, HttpStatus.OK);
    } catch (error) {
        console.log(error.message)
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);  
    }
}

export const getWhiteBoardRecording = async (req, res) => {
    try {
        const { whiteBoardId } = req.params;

        if (!whiteBoardId) {
            return sendErrorResponse(res, errorEn.ALL_FIELDS_REQUIRED, HttpStatus.BAD_REQUEST);
        }

        const whiteBoard = await whiteBoardModel.findOne({ whiteboardId: whiteBoardId });
        if (!whiteBoard) {
            return sendErrorResponse(res, errorEn.WHITEBOARD_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        const data = {
            recordings: whiteBoard.recordingUrl || [],
            files: whiteBoard.files || []
        };

        return sendSuccessResponse(res, data, successEn.DETAILS_FETCH, HttpStatus.OK);

    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};
