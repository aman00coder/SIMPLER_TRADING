// services/socketUtils/whiteboard.utils.js
import { roomState } from "../socketState/roomState.js";
import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";

export const flushCanvasOps = async (sessionId) => {
  console.log(`Flushing canvas operations for session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || !state.whiteboardId) {
    console.log(`No state or whiteboardId found for session: ${sessionId}`);
    return;
  }
  
  const ops = state.pendingOps || [];
  if (!ops.length) {
    console.log(`No pending operations for session: ${sessionId}`);
    return;
  }
  
  console.log(`Flushing ${ops.length} operations for session: ${sessionId}`);
  state.pendingOps = [];
  
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }

  const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
  if (!wb) {
    console.log(`Whiteboard not found with ID: ${state.whiteboardId}`);
    return;
  }

  for (const op of ops) {
    if (op.type === "draw") wb.totalDrawActions = (wb.totalDrawActions || 0) + 1;
    if (op.type === "erase") wb.totalErases = (wb.totalErases || 0) + 1;

    wb.undoStack = [...(wb.undoStack || []), op].slice(-500);
    if (op.type === "draw" || op.type === "erase") wb.redoStack = [];
    if (op.patch) wb.canvasData = { ...(wb.canvasData || {}), ...op.patch };
  }

  wb.lastActivity = new Date();
  await wb.save();
  console.log(`Canvas operations flushed for session: ${sessionId}`);
};

export const scheduleFlush = (sessionId, op) => {
  console.log(`Scheduling flush for session: ${sessionId}, operation type: ${op?.type}`);
  const state = roomState.get(sessionId);
  if (!state) {
    console.log(`No state found for session: ${sessionId}`);
    return;
  }
  
  if (!state.pendingOps) state.pendingOps = [];
  state.pendingOps.push(op);
  
  if (state.flushTimer) {
    console.log(`Flush already scheduled for session: ${sessionId}`);
    return;
  }
  
  state.flushTimer = setTimeout(() => {
    flushCanvasOps(sessionId).catch(err => {
      console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
    });
  }, 2000);
  
  console.log(`Flush scheduled for session: ${sessionId}`);
};

// Whiteboard specific utility functions
export const getWhiteboardState = async (whiteboardId) => {
  try {
    const wb = await whiteboardModel.findOne({ whiteboardId });
    return wb;
  } catch (error) {
    console.error("Error getting whiteboard state:", error);
    return null;
  }
};

export const updateWhiteboardParticipants = async (whiteboardId, userId, role = "viewer") => {
  try {
    const wb = await whiteboardModel.findOne({ whiteboardId });
    if (!wb) return null;

    const existingParticipant = wb.participants.find(p => p.user.toString() === userId);
    if (!existingParticipant) {
      wb.participants.push({ 
        user: userId, 
        role: role,
        joinedAt: new Date(),
        status: "ACTIVE"
      });
    } else {
      existingParticipant.role = role;
      existingParticipant.status = "ACTIVE";
      existingParticipant.lastActivity = new Date();
    }

    await wb.save();
    return wb;
  } catch (error) {
    console.error("Error updating whiteboard participants:", error);
    return null;
  }
};

export const removeWhiteboardParticipant = async (whiteboardId, userId) => {
  try {
    const wb = await whiteboardModel.findOne({ whiteboardId });
    if (!wb) return null;

    const participant = wb.participants.find(p => p.user.toString() === userId);
    if (participant) {
      participant.status = "LEFT";
      participant.leftAt = new Date();
      await wb.save();
    }

    return wb;
  } catch (error) {
    console.error("Error removing whiteboard participant:", error);
    return null;
  }
};