// import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";
// import { scheduleFlush, flushCanvasOps } from "../socketUtils/whiteboard.utils.js";

// export const whiteboardEventHandler = (socket, sessionId, type, data, patch, io, roomState) => {
//   console.log(`Whiteboard ${type} from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.getRoom(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit(`whiteboard_${type}`, { 
//     userId: meta.userId, 
//     [`${type}Data`]: data 
//   });
  
//   scheduleFlush(sessionId, { type, payload: data, patch, at: new Date() }, roomState);
// };

// export const whiteboardUndoHandler = async (socket, sessionId, io, roomState) => {
//   console.log(`Whiteboard undo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.getRoom(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const undoStack = wb.undoStack || [];
//   if (undoStack.length === 0) return;

//   const last = undoStack.pop();
//   wb.undoStack = undoStack.slice(-500);
//   wb.redoStack = [...(wb.redoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_undo_applied", { last });
//   console.log(`Undo applied to whiteboard: ${state.whiteboardId}`);
// };

// export const whiteboardRedoHandler = async (socket, sessionId, io, roomState) => {
//   console.log(`Whiteboard redo from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.getRoom(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   const redoStack = wb.redoStack || [];
//   if (redoStack.length === 0) return;

//   const last = redoStack.pop();
//   wb.redoStack = redoStack.slice(-500);
//   wb.undoStack = [...(wb.undoStack || []), last].slice(-500);
//   wb.lastActivity = new Date();
  
//   await wb.save();
//   io.to(sessionId).emit("whiteboard_redo_applied", { last });
//   console.log(`Redo applied to whiteboard: ${state.whiteboardId}`);
// };

// export const whiteboardSaveCanvasHandler = async (socket, sessionId, roomState) => {
//   console.log(`Whiteboard save request from socket: ${socket.id}, session: ${sessionId}`);
//   await flushCanvasOps(sessionId, roomState).catch(err => {
//     console.error(`Error saving canvas for session ${sessionId}:`, err);
//   });
//   socket.emit("whiteboard_saved");
//   console.log(`Whiteboard saved for session: ${sessionId}`);
// };

// export const cursorUpdateHandler = (socket, sessionId, position, io, roomState) => {
//   console.log(`Cursor update from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.getRoom(sessionId);
//   if (!state) return;

//   const meta = state.sockets.get(socket.id);
//   if (!meta) return;

//   socket.to(sessionId).emit("cursor_update", { userId: meta.userId, position });
// };

// export const whiteboardStateRequestHandler = async (socket, sessionId, roomState) => {
//   console.log(`Whiteboard state request from socket: ${socket.id}, session: ${sessionId}`);
//   const state = roomState.getRoom(sessionId);
//   if (!state || !state.whiteboardId) return;

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) return;

//   socket.emit("whiteboard_state_sync", {
//     canvasData: wb.canvasData,
//     participants: wb.participants,
//     versionHistory: wb.versionHistory,
//   });
  
//   console.log(`Whiteboard state sent to socket: ${socket.id}`);
// };