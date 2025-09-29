// import whiteboardModel from "../../model/whiteBoards/whiteBoard.model.js";

// export const flushCanvasOps = async (sessionId, roomState) => {
//   console.log(`Flushing canvas operations for session: ${sessionId}`);
//   const state = roomState.getRoom(sessionId);
//   if (!state || !state.whiteboardId) {
//     console.log(`No state or whiteboardId found for session: ${sessionId}`);
//     return;
//   }
  
//   const ops = state.pendingOps || [];
//   if (!ops.length) {
//     console.log(`No pending operations for session: ${sessionId}`);
//     return;
//   }
  
//   console.log(`Flushing ${ops.length} operations for session: ${sessionId}`);
//   state.pendingOps = [];
  
//   if (state.flushTimer) {
//     clearTimeout(state.flushTimer);
//     state.flushTimer = null;
//   }

//   const wb = await whiteboardModel.findOne({ whiteboardId: state.whiteboardId });
//   if (!wb) {
//     console.log(`Whiteboard not found with ID: ${state.whiteboardId}`);
//     return;
//   }

//   for (const op of ops) {
//     if (op.type === "draw") wb.totalDrawActions = (wb.totalDrawActions || 0) + 1;
//     if (op.type === "erase") wb.totalErases = (wb.totalErases || 0) + 1;

//     wb.undoStack = [...(wb.undoStack || []), op].slice(-500);
//     if (op.type === "draw" || op.type === "erase") wb.redoStack = [];
//     if (op.patch) wb.canvasData = { ...(wb.canvasData || {}), ...op.patch };
//   }

//   wb.lastActivity = new Date();
//   await wb.save();
//   console.log(`Canvas operations flushed for session: ${sessionId}`);
// };

// export const scheduleFlush = (sessionId, op, roomState) => {
//   console.log(`Scheduling flush for session: ${sessionId}, operation type: ${op?.type}`);
//   const state = roomState.getRoom(sessionId);
//   if (!state) {
//     console.log(`No state found for session: ${sessionId}`);
//     return;
//   }
  
//   if (!state.pendingOps) state.pendingOps = [];
//   state.pendingOps.push(op);
  
//   if (state.flushTimer) {
//     console.log(`Flush already scheduled for session: ${sessionId}`);
//     return;
//   }
  
//   state.flushTimer = setTimeout(() => {
//     flushCanvasOps(sessionId, roomState).catch(err => {
//       console.error(`Error flushing canvas operations for session ${sessionId}:`, err);
//     });
//   }, 2000);
  
//   console.log(`Flush scheduled for session: ${sessionId}`);
// };

// export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy, roomState) => {
//   console.log(`Initializing whiteboard RTC for session: ${sessionId}, whiteboard: ${whiteboardId}, createdBy: ${createdBy}`);
  
//   if (!roomState.hasRoom(sessionId)) {
//     roomState.createRoom(sessionId, {
//       whiteboardId,
//       createdBy,
//     });
//     console.log(`New room state created for session: ${sessionId}`);
//   } else {
//     const s = roomState.getRoom(sessionId);
//     s.whiteboardId = s.whiteboardId || whiteboardId;
//     s.createdBy = s.createdBy || createdBy;
//     console.log(`Existing room state updated for session: ${sessionId}`);
//   }
  
//   return roomState.getRoom(sessionId);
// };