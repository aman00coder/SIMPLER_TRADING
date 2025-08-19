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

