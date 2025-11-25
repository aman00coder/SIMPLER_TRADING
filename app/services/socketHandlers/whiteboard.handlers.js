// services/socketHandlers/whiteboard.handlers.js
import { roomState } from "../socketState/roomState.js";
import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";
import { scheduleFlush, flushCanvasOps } from "../socketUtils/whiteboard.utils.js";

export const whiteboardHandlers = (socket, io) => {
  socket.on("whiteboard_draw", (data) => 
    whiteboardEventHandler(socket, io, data.sessionId, "draw", data.drawData, data.patch)
  );
  
  socket.on("whiteboard_erase", (data) => 
    whiteboardEventHandler(socket, io, data.sessionId, "erase", data.eraseData, data.patch)
  );
  
  socket.on("whiteboard_undo", (data) => 
    whiteboardUndoHandler(socket, io, data.sessionId)
  );
  
  socket.on("whiteboard_redo", (data) => 
    whiteboardRedoHandler(socket, io, data.sessionId)
  );
  
  socket.on("whiteboard_save", (data) => 
    whiteboardSaveCanvasHandler(socket, io, data.sessionId)
  );
  
  socket.on("whiteboard_cursor", (data) => 
    cursorUpdateHandler(socket, io, data.sessionId, data.position)
  );
  
  socket.on("whiteboard_state_request", (data) => 
    whiteboardStateRequestHandler(socket, io, data.sessionId)
  );
};

const whiteboardEventHandler = (socket, io, sessionId, type, data, patch) => {
  console.log(`Whiteboard ${type} from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || !state.whiteboardId) return;

  const meta = state.sockets.get(socket.id);
  if (!meta) return;

  socket.to(sessionId).emit(`whiteboard_${type}`, { 
    userId: meta.userId, 
    [`${type}Data`]: data 
  });
  
  scheduleFlush(sessionId, { type, payload: data, patch, at: new Date() });
};

const whiteboardUndoHandler = async (socket, io, sessionId) => {
  console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || !state.whiteboardId) return;

  const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
  if (!wb) return;

  const undoStack = wb.undoStack || [];
  if (undoStack.length === 0) return;

  const last = undoStack.pop();
  wb.undoStack = undoStack.slice(-500);
  wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
  wb.lastActivity = new Date();
  
  await wb.save();
  io.to(sessionId).emit("whiteboard_undo_applied", { last });
  console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
};

const whiteboardRedoHandler = async (socket, io, sessionId) => {
  console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || !state.whiteboardId) return;

  const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
  if (!wb) return;

  const redoStack = wb.redoStack || [];
  if (redoStack.length === 0) return;

  const last = redoStack.pop();
  wb.redoStack = redoStack.slice(-500);
  wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
  wb.lastActivity = new Date();
  
  await wb.save();
  io.to(sessionId).emit("whiteboard_redo_applied", { last });
  console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
};

const whiteboardSaveCanvasHandler = async (socket, io, sessionId) => {
  console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
  await flushCanvasOps(sessionId).catch(err => {
    console.error(`Error saving canvas for session ${sessionId}:`, err);
  });
  socket.emit("whiteboard_saved");
  console.log(`Whiteboard saved for session: ${sessionId}`);
};

const cursorUpdateHandler = (socket, io, sessionId, position) => {
  console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state) return;

  const meta = state.sockets.get(socket.id);
  if (!meta) return;

  socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
};

const whiteboardStateRequestHandler = async (socket, io, sessionId) => {
  console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
  const state = roomState.get(sessionId);
  if (!state || !state.whiteboardId) return;

  const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
  if (!wb) return;

  socket.emit("whiteboard_state_sync", {
    canvasData: wb.canvasData,
    participants: wb.participants,
    versionHistory: wb.versionHistory,
  });
  
  console.log(`Whiteboard state sent to socket: ${socket.id}`);
};