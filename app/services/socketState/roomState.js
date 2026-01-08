// services/socketState/roomState.js

export const roomState = new Map();

export const initWhiteboardRTC = (sessionId, whiteboardId, createdBy) => {
  console.log(
    `Initializing whiteboard RTC for session: ${sessionId}, whiteboard: ${whiteboardId}, createdBy: ${createdBy}`
  );

  if (!roomState.has(sessionId)) {
    roomState.set(sessionId, {
      whiteboardId,
      createdBy,

      streamerSocketId: null,
      viewers: new Set(),
      sockets: new Map(),
      participants: new Map(),

      pendingScreenShareRequests: new Map(),
      activeScreenShares: new Map(),

      pendingOps: [],
      flushTimer: null,

      router: null,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),

      // ✅ ADDED RECORDING STATE
      recording: {
        transport: null,
        videoConsumer: null,
        audioConsumers: [],
        ffmpegProcess: null,
        filePath: null,
      },
    });

    console.log(`New room state created for session: ${sessionId}`);
  } else {
    const s = roomState.get(sessionId);

    s.whiteboardId = s.whiteboardId || whiteboardId;
    s.createdBy = s.createdBy || createdBy;

    // safety: agar old session me recording missing ho
    if (!s.recording) {
      s.recording = {
        transport: null,
        videoConsumer: null,
        audioConsumers: [],
        ffmpegProcess: null,
        filePath: null,
      };
    }

    console.log(`Existing room state updated for session: ${sessionId}`);
  }

  return roomState.get(sessionId);
};
