

import jwt from "jsonwebtoken";
import * as Y from "yjs";
import { WebSocketServer } from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const messageSync = 0;
const messageAwareness = 1;

const activeRooms = new Map();

// Role mappings
const ROLE_MAP = {
  'ADMIN': 1,
  'STREAMER': 2,
  'VIEWER': 3
};

const ROLE_REVERSE_MAP = {
  1: 'ADMIN',
  2: 'STREAMER',
  3: 'VIEWER'
};

// JWT Verification for WebSocket
const verifyWebSocketToken = (token) => {
  try {
    if (!token || token === 'undefined' || token === 'null') {
      console.log('❌ Token is missing or invalid');
      return null;
    }
    
    const cleanToken = token.replace(/['"]/g, '').trim();
    
    if (!cleanToken || cleanToken.length < 10) {
      console.log('❌ Token is too short');
      return null;
    }
    
    const decoded = jwt.verify(cleanToken, process.env.SECRET_KEY || 'your-secret-key');
    
    const roleName = ROLE_REVERSE_MAP[decoded.role];
    if (!roleName) {
      console.log(`❌ Invalid role in token: ${decoded.role}`);
      throw new Error('Invalid role in token');
    }
    
    console.log(`✅ Token verified for user: ${decoded.userId}, role: ${roleName}`);
    
    return {
      userId: decoded.userId,
      role: decoded.role,
      roleName: roleName,
      isStreamer: decoded.role === 2,
      isValid: true,
      userName: decoded.name || decoded.userName || `User_${decoded.userId?.substring(0, 4)}`
    };
  } catch (error) {
    console.error("WebSocket token verification failed:", error.message);
    return null;
  }
};

function parseAndValidateParams(urlString) {
  try {
    console.log(`🔍 Parsing URL: ${urlString}`);
    
    // ✅ FIX: Handle malformed URLs
    if (!urlString || urlString === '/') {
      console.error('❌ Empty URL');
      return null;
    }
    
    const baseUrl = 'ws://localhost';
    const fullUrl = urlString.startsWith('/') 
      ? `${baseUrl}${urlString}` 
      : `${baseUrl}/${urlString}`;
    
    let url;
    try {
      url = new URL(fullUrl);
    } catch (e) {
      console.error('❌ Invalid URL format:', urlString);
      return null;
    }
    
    const params = {};
    
    for (const [key, value] of url.searchParams.entries()) {
      const cleanValue = value.trim();
      
      if (cleanValue === 'true' || cleanValue === 'false' || 
          cleanValue === '1' || cleanValue === '0' ||
          cleanValue === 'yes' || cleanValue === 'no') {
        params[key] = (
          cleanValue === 'true' || 
          cleanValue === '1' || 
          cleanValue === 'yes'
        );
      }
      else if (!isNaN(cleanValue) && cleanValue !== '') {
        params[key] = Number(cleanValue);
      }
      else {
        params[key] = cleanValue;
      }
    }
    
    const BOOLEAN_PARAMS = ['isStreamer', 'allowViewersToDraw', 'isViewer'];
    BOOLEAN_PARAMS.forEach(param => {
      if (param in params) {
        params[param] = String(params[param]).toLowerCase() === 'true' || 
                        params[param] === true || 
                        params[param] === 1;
      }
    });
    
    if (!params.token) {
      console.error('❌ Token is required');
      throw new Error('Token is required');
    }
    
    const tokenData = verifyWebSocketToken(params.token);
    if (!tokenData || !tokenData.isValid) {
      console.error('❌ Invalid or expired token');
      throw new Error('Invalid or expired token');
    }
    
    const isStreamer = params.isStreamer === true || tokenData.isStreamer === true || tokenData.role === 2;
    const allowViewersToDraw = params.allowViewersToDraw === true;
    
    const userId = params.userId || tokenData.userId || `user_${Date.now()}`;
    const userName = params.userName || tokenData.userName || `User_${userId.substring(0, 4)}`;
    const roomName = params.roomName || 'Whiteboard Session';
    const roomCode = params.roomCode || '';
    
    let permissions = {};
    if (isStreamer) {
      permissions = {
        canDraw: true,
        canEdit: true,
        canDelete: true,
        canClear: true,
        canChat: true,
        canExport: true,
        canImport: true
      };
    } else {
      permissions = {
        canDraw: allowViewersToDraw,
        canEdit: allowViewersToDraw,
        canDelete: false,
        canClear: false,
        canChat: true,
        canExport: true,
        canImport: false
      };
    }
    
    console.log(`🎨 FINAL - Viewer drawing: ${allowViewersToDraw ? 'ENABLED' : 'DISABLED'}`);
    console.log(`👤 FINAL - Role: ${isStreamer ? 'STREAMER' : 'VIEWER'}`);
    console.log(`🔐 FINAL PERMISSIONS:`, permissions);
    
    return {
      userId,
      userName,
      role: tokenData.role,
      roleName: tokenData.roleName,
      isStreamer,
      allowViewersToDraw,
      roomName,
      roomCode,
      permissions,
      connectedAt: new Date().toISOString()
    };
    
  } catch (e) {
    console.error('❌ Error parsing params:', e.message);
    return null;
  }
}

function getRoom(sessionId, userParams = null) {
  console.log(`🔍 Getting room for session: ${sessionId}`);
  
  let room = activeRooms.get(sessionId);
  
  if (!room && userParams) {
    console.log(`🆕 Creating NEW room: ${sessionId}`);
    
    try {
      const doc = new Y.Doc();
      const awareness = new awarenessProtocol.Awareness(doc);
      
      console.log(`✅ Y.Doc created with awareness clientID: ${awareness.clientID}`);
      
      room = {
        doc,
        awareness,
        clients: new Map(),
        clientToAwarenessId: new Map(),
        createdBy: userParams.userId,
        createdByName: userParams.userName,
        allowViewersToDraw: userParams.allowViewersToDraw,
        sessionInfo: {
          sessionId,
          title: userParams.roomName,
          roomCode: userParams.roomCode,
          streamerName: userParams.userName,
          streamerId: userParams.userId,
          createdAt: new Date().toISOString(),
          allowViewersToDraw: userParams.allowViewersToDraw
        },
        userPermissions: new Map([[userParams.userId, userParams.permissions]]),
        stats: {
          totalConnections: 0,
          totalDraws: 0,
          lastActivity: new Date().toISOString()
        }
      };
      
      const ySettings = doc.getMap('room_settings');
      ySettings.set('allowViewersToDraw', userParams.allowViewersToDraw);
      ySettings.set('streamerId', userParams.userId);
      ySettings.set('streamerName', userParams.userName);
      ySettings.set('createdAt', new Date().toISOString());
      
      const yCanvasArray = doc.getArray('whiteboard');
      if (yCanvasArray.length === 0) {
        const initialState = {
          version: '5.3.0',
          objects: [],
          background: '#ffffff',
          sessionId: sessionId,
          allowViewersToDraw: userParams.allowViewersToDraw,
          createdAt: new Date().toISOString(),
          updatedBy: userParams.userId,
          updatedByName: userParams.userName
        };
        yCanvasArray.insert(0, [initialState]);
        console.log('✅ Canvas array initialized with empty state');
      }
      
      activeRooms.set(sessionId, room);
      console.log(`✅ Room ${sessionId} created successfully`);
      
      awareness.on("update", ({ added, updated, removed }, origin) => {
        try {
          const changedClients = added.concat(updated, removed);
          if (changedClients.length === 0) return;
          
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, messageAwareness);
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
          );
          const buff = encoding.toUint8Array(encoder);
          
          room.clients.forEach((_, client) => {
            if (client !== origin && client.readyState === 1) {
              client.send(buff);
            }
          });
        } catch (error) {
          console.error('❌ Awareness update error:', error);
        }
      });
      
      doc.on('update', (update, origin) => {
        try {
          room.stats.lastActivity = new Date().toISOString();
          room.stats.totalDraws++;
          
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, messageSync);
          syncProtocol.writeUpdate(encoder, update);
          const message = encoding.toUint8Array(encoder);
          
          let broadcastCount = 0;
          room.clients.forEach((_, client) => {
            if (client !== origin && client.readyState === 1) {
              client.send(message);
              broadcastCount++;
            }
          });
          
          if (broadcastCount > 0) {
            console.log(`📡 Broadcasted update to ${broadcastCount} clients`);
          }
        } catch (error) {
          console.error('❌ Document update error:', error);
        }
      });
      
      return room;
      
    } catch (error) {
      console.error(`❌ Failed to create room:`, error);
      return null;
    }
  }
  
  return room;
}

// ✅ COMPLETELY FIXED: Connection handlers with bulletproof binary handling
function setupConnectionHandlers(ws, room, sessionId, userParams) {
  try {
    console.log(`🔗 Setting up connection handlers for ${userParams.userName} (${userParams.roleName})`);
    
    if (!room) {
      console.error(`❌ CRITICAL: Room ${sessionId} is null`);
      ws.close(1011, 'Room not found');
      return;
    }
    
    if (!room.awareness) {
      console.error(`❌ CRITICAL: Room ${sessionId} missing awareness`);
      ws.close(1011, 'Server configuration error');
      return;
    }
    
    // ✅ FIX: Set binaryType on the WebSocket
    ws.binaryType = 'arraybuffer';
    
    const userInfo = {
      userId: userParams.userId,
      userName: userParams.userName,
      role: userParams.role,
      roleName: userParams.roleName,
      isStreamer: userParams.isStreamer,
      permissions: userParams.permissions,
      joinedAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      connectionId: `${userParams.userId}_${Date.now()}`
    };
    room.clients.set(ws, userInfo);
    room.stats.totalConnections++;
    
    ws.userId = userParams.userId;
    ws.userName = userParams.userName;
    ws.isStreamer = userParams.isStreamer;
    ws.role = userParams.role;
    ws.permissions = userParams.permissions;
    
    const awarenessState = {
      userId: userParams.userId,
      userName: userParams.userName,
      role: userParams.roleName,
      isStreamer: userParams.isStreamer,
      cursorPosition: { x: 0, y: 0 },
      currentTool: 'select',
      color: '#000000',
      permissions: userParams.permissions,
      lastActive: new Date().toISOString(),
      allowViewersToDraw: room.allowViewersToDraw,
      connectionId: `${userParams.userId}_${Date.now()}_${Math.random().toString(36).slice(2)}`
    };
    
    try {
      room.awareness.setLocalState(awarenessState);
      const clientId = room.awareness.clientID;
      room.clientToAwarenessId.set(ws, clientId);
      console.log(`✅ Awareness state set for ${userParams.userName} with clientID: ${clientId}`);
    } catch (awarenessError) {
      console.error('❌ Error setting awareness state:', awarenessError);
    }

    sendSyncStep1(ws, room.doc);
    
    try {
      const states = Array.from(room.awareness.getStates().keys());
      if (states.length > 0) {
        sendAwarenessStates(ws, room.awareness, states);
      }
    } catch (e) {
      console.error('❌ Error sending awareness states:', e);
    }

    const welcomeMessage = JSON.stringify({
      type: 'welcome',
      sessionId: sessionId,
      roomInfo: {
        ...room.sessionInfo,
        allowViewersToDraw: room.allowViewersToDraw
      },
      yourInfo: {
        userId: userParams.userId,
        userName: userParams.userName,
        role: userParams.roleName,
        isStreamer: userParams.isStreamer,
        permissions: userParams.permissions,
        clientId: room.awareness.clientID
      },
      roomSettings: {
        allowViewersToDraw: room.allowViewersToDraw,
        streamerId: room.createdBy,
        streamerName: room.createdByName
      },
      totalParticipants: room.clients.size,
      serverTime: new Date().toISOString()
    });
    
    if (ws.readyState === 1) {
      ws.send(welcomeMessage);
    }

    const joinMessage = JSON.stringify({
      type: 'user_joined',
      userId: userParams.userId,
      userName: userParams.userName,
      role: userParams.roleName,
      isStreamer: userParams.isStreamer,
      timestamp: new Date().toISOString(),
      totalParticipants: room.clients.size
    });
    
    room.clients.forEach((_, client) => {
      if (client !== ws && client.readyState === 1) {
        client.send(joinMessage);
      }
    });

    // ✅ BULLETPROOF FIX: Message handler with proper binary/JSON separation
    ws.on("message", (data) => {
      try {
        const info = room.clients.get(ws);
        if (info) {
          info.lastActive = new Date().toISOString();
        }
        
        // ✅ FIX 1: Check if it's a JSON message first (starts with { or [)
        if (data && (data.toString().startsWith('{') || data.toString().startsWith('['))) {
          try {
            const textData = data.toString();
            const jsonData = JSON.parse(textData);
            
            // Don't broadcast sync/awareness messages as JSON
            if (jsonData.type === 'sync' || jsonData.type === 'awareness') {
              return;
            }
            
            jsonData.userId = userParams.userId;
            jsonData.userName = userParams.userName;
            jsonData.timestamp = new Date().toISOString();
            
            const broadcastMessage = JSON.stringify(jsonData);
            room.clients.forEach((_, client) => {
              if (client !== ws && client.readyState === 1) {
                client.send(broadcastMessage);
              }
            });
            return;
          } catch (jsonError) {
            // Not valid JSON, continue to binary handling
          }
        }

        // ✅ FIX 2: Convert to Buffer safely
        let uint8Array;
        if (data instanceof Buffer) {
          uint8Array = new Uint8Array(data);
        } else if (data instanceof ArrayBuffer) {
          uint8Array = new Uint8Array(data);
        } else if (data instanceof Uint8Array) {
          uint8Array = data;
        } else if (typeof data === 'string') {
          // Skip strings that aren't JSON
          return;
        } else {
          console.error('❌ Unknown data type:', typeof data);
          return;
        }

        // ✅ FIX 3: Validate buffer length
        if (uint8Array.length < 2) {
          console.error('❌ Message too short:', uint8Array.length);
          return;
        }

        // ✅ FIX 4: Create decoder safely with try-catch
        let decoder;
        try {
          decoder = decoding.createDecoder(uint8Array);
        } catch (decodeError) {
          console.error('❌ Failed to create decoder:', decodeError.message);
          return;
        }

        let messageType;
        try {
          messageType = decoding.readVarUint(decoder);
        } catch (readError) {
          console.error('❌ Failed to read message type:', readError.message);
          return;
        }

        if (messageType === messageSync) {
          // ✅ FIX 5: Check permissions before applying sync
          if (!ws.isStreamer && !room.allowViewersToDraw) {
            console.log(`🚫 ${ws.userName} tried to sync but doesn't have permission`);
            return;
          }
          
          try {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageSync);
            
            syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
            
            const reply = encoding.toUint8Array(encoder);
            if (reply.length > 1 && ws.readyState === 1) {
              ws.send(reply);
            }
          } catch (syncError) {
            console.error('❌ SyncProtocol error:', syncError.message);
          }
          return;
        }

        if (messageType === messageAwareness) {
          if (!room.awareness) return;
          
          try {
            const update = decoding.readVarUint8Array(decoder);
            awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
          } catch (awarenessError) {
            console.error('❌ Awareness error:', awarenessError.message);
          }
          return;
        }
        
      } catch (err) {
        // ✅ FIX 6: Don't crash, just log and continue
        console.error("❌ Yjs WS message error:", err?.message || err);
      }
    });

    // ✅ FIXED: Clean disconnect handling
    ws.on("close", () => {
      const userInfo = room.clients.get(ws);
      const userName = userInfo?.userName || 'Unknown';
      
      console.log(`🔌 Client disconnected: ${userName} from ${sessionId}`);
      
      const awarenessClientId = room.clientToAwarenessId.get(ws);
      
      if (awarenessClientId !== undefined) {
        console.log(`   - Removing awareness for clientID: ${awarenessClientId}`);
        try {
          awarenessProtocol.removeAwarenessStates(
            room.awareness, 
            [awarenessClientId], 
            ws
          );
          room.clientToAwarenessId.delete(ws);
        } catch (e) {
          console.error("❌ Error removing awareness states:", e);
        }
      }
      
      room.clients.delete(ws);
      
      if (userInfo?.userId) {
        room.userPermissions.delete(userInfo.userId);
      }

      const leaveMessage = JSON.stringify({
        type: 'user_left',
        userId: userInfo?.userId,
        userName: userName,
        timestamp: new Date().toISOString(),
        totalParticipants: room.clients.size
      });
      
      room.clients.forEach((_, client) => {
        if (client.readyState === 1) {
          client.send(leaveMessage);
        }
      });
      
      console.log(`👥 Remaining in room ${sessionId}: ${room.clients.size}`);

      if (room.clients.size === 0) {
        console.log(`⏳ Room ${sessionId} is empty, will delete in 1 minute`);
        setTimeout(() => {
          if (room.clients.size === 0) {
            activeRooms.delete(sessionId);
            console.log(`🧹 Yjs Room deleted: ${sessionId}`);
          }
        }, 60000);
      }
    });

    ws.on("error", (error) => {
      console.error(`❌ WebSocket error for ${userParams.userName}:`, error.message);
    });

    console.log(`✅ ${userParams.userName} (${userParams.roleName}) connected. Total: ${room.clients.size}`);
    console.log(`🎨 Room settings: allowViewersToDraw = ${room.allowViewersToDraw}`);
    
  } catch (error) {
    console.error(`❌ Error in setupConnectionHandlers:`, error);
    try {
      ws.close(1011, 'Server error');
    } catch (e) {}
  }
}

function sendSyncStep1(ws, doc) {
  try {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    
    const message = encoding.toUint8Array(encoder);
    if (ws.readyState === 1) {
      ws.send(message);
      console.log('✅ Sent sync step 1');
    }
  } catch (error) {
    console.error('❌ Error sending sync step 1:', error);
  }
}

function sendAwarenessStates(ws, awareness, clientIDs) {
  try {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, clientIDs)
    );
    const message = encoding.toUint8Array(encoder);
    if (ws.readyState === 1) {
      ws.send(message);
    }
  } catch (error) {
    console.error('❌ Error sending awareness states:', error);
  }
}

function checkRoomPermissions(userParams, room) {
  if (!room) {
    console.log('🆕 No existing room, creating new one');
    return true;
  }
  
  const { userId, isStreamer } = userParams;
  
  if (isStreamer && room.createdBy === userId) {
    console.log('✅ Streamer rejoining own room');
    return true;
  }
  
  if (isStreamer && room.createdBy && room.createdBy !== userId) {
    console.log(`🚫 Multiple streamers not allowed in room ${room.sessionInfo?.sessionId}`);
    return false;
  }
  
  console.log('✅ Permission check passed');
  return true;
}

export function getActiveRoomsInfo() {
  const roomsInfo = [];
  activeRooms.forEach((room, sessionId) => {
    const clientsInfo = Array.from(room.clients.values()).map(client => ({
      userId: client.userId,
      userName: client.userName,
      role: client.roleName,
      isStreamer: client.isStreamer,
      joinedAt: client.joinedAt,
      lastActive: client.lastActive,
      permissions: client.permissions
    }));
    
    roomsInfo.push({
      sessionId,
      createdBy: room.createdByName,
      allowViewersToDraw: room.allowViewersToDraw,
      totalClients: room.clients.size,
      clients: clientsInfo,
      sessionInfo: room.sessionInfo,
      stats: room.stats
    });
  });
  return roomsInfo;
}

function debugRoomCreation() {
  console.log('\n=== DEBUG ROOM STATUS ===');
  console.log('Active rooms count:', activeRooms.size);
  activeRooms.forEach((room, sessionId) => {
    console.log(`\n📁 Room: ${sessionId}`);
    console.log(`  - Streamer: ${room.createdByName}`);
    console.log(`  - Allow Viewers to Draw: ${room.allowViewersToDraw}`);
    console.log(`  - Clients: ${room.clients?.size || 0}`);
    console.log(`  - Awareness clientID: ${room.awareness?.clientID || 'N/A'}`);
    console.log(`  - Total Draws: ${room.stats?.totalDraws || 0}`);
    console.log(`  - Last Activity: ${room.stats?.lastActivity || 'Never'}`);
  });
  console.log('==========================\n');
}

// ✅ COMPLETELY FIXED: Main WebSocket server setup
export function setupYWebsocketCompatibleServer(httpServer) {
  console.log('🚀 Setting up Yjs WebSocket server...');

  setInterval(debugRoomCreation, 30000);

  const wss = new WebSocketServer({ 
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    skipUTF8Validation: true,
    maxPayload: 50 * 1024 * 1024
  });

  httpServer.on("upgrade", (request, socket, head) => {
    try {
      const url = request.url;
      console.log(`📡 WebSocket upgrade request: ${url}`);
      
      if (url.startsWith("/socket.io/")) {
        return;
      }
      
      if (!url.startsWith("/yjs/")) {
        return;
      }

      const pathParts = url.split('/');
      const sessionId = pathParts[2]?.split('?')[0];
      
      if (!sessionId || sessionId.length < 5) {
        console.log("❌ Yjs WS rejected: Invalid sessionId", sessionId);
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      console.log(`🔍 Processing Yjs connection for session: ${sessionId}`);
      
      const userParams = parseAndValidateParams(url);

      if (!userParams) {
        console.log("❌ Yjs WS rejected: Invalid authentication");
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const room = getRoom(sessionId, userParams);

      if (!room) {
        console.log(`❌ Failed to get/create room for session: ${sessionId}`);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
        return;
      }
      
      if (!room.awareness) {
        console.log(`❌ Room missing awareness for session: ${sessionId}`);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
        return;
      }
      
      if (!checkRoomPermissions(userParams, room)) {
        console.log(`🚫 Permission denied for ${userParams.userName} in room ${sessionId}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.sessionId = sessionId;
        wss.emit("connection", ws, request);
        setupConnectionHandlers(ws, room, sessionId, userParams);
      });

    } catch (e) {
      console.error("❌ Yjs WS upgrade error:", e.message);
      console.error('Stack:', e.stack);
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    console.log(`📡 New Yjs WebSocket connection established for session: ${ws.sessionId}`);
  });

  wss.on("error", (error) => {
    console.error("❌ Yjs WebSocket server error:", error.message);
  });

  wss.on("close", () => {
    console.log("🔴 Yjs WebSocket server closed");
  });

  console.log("✅ Yjs WebSocket Server with JWT Authentication enabled on /yjs/:sessionId");
  console.log("🎨 Fixed: Binary message handling, JSON separation, permission checks");
  
  return {
    cleanup: () => {
      console.log("🧹 Cleaning up Yjs WebSocket server...");
      wss.clients.forEach((client) => {
        try {
          client.close(1000, "Server shutdown");
        } catch (error) {}
      });
      wss.close();
      activeRooms.clear();
    },
    getStats: () => {
      return {
        totalRooms: activeRooms.size,
        totalConnections: Array.from(activeRooms.values()).reduce(
          (sum, room) => sum + room.clients.size, 0
        ),
        rooms: getActiveRoomsInfo()
      };
    },
    getRoom: (sessionId) => {
      return activeRooms.get(sessionId);
    }
  };
}

export function getYjsHealth(req, res) {
  try {
    const stats = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      totalRooms: activeRooms.size,
      totalConnections: Array.from(activeRooms.values()).reduce(
        (sum, room) => sum + room.clients.size, 0
      ),
      rooms: getActiveRoomsInfo(),
      uptime: process.uptime()
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
}

export default {
  setupYWebsocketCompatibleServer,
  getYjsHealth,
  getActiveRoomsInfo
};




// import jwt from "jsonwebtoken";
// import * as Y from "yjs";
// import { WebSocketServer } from "ws";
// import * as syncProtocol from "y-protocols/sync";
// import * as awarenessProtocol from "y-protocols/awareness";
// import * as encoding from "lib0/encoding";
// import * as decoding from "lib0/decoding";

// const messageSync = 0;
// const messageAwareness = 1;

// const activeRooms = new Map();

// // Role mappings
// const ROLE_MAP = {
//   'ADMIN': 1,
//   'STREAMER': 2,
//   'VIEWER': 3
// };

// const ROLE_REVERSE_MAP = {
//   1: 'ADMIN',
//   2: 'STREAMER',
//   3: 'VIEWER'
// };

// // JWT Verification for WebSocket
// const verifyWebSocketToken = (token) => {
//   try {
//     if (!token || token === 'undefined' || token === 'null') {
//       console.log('❌ Token is missing or invalid');
//       return null;
//     }
    
//     const cleanToken = token.replace(/['"]/g, '').trim();
    
//     if (!cleanToken || cleanToken.length < 10) {
//       console.log('❌ Token is too short');
//       return null;
//     }
    
//     const decoded = jwt.verify(cleanToken, process.env.SECRET_KEY || 'your-secret-key');
    
//     const roleName = ROLE_REVERSE_MAP[decoded.role];
//     if (!roleName) {
//       console.log(`❌ Invalid role in token: ${decoded.role}`);
//       throw new Error('Invalid role in token');
//     }
    
//     console.log(`✅ Token verified for user: ${decoded.userId}, role: ${roleName}`);
    
//     return {
//       userId: decoded.userId,
//       role: decoded.role,
//       roleName: roleName,
//       isStreamer: decoded.role === 2,
//       isValid: true,
//       userName: decoded.name || decoded.userName || `User_${decoded.userId?.substring(0, 4)}`
//     };
//   } catch (error) {
//     console.error("WebSocket token verification failed:", error.message);
//     return null;
//   }
// };

// // ✅ FIXED: Simple parameter parsing without clientID generation
// function parseAndValidateParams(urlString) {
//   try {
//     console.log(`🔍 Parsing URL: ${urlString}`);
    
//     const baseUrl = 'ws://localhost';
//     const fullUrl = urlString.startsWith('/') 
//       ? `${baseUrl}${urlString}` 
//       : `${baseUrl}/${urlString}`;
//     const url = new URL(fullUrl);
    
//     const params = {};
    
//     // Extract ALL query parameters
//     for (const [key, value] of url.searchParams.entries()) {
//       const cleanValue = value.trim();
      
//       // Boolean parsing
//       if (cleanValue === 'true' || cleanValue === 'false' || 
//           cleanValue === '1' || cleanValue === '0' ||
//           cleanValue === 'yes' || cleanValue === 'no') {
        
//         params[key] = (
//           cleanValue === 'true' || 
//           cleanValue === '1' || 
//           cleanValue === 'yes'
//         );
//       }
//       // Number parsing
//       else if (!isNaN(cleanValue) && cleanValue !== '') {
//         params[key] = Number(cleanValue);
//       }
//       // Default: string
//       else {
//         params[key] = cleanValue;
//       }
//     }
    
//     // Force boolean conversion for specific params
//     const BOOLEAN_PARAMS = ['isStreamer', 'allowViewersToDraw', 'isViewer'];
//     BOOLEAN_PARAMS.forEach(param => {
//       if (param in params) {
//         params[param] = String(params[param]).toLowerCase() === 'true' || 
//                         params[param] === true || 
//                         params[param] === 1;
//       }
//     });
    
//     // Token verification
//     if (!params.token) {
//       console.error('❌ Token is required');
//       throw new Error('Token is required');
//     }
    
//     const tokenData = verifyWebSocketToken(params.token);
//     if (!tokenData || !tokenData.isValid) {
//       console.error('❌ Invalid or expired token');
//       throw new Error('Invalid or expired token');
//     }
    
//     // Determine role and permissions
//     const isStreamer = params.isStreamer === true || tokenData.isStreamer === true || tokenData.role === 2;
//     const allowViewersToDraw = params.allowViewersToDraw === true;
    
//     // User info
//     const userId = params.userId || tokenData.userId || `user_${Date.now()}`;
//     const userName = params.userName || tokenData.userName || `User_${userId.substring(0, 4)}`;
//     const roomName = params.roomName || 'Whiteboard Session';
//     const roomCode = params.roomCode || '';
    
//     // Permissions
//     let permissions = {};
//     if (isStreamer) {
//       permissions = {
//         canDraw: true,
//         canEdit: true,
//         canDelete: true,
//         canClear: true,
//         canChat: true,
//         canExport: true,
//         canImport: true
//       };
//     } else {
//       permissions = {
//         canDraw: allowViewersToDraw,
//         canEdit: allowViewersToDraw,
//         canDelete: false,
//         canClear: false,
//         canChat: true,
//         canExport: true,
//         canImport: false
//       };
//     }
    
//     console.log(`🎨 FINAL - Viewer drawing: ${allowViewersToDraw ? 'ENABLED' : 'DISABLED'}`);
//     console.log(`👤 FINAL - Role: ${isStreamer ? 'STREAMER' : 'VIEWER'}`);
//     console.log(`🔐 FINAL PERMISSIONS:`, permissions);
    
//     return {
//       userId,
//       userName,
//       role: tokenData.role,
//       roleName: tokenData.roleName,
//       isStreamer,
//       allowViewersToDraw,
//       roomName,
//       roomCode,
//       permissions,
//       connectedAt: new Date().toISOString()
//     };
    
//   } catch (e) {
//     console.error('❌ Error parsing params:', e.message);
//     return null;
//   }
// }

// // ✅ FIXED: Simple room creation without clientID manipulation
// function getRoom(sessionId, userParams = null) {
//   console.log(`🔍 Getting room for session: ${sessionId}`);
  
//   let room = activeRooms.get(sessionId);
  
//   // Create new room if it doesn't exist
//   if (!room && userParams) {
//     console.log(`🆕 Creating NEW room: ${sessionId}`);
    
//     try {
//       const doc = new Y.Doc();
      
//       // ✅ IMPORTANT: Let Yjs generate its own clientID
//       const awareness = new awarenessProtocol.Awareness(doc);
      
//       console.log(`✅ Y.Doc created with awareness clientID: ${awareness.clientID}`);
      
//       room = {
//         doc,
//         awareness,
//         clients: new Map(),
//         createdBy: userParams.userId,
//         createdByName: userParams.userName,
//         allowViewersToDraw: userParams.allowViewersToDraw,
//         sessionInfo: {
//           sessionId,
//           title: userParams.roomName,
//           roomCode: userParams.roomCode,
//           streamerName: userParams.userName,
//           streamerId: userParams.userId,
//           createdAt: new Date().toISOString(),
//           allowViewersToDraw: userParams.allowViewersToDraw
//         },
//         userPermissions: new Map([[userParams.userId, userParams.permissions]]),
//         stats: {
//           totalConnections: 0,
//           totalDraws: 0,
//           lastActivity: new Date().toISOString()
//         }
//       };
      
//       // ✅ Initialize room settings in Yjs
//       const ySettings = doc.getMap('room_settings');
//       ySettings.set('allowViewersToDraw', userParams.allowViewersToDraw);
//       ySettings.set('streamerId', userParams.userId);
//       ySettings.set('streamerName', userParams.userName);
//       ySettings.set('createdAt', new Date().toISOString());
      
//       // ✅ Initialize whiteboard array
//       const yCanvasArray = doc.getArray('whiteboard');
//       if (yCanvasArray.length === 0) {
//         const initialState = {
//           version: '5.3.0',
//           objects: [],
//           background: '#ffffff',
//           sessionId: sessionId,
//           allowViewersToDraw: userParams.allowViewersToDraw,
//           createdAt: new Date().toISOString(),
//           updatedBy: userParams.userId,
//           updatedByName: userParams.userName
//         };
//         yCanvasArray.insert(0, [initialState]);
//         console.log('✅ Canvas array initialized with empty state');
//       }
      
//       activeRooms.set(sessionId, room);
//       console.log(`✅ Room ${sessionId} created successfully`);
      
//       // ✅ FIXED: Awareness update handler
//       awareness.on("update", ({ added, updated, removed }, origin) => {
//         try {
//           const changedClients = added.concat(updated, removed);
//           if (changedClients.length === 0) return;
          
//           const encoder = encoding.createEncoder();
//           encoding.writeVarUint(encoder, messageAwareness);
//           encoding.writeVarUint8Array(
//             encoder,
//             awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
//           );
//           const buff = encoding.toUint8Array(encoder);
          
//           room.clients.forEach((_, client) => {
//             if (client !== origin && client.readyState === 1) {
//               client.send(buff);
//             }
//           });
//         } catch (error) {
//           console.error('❌ Awareness update error:', error);
//         }
//       });
      
//       // ✅ FIXED: Document update handler
//       doc.on('update', (update, origin) => {
//         try {
//           room.stats.lastActivity = new Date().toISOString();
//           room.stats.totalDraws++;
          
//           const encoder = encoding.createEncoder();
//           encoding.writeVarUint(encoder, messageSync);
//           syncProtocol.writeUpdate(encoder, update);
//           const message = encoding.toUint8Array(encoder);
          
//           let broadcastCount = 0;
//           room.clients.forEach((_, client) => {
//             if (client !== origin && client.readyState === 1) {
//               client.send(message);
//               broadcastCount++;
//             }
//           });
          
//           if (broadcastCount > 0) {
//             console.log(`📡 Broadcasted update to ${broadcastCount} clients`);
//           }
//         } catch (error) {
//           console.error('❌ Document update error:', error);
//         }
//       });
      
//       return room;
      
//     } catch (error) {
//       console.error(`❌ Failed to create room:`, error);
//       return null;
//     }
//   }
  
//   return room;
// }

// // ✅ FIXED: Clean connection handlers - NO clientID overwriting!
// function setupConnectionHandlers(ws, room, sessionId, userParams) {
//   try {
//     console.log(`🔗 Setting up connection handlers for ${userParams.userName} (${userParams.roleName})`);
    
//     // Validate room
//     if (!room) {
//       console.error(`❌ CRITICAL: Room ${sessionId} is null`);
//       ws.close(1011, 'Room not found');
//       return;
//     }
    
//     if (!room.awareness) {
//       console.error(`❌ CRITICAL: Room ${sessionId} missing awareness`);
//       ws.close(1011, 'Server configuration error');
//       return;
//     }
    
//     // Store user info with connection
//     const userInfo = {
//       userId: userParams.userId,
//       userName: userParams.userName,
//       role: userParams.role,
//       roleName: userParams.roleName,
//       isStreamer: userParams.isStreamer,
//       permissions: userParams.permissions,
//       joinedAt: new Date().toISOString(),
//       lastActive: new Date().toISOString(),
//       connectionId: `${userParams.userId}_${Date.now()}`
//     };
//     room.clients.set(ws, userInfo);
//     room.stats.totalConnections++;
    
//     // Attach user info to WebSocket
//     ws.userId = userParams.userId;
//     ws.userName = userParams.userName;
//     ws.isStreamer = userParams.isStreamer;
//     ws.role = userParams.role;
//     ws.permissions = userParams.permissions;
    
//     // ✅ CRITICAL FIX: DO NOT overwrite awareness.clientID!
//     // Let Yjs manage its own clientID
    
//     // ✅ Set awareness state - Yjs handles clientID internally
//  const awarenessState = {
//   userId: userParams.userId,
//   userName: userParams.userName,
//   role: userParams.roleName,
//   isStreamer: userParams.isStreamer,
//   cursorPosition: { x: 0, y: 0 },
//   currentTool: 'select',
//   color: '#000000',
//   permissions: userParams.permissions,
//   lastActive: new Date().toISOString(),
//   allowViewersToDraw: room.allowViewersToDraw,
//   connectionId: `${userParams.userId}_${Date.now()}_${Math.random().toString(36).slice(2)}` // ✅ Add unique connection ID
// };
    
//     try {
//       room.awareness.setLocalState(awarenessState);
//       console.log(`✅ Awareness state set for ${userParams.userName} with clientID: ${room.awareness.clientID}`);
//     } catch (awarenessError) {
//       console.error('❌ Error setting awareness state:', awarenessError);
//     }

//     // Send initial sync step 1
//     sendSyncStep1(ws, room.doc);
    
//     // Send current awareness states to new client
//     try {
//       const states = Array.from(room.awareness.getStates().keys());
//       if (states.length > 0) {
//         sendAwarenessStates(ws, room.awareness, states);
//       }
//     } catch (e) {
//       console.error('❌ Error sending awareness states:', e);
//     }

//     // Send welcome message
//     const welcomeMessage = JSON.stringify({
//       type: 'welcome',
//       sessionId: sessionId,
//       roomInfo: {
//         ...room.sessionInfo,
//         allowViewersToDraw: room.allowViewersToDraw
//       },
//       yourInfo: {
//         userId: userParams.userId,
//         userName: userParams.userName,
//         role: userParams.roleName,
//         isStreamer: userParams.isStreamer,
//         permissions: userParams.permissions,
//         clientId: room.awareness.clientID  // ✅ Send Yjs-generated clientID
//       },
//       roomSettings: {
//         allowViewersToDraw: room.allowViewersToDraw,
//         streamerId: room.createdBy,
//         streamerName: room.createdByName
//       },
//       totalParticipants: room.clients.size,
//       serverTime: new Date().toISOString()
//     });
    
//     if (ws.readyState === 1) {
//       ws.send(welcomeMessage);
//     }

//     // Broadcast user joined message
//     const joinMessage = JSON.stringify({
//       type: 'user_joined',
//       userId: userParams.userId,
//       userName: userParams.userName,
//       role: userParams.roleName,
//       isStreamer: userParams.isStreamer,
//       timestamp: new Date().toISOString(),
//       totalParticipants: room.clients.size
//     });
    
//     room.clients.forEach((_, client) => {
//       if (client !== ws && client.readyState === 1) {
//         client.send(joinMessage);
//       }
//     });

//     // ✅ FIXED: Handle incoming messages
//     ws.on("message", (data) => {
//       try {
//         // Update last active timestamp
//         const info = room.clients.get(ws);
//         if (info) {
//           info.lastActive = new Date().toISOString();
//         }
        
//         const uint8 = data instanceof Buffer ? new Uint8Array(data) : data;
//         const decoder = decoding.createDecoder(uint8);
//         const messageType = decoding.readVarUint(decoder);

//         if (messageType === messageSync) {
//           const encoder = encoding.createEncoder();
//           encoding.writeVarUint(encoder, messageSync);

//           // Process sync message
//           const syncMessageType = syncProtocol.readSyncMessage(
//             decoder, 
//             encoder, 
//             room.doc, 
//             ws 
//           );

//           const reply = encoding.toUint8Array(encoder);
//           if (reply.length > 1 && ws.readyState === 1) {
//             ws.send(reply);
//           }
//           return;
//         }

//         if (messageType === messageAwareness) {
//           if (!room.awareness) return;
          
//           const update = decoding.readVarUint8Array(decoder);
          
//           // Update awareness state
//           try {
//             const currentState = room.awareness.getLocalState();
//             if (currentState) {
//               room.awareness.setLocalState({
//                 ...currentState,
//                 lastActive: new Date().toISOString()
//               });
//             }
//           } catch (stateError) {
//             // Ignore
//           }
          
//           awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
//           return;
//         }
        
//         // Handle JSON messages
//         try {
//           const textData = data.toString();
//           if (textData.startsWith('{') || textData.startsWith('[')) {
//             const jsonData = JSON.parse(textData);
//             jsonData.userId = userParams.userId;
//             jsonData.userName = userParams.userName;
//             jsonData.timestamp = new Date().toISOString();
            
//             // Broadcast to other clients
//             const broadcastMessage = JSON.stringify(jsonData);
//             room.clients.forEach((_, client) => {
//               if (client !== ws && client.readyState === 1) {
//                 client.send(broadcastMessage);
//               }
//             });
//           }
//         } catch (jsonError) {
//           // Not a JSON message, ignore
//         }
        
//       } catch (err) {
//         console.error("❌ Yjs WS message error:", err?.message || err);
//       }
//     });

//     // ✅ FIXED: Clean disconnect handling
//     ws.on("close", () => {
//       const userInfo = room.clients.get(ws);
//       const userName = userInfo?.userName || 'Unknown';
      
//       console.log(`🔌 Client disconnected: ${userName} from ${sessionId}`);
//       console.log(`   - ClientID: ${room.awareness.clientID}`);
      
//       // Remove from clients map
//       room.clients.delete(ws);
      
//       // Remove user permissions
//       if (userInfo?.userId) {
//         room.userPermissions.delete(userInfo.userId);
//       }

//       // ✅ CRITICAL: Remove awareness state - Yjs handles clientID automatically
//       try {
//         if (room.awareness) {
//           // Get current clientID from awareness
//           const currentClientId = room.awareness.clientID;
//           awarenessProtocol.removeAwarenessStates(
//             room.awareness, 
//             [currentClientId], 
//             ws
//           );
//           console.log(`🧹 Removed awareness state for clientID: ${currentClientId}`);
//         }
//       } catch (e) {
//         console.error("❌ Error removing awareness states:", e);
//       }

//       // Broadcast user left message
//       const leaveMessage = JSON.stringify({
//         type: 'user_left',
//         userId: userInfo?.userId,
//         userName: userName,
//         timestamp: new Date().toISOString(),
//         totalParticipants: room.clients.size
//       });
      
//       room.clients.forEach((_, client) => {
//         if (client.readyState === 1) {
//           client.send(leaveMessage);
//         }
//       });
      
//       console.log(`👥 Remaining in room ${sessionId}: ${room.clients.size}`);

//       // Cleanup empty room after 1 minute
//       if (room.clients.size === 0) {
//         console.log(`⏳ Room ${sessionId} is empty, will delete in 1 minute`);
//         setTimeout(() => {
//           if (room.clients.size === 0) {
//             activeRooms.delete(sessionId);
//             console.log(`🧹 Yjs Room deleted: ${sessionId}`);
//           }
//         }, 60000);
//       }
//     });

//     ws.on("error", (error) => {
//       console.error(`❌ WebSocket error for ${userParams.userName}:`, error.message);
//     });

//     console.log(`✅ ${userParams.userName} (${userParams.roleName}) connected. Total: ${room.clients.size}`);
//     console.log(`🎨 Room settings: allowViewersToDraw = ${room.allowViewersToDraw}`);
    
//   } catch (error) {
//     console.error(`❌ Error in setupConnectionHandlers:`, error);
//     try {
//       ws.close(1011, 'Server error');
//     } catch (e) {
//       // Ignore
//     }
//   }
// }

// function sendSyncStep1(ws, doc) {
//   try {
//     const encoder = encoding.createEncoder();
//     encoding.writeVarUint(encoder, messageSync);
//     syncProtocol.writeSyncStep1(encoder, doc);
    
//     const message = encoding.toUint8Array(encoder);
//     if (ws.readyState === 1) {
//       ws.send(message);
//       console.log('✅ Sent sync step 1');
//     }
//   } catch (error) {
//     console.error('❌ Error sending sync step 1:', error);
//   }
// }

// function sendAwarenessStates(ws, awareness, clientIDs) {
//   try {
//     const encoder = encoding.createEncoder();
//     encoding.writeVarUint(encoder, messageAwareness);
//     encoding.writeVarUint8Array(
//       encoder,
//       awarenessProtocol.encodeAwarenessUpdate(awareness, clientIDs)
//     );
//     const message = encoding.toUint8Array(encoder);
//     if (ws.readyState === 1) {
//       ws.send(message);
//     }
//   } catch (error) {
//     console.error('❌ Error sending awareness states:', error);
//   }
// }

// // Check room permissions
// function checkRoomPermissions(userParams, room) {
//   if (!room) {
//     console.log('🆕 No existing room, creating new one');
//     return true;
//   }
  
//   const { userId, isStreamer } = userParams;
  
//   // Streamer always has full access to their own room
//   if (isStreamer && room.createdBy === userId) {
//     console.log('✅ Streamer rejoining own room');
//     return true;
//   }
  
//   // Check if trying to join as streamer but room already has a different streamer
//   if (isStreamer && room.createdBy && room.createdBy !== userId) {
//     console.log(`🚫 Multiple streamers not allowed in room ${room.sessionInfo?.sessionId}`);
//     return false;
//   }
  
//   console.log('✅ Permission check passed');
//   return true;
// }

// // Get room info (for monitoring/debugging)
// export function getActiveRoomsInfo() {
//   const roomsInfo = [];
//   activeRooms.forEach((room, sessionId) => {
//     const clientsInfo = Array.from(room.clients.values()).map(client => ({
//       userId: client.userId,
//       userName: client.userName,
//       role: client.roleName,
//       isStreamer: client.isStreamer,
//       joinedAt: client.joinedAt,
//       lastActive: client.lastActive,
//       permissions: client.permissions
//     }));
    
//     roomsInfo.push({
//       sessionId,
//       createdBy: room.createdByName,
//       allowViewersToDraw: room.allowViewersToDraw,
//       totalClients: room.clients.size,
//       clients: clientsInfo,
//       sessionInfo: room.sessionInfo,
//       stats: room.stats
//     });
//   });
//   return roomsInfo;
// }

// // Debug function to monitor rooms
// function debugRoomCreation() {
//   console.log('\n=== DEBUG ROOM STATUS ===');
//   console.log('Active rooms count:', activeRooms.size);
//   activeRooms.forEach((room, sessionId) => {
//     console.log(`\n📁 Room: ${sessionId}`);
//     console.log(`  - Streamer: ${room.createdByName}`);
//     console.log(`  - Allow Viewers to Draw: ${room.allowViewersToDraw}`);
//     console.log(`  - Clients: ${room.clients?.size || 0}`);
//     console.log(`  - Awareness clientID: ${room.awareness?.clientID || 'N/A'}`);
//     console.log(`  - Total Draws: ${room.stats?.totalDraws || 0}`);
//     console.log(`  - Last Activity: ${room.stats?.lastActivity || 'Never'}`);
//   });
//   console.log('==========================\n');
// }

// // ✅ FIXED: Main WebSocket server setup
// // ✅ FIXED: Main WebSocket server setup
// export function setupYWebsocketCompatibleServer(httpServer) {
//   console.log('🚀 Setting up Yjs WebSocket server...');

//   // Debug room status every 30 seconds
//   setInterval(debugRoomCreation, 30000);

//   // const wss = new WebSocketServer({ 
//   //   noServer: true,
//   //   clientTracking: false,
//   //   // ❌ REMOVED: perMessageDeflate configuration caused "Unexpected end of array"
//   //   // Yjs binary updates are sensitive to framing issues caused by aggressive compression
//   //   perMessageDeflate: false, 
//   //   maxPayload: 50 * 1024 * 1024 // Optional: Allow large snapshots (50MB)
//   // });


//   const wss = new WebSocketServer({ 
//   noServer: true,
//   clientTracking: false,
//   perMessageDeflate: false,      // ✅ MUST BE FALSE
//   skipUTF8Validation: true,     // ✅ Add this for binary data
//   maxPayload: 50 * 1024 * 1024  // 50MB max
// });

//   httpServer.on("upgrade", (request, socket, head) => {
//     try {
//       const url = request.url;
//       console.log(`📡 WebSocket upgrade request: ${url}`);
      
//       // Ignore socket.io
//       if (url.startsWith("/socket.io/")) {
//         return;
//       }
      
//       // Only handle /yjs/ paths
//       if (!url.startsWith("/yjs/")) {
//         // console.log("❌ Yjs WS rejected: Invalid path", url);
//         // Don't destroy socket here if you have other WS handlers (like socket.io)
//         // Just return and let other handlers process it
//         return;
//       }

//       // Extract sessionId from URL path
//       const pathParts = url.split('/');
//       const sessionId = pathParts[2]?.split('?')[0];
      
//       if (!sessionId || sessionId.length < 5) {
//         console.log("❌ Yjs WS rejected: Invalid sessionId", sessionId);
//         socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
//         socket.destroy();
//         return;
//       }

//       console.log(`🔍 Processing Yjs connection for session: ${sessionId}`);
      
//       // Parse and validate authentication parameters
//       const userParams = parseAndValidateParams(url);

//       if (!userParams) {
//         console.log("❌ Yjs WS rejected: Invalid authentication");
//         socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
//         socket.destroy();
//         return;
//       }

//       // Get or create room
//       const room = getRoom(sessionId, userParams);

//       if (!room) {
//         console.log(`❌ Failed to get/create room for session: ${sessionId}`);
//         socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
//         socket.destroy();
//         return;
//       }
      
//       if (!room.awareness) {
//         console.log(`❌ Room missing awareness for session: ${sessionId}`);
//         socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
//         socket.destroy();
//         return;
//       }
      
//       // Check permissions
//       if (!checkRoomPermissions(userParams, room)) {
//         console.log(`🚫 Permission denied for ${userParams.userName} in room ${sessionId}`);
//         socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
//         socket.destroy();
//         return;
//       }

//       // Handle the upgrade
//       wss.handleUpgrade(request, socket, head, (ws) => {
//         ws.sessionId = sessionId;
//         wss.emit("connection", ws, request);
        
//         // Setup connection handlers with authenticated user info
//         setupConnectionHandlers(ws, room, sessionId, userParams);
//       });

//     } catch (e) {
//       console.error("❌ Yjs WS upgrade error:", e.message);
//       console.error('Stack:', e.stack);
//       socket.destroy();
//     }
//   });

//   wss.on("connection", (ws) => {
//     console.log(`📡 New Yjs WebSocket connection established for session: ${ws.sessionId}`);
//   });

//   wss.on("error", (error) => {
//     console.error("❌ Yjs WebSocket server error:", error.message);
//   });

//   wss.on("close", () => {
//     console.log("🔴 Yjs WebSocket server closed");
//   });

//   console.log("✅ Yjs WebSocket Server with JWT Authentication enabled on /yjs/:sessionId");
//   console.log("🎨 Fixed: Compression disabled to prevent decoding errors");
  
//   return {
//     cleanup: () => {
//       console.log("🧹 Cleaning up Yjs WebSocket server...");
//       wss.clients.forEach((client) => {
//         try {
//           client.close(1000, "Server shutdown");
//         } catch (error) {
//           // Ignore close errors
//         }
//       });
//       wss.close();
//       activeRooms.clear();
//     },
//     getStats: () => {
//       return {
//         totalRooms: activeRooms.size,
//         totalConnections: Array.from(activeRooms.values()).reduce(
//           (sum, room) => sum + room.clients.size, 0
//         ),
//         rooms: getActiveRoomsInfo()
//       };
//     },
//     getRoom: (sessionId) => {
//       return activeRooms.get(sessionId);
//     }
//   };
// }

// // Health check endpoint for monitoring
// export function getYjsHealth(req, res) {
//   try {
//     const stats = {
//       status: 'healthy',
//       timestamp: new Date().toISOString(),
//       totalRooms: activeRooms.size,
//       totalConnections: Array.from(activeRooms.values()).reduce(
//         (sum, room) => sum + room.clients.size, 0
//       ),
//       rooms: getActiveRoomsInfo(),
//       uptime: process.uptime()
//     };
//     res.json(stats);
//   } catch (error) {
//     res.status(500).json({
//       status: 'error',
//       message: error.message
//     });
//   }
// }

// export default {
//   setupYWebsocketCompatibleServer,
//   getYjsHealth,
//   getActiveRoomsInfo
// };




//sahi chal rha h
// import jwt from "jsonwebtoken";
// import * as Y from "yjs";
// import { WebSocketServer } from "ws";
// import * as syncProtocol from "y-protocols/sync";
// import * as awarenessProtocol from "y-protocols/awareness";
// import * as encoding from "lib0/encoding";
// import * as decoding from "lib0/decoding";

// const messageSync = 0;
// const messageAwareness = 1;

// const activeRooms = new Map();

// // Role mappings
// const ROLE_MAP = {
//   'ADMIN': 1,
//   'STREAMER': 2,
//   'VIEWER': 3
// };

// const ROLE_REVERSE_MAP = {
//   1: 'ADMIN',
//   2: 'STREAMER',
//   3: 'VIEWER'
// };

// // JWT Verification for WebSocket
// const verifyWebSocketToken = (token) => {
//   try {
//     if (!token || token === 'undefined' || token === 'null') {
//       console.log('❌ Token is missing or invalid');
//       return null;
//     }
    
//     const cleanToken = token.replace(/['"]/g, '').trim();
    
//     if (!cleanToken || cleanToken.length < 10) {
//       console.log('❌ Token is too short');
//       return null;
//     }
    
//     const decoded = jwt.verify(cleanToken, process.env.SECRET_KEY || 'your-secret-key');
    
//     const roleName = ROLE_REVERSE_MAP[decoded.role];
//     if (!roleName) {
//       console.log(`❌ Invalid role in token: ${decoded.role}`);
//       throw new Error('Invalid role in token');
//     }
    
//     console.log(`✅ Token verified for user: ${decoded.userId}, role: ${roleName}`);
    
//     return {
//       userId: decoded.userId,
//       role: decoded.role,
//       roleName: roleName,
//       isStreamer: decoded.role === 2,
//       isValid: true
//     };
//   } catch (error) {
//     console.error("WebSocket token verification failed:", error.message);
//     return null;
//   }
// };

// // ✅ FULLY FIXED: Parse and validate query parameters with 100% correct boolean parsing
// function parseAndValidateParams(urlString) {
//   try {
//     console.log(`🔍 Parsing URL: ${urlString}`);
    
//     // Create URL object properly
//     const baseUrl = 'ws://localhost';
//     const fullUrl = urlString.startsWith('/') 
//       ? `${baseUrl}${urlString}` 
//       : `${baseUrl}/${urlString}`;
//     const url = new URL(fullUrl);
    
//     const params = {};
    
//     // 🔴 CRITICAL FIX: Log ALL raw query parameters first
//     console.log('📥 Raw query string:', url.searchParams.toString());
    
//     // Extract ALL query parameters with CORRECT type conversion
//     for (const [key, value] of url.searchParams.entries()) {
//       try {
//         const cleanValue = value.trim();
        
//         // 🚨🚨🚨 CRITICAL: Boolean parsing - MULTIPLE checks!
//         if (cleanValue === 'true' || cleanValue === 'false' || 
//             cleanValue === '1' || cleanValue === '0' ||
//             cleanValue === 'yes' || cleanValue === 'no') {
          
//           // Convert to boolean with multiple conditions
//           params[key] = (
//             cleanValue === 'true' || 
//             cleanValue === '1' || 
//             cleanValue === 'yes'
//           );
          
//           console.log(`🔵 Boolean param ${key}: raw="${cleanValue}" → parsed=${params[key]}`);
//         }
//         // Number parsing
//         else if (!isNaN(cleanValue) && cleanValue !== '') {
//           params[key] = Number(cleanValue);
//           console.log(`🔢 Number param ${key}: raw="${cleanValue}" → parsed=${params[key]}`);
//         }
//         // JSON parsing
//         else if (cleanValue.startsWith('{') || cleanValue.startsWith('[')) {
//           try {
//             params[key] = JSON.parse(cleanValue);
//             console.log(`📦 JSON param ${key}: parsed successfully`);
//           } catch (parseErr) {
//             params[key] = cleanValue;
//             console.log(`📄 String param ${key}: raw="${cleanValue}" (JSON parse failed)`);
//           }
//         }
//         // Default: string
//         else {
//           params[key] = cleanValue;
//           console.log(`📄 String param ${key}: raw="${cleanValue}"`);
//         }
//       } catch (parseError) {
//         params[key] = value;
//         console.log(`⚠️ Fallback param ${key}: raw="${value}"`);
//       }
//     }
    
//     // 🚨🚨🚨 CRITICAL: Double-check boolean parameters explicitly!
//     // This ensures they're ALWAYS booleans regardless of how they were parsed
//     const BOOLEAN_PARAMS = ['isStreamer', 'allowViewersToDraw', 'isViewer', 'canDraw'];
    
//     BOOLEAN_PARAMS.forEach(param => {
//       if (param in params) {
//         const originalValue = params[param];
//         // Force convert to boolean
//         params[param] = (
//           originalValue === true || 
//           originalValue === 'true' || 
//           originalValue === '1' || 
//           originalValue === 'yes' ||
//           originalValue === 1 ||
//           String(originalValue).toLowerCase() === 'true'
//         );
        
//         if (originalValue !== params[param]) {
//           console.log(`⚠️ Forced boolean conversion for ${param}: ${originalValue} → ${params[param]}`);
//         }
//       }
//     });
    
//     // Log all parsed params
//     console.log('📊 FINAL PARSED PARAMS:', Object.fromEntries(
//       Object.entries(params).map(([k, v]) => [k, v])
//     ));
    
//     // Token verification
//     if (!params.token) {
//       console.error('❌ Token is required but not found in query params');
//       throw new Error('Token is required');
//     }
    
//     // Verify JWT token
//     const tokenData = verifyWebSocketToken(params.token);
//     if (!tokenData || !tokenData.isValid) {
//       console.error('❌ Invalid or expired token');
//       throw new Error('Invalid or expired token');
//     }
    
//     // 🚨🚨🚨 CRITICAL: Get boolean values with FALLBACKS
//     // Check MULTIPLE sources for the boolean value
    
//     // For allowViewersToDraw: check URL param first, then token data, then default to false
//     let allowViewersToDraw = false;
//     if ('allowViewersToDraw' in params) {
//       allowViewersToDraw = params.allowViewersToDraw === true;
//     } else if (tokenData.allowViewersToDraw !== undefined) {
//       allowViewersToDraw = tokenData.allowViewersToDraw === true;
//     }
    
//     // For isStreamer: check URL param, then token role, then default to false
//     let isStreamer = false;
//     if ('isStreamer' in params) {
//       isStreamer = params.isStreamer === true;
//     } else {
//       isStreamer = tokenData.isStreamer === true;
//     }
    
//     // ALSO check token role directly
//     if (tokenData.role === 2) {
//       isStreamer = true;
//       console.log('🎤 User is STREAMER based on token role');
//     }
    
//     console.log(`🎨 FINAL - Viewer drawing permission: ${allowViewersToDraw ? 'ENABLED' : 'DISABLED'}`);
//     console.log(`👤 FINAL - User role: ${isStreamer ? 'STREAMER' : 'VIEWER'}`);
    
//     // Extract user info with proper defaults
//     const userId = params.userId || tokenData.userId || `user_${Date.now()}`;
//     const userName = params.userName || tokenData.userName || `User_${userId.substring(0, 6)}`;
//     const roomName = params.roomName || 'Whiteboard Session';
//     const roomCode = params.roomCode || '';
    
//     // 🚨🚨🚨 CRITICAL: Set permissions based on CORRECT boolean values
//     let permissions = {};
    
//     if (isStreamer) {
//       // Streamer has FULL permissions
//       permissions = {
//         canDraw: true,
//         canEdit: true,
//         canDelete: true,
//         canClear: true,
//         canChat: true,
//         canExport: true,
//         canImport: true,
//         canCreate: true,
//         canManage: true
//       };
//       console.log('🎤 Streamer permissions: FULL ACCESS');
//     } else {
//       // Viewer permissions - drawing depends on allowViewersToDraw
//       permissions = {
//         canDraw: allowViewersToDraw,
//         canEdit: allowViewersToDraw,
//         canDelete: false,
//         canClear: false,
//         canChat: true,
//         canExport: true,
//         canImport: false,
//         canCreate: false,
//         canManage: false
//       };
//       console.log(`👀 Viewer permissions: ${allowViewersToDraw ? 'CAN DRAW' : 'VIEW ONLY'}`);
//     }
    
//     // Override with custom permissions if provided (from URL or token)
//     if (params.permissions) {
//       try {
//         const customPerms = typeof params.permissions === 'string' 
//           ? JSON.parse(params.permissions) 
//           : params.permissions;
//         permissions = { ...permissions, ...customPerms };
//         console.log('📝 Custom permissions applied:', customPerms);
//       } catch (e) {
//         console.warn('⚠️ Failed to parse custom permissions:', e.message);
//       }
//     }
    
//     // ✅ Generate UNIQUE client ID for this connection
//     const clientId = generateUniqueClientId(userId, Date.now());
    
//     console.log('🔐 FINAL PERMISSIONS:', permissions);
    
//     return {
//       // Token data
//       userId: userId,
//       role: tokenData.role,
//       roleName: tokenData.roleName,
//       isStreamer: isStreamer,
      
//       // User info
//       userName,
//       roomName,
//       roomCode,
      
//       // ✅ CRITICAL: Room settings - ALWAYS boolean
//       allowViewersToDraw: allowViewersToDraw === true,
      
//       // Permissions
//       permissions,
      
//       // Unique client ID for Yjs awareness
//       clientId,
      
//       // Raw params for debugging
//       rawParams: { ...params },
      
//       // Timestamp
//       connectedAt: new Date().toISOString()
//     };
    
//   } catch (e) {
//     console.error('❌ Error parsing/validating params:', e.message);
//     console.error('Stack:', e.stack);
//     return null;
//   }
// }

// // ✅ Helper function to generate UNIQUE client ID for Yjs awareness
// function generateUniqueClientId(userId, timestamp) {
//   // Create hash from userId
//   let hash = 0;
//   for (let i = 0; i < userId.length; i++) {
//     hash = ((hash << 5) - hash) + userId.charCodeAt(i);
//     hash |= 0; // Convert to 32-bit integer
//   }
//   hash = Math.abs(hash);
  
//   // Combine timestamp, random, and hash
//   const random = Math.floor(Math.random() * 1000000);
//   const combined = `${timestamp % 10000000}${random % 10000000}${hash % 10000000}`;
  
//   // Ensure it's a positive 32-bit integer (Yjs requirement)
//   const clientId = Number(combined.slice(0, 15)) % 2147483647;
  
//   console.log('🆔 Generated unique client ID:', {
//     userId: userId.substring(0, 8) + '...',
//     timestamp: timestamp % 10000000,
//     random: random % 10000000,
//     hash: hash % 10000000,
//     clientId
//   });
  
//   return clientId;
// }
// // Check room permissions
// function checkRoomPermissions(userParams, room) {
//   if (!room) {
//     console.log('🆕 No existing room, creating new one');
//     return true;
//   }
  
//   const { userId, isStreamer } = userParams;
  
//   // Streamer always has full access to their own room
//   if (isStreamer && room.createdBy === userId) {
//     console.log('✅ Streamer rejoining own room');
//     return true;
//   }
  
//   // Check if trying to join as streamer but room already has a different streamer
//   if (isStreamer && room.createdBy && room.createdBy !== userId) {
//     console.log(`🚫 Multiple streamers not allowed in room ${room.sessionInfo?.sessionId}`);
//     return false;
//   }
  
//   console.log('✅ Permission check passed');
//   return true;
// }

// // ✅ FIXED: Enhanced room creation with proper settings propagation
// function getRoom(sessionId, userParams = null) {
//   console.log(`🔍 Getting room for session: ${sessionId}`);
  
//   let room = activeRooms.get(sessionId);
  
//   // Create new room if it doesn't exist
//   if (!room && userParams) {
//     console.log(`🆕 Creating NEW room: ${sessionId}`);
//     console.log(`🎨 Room settings - allowViewersToDraw: ${userParams.allowViewersToDraw}`);
    
//     let doc, awareness, clients;
//     try {
//       doc = new Y.Doc();
//       console.log('✅ Step 1: Y.Doc created');
      
//       awareness = new awarenessProtocol.Awareness(doc);
//       console.log(`✅ Step 2: Awareness created with clientID: ${awareness.clientID}`);
      
//       clients = new Map();
//       console.log('✅ Step 3: Clients map created');
      
//     } catch (error) {
//       console.error(`❌ FAILED to create room components for ${sessionId}:`, error);
//       console.error('Error stack:', error.stack);
//       return null;
//     }
    
//     // Create room object with ALL settings
//     room = { 
//       doc, 
//       awareness,
//       clients,
//       createdBy: userParams.userId,
//       createdByName: userParams.userName,
//       allowViewersToDraw: userParams.allowViewersToDraw, // ✅ CRITICAL: Store this
//       sessionInfo: {
//         sessionId,
//         title: userParams.roomName,
//         roomCode: userParams.roomCode,
//         streamerName: userParams.userName,
//         streamerId: userParams.userId,
//         createdAt: new Date().toISOString(),
//         allowViewersToDraw: userParams.allowViewersToDraw, // ✅ CRITICAL: Store in sessionInfo too
//         maxParticipants: 50
//       },
//       userPermissions: new Map(),
//       stats: {
//         totalConnections: 0,
//         totalDraws: 0,
//         lastActivity: new Date().toISOString()
//       }
//     };
    
//     // Store in activeRooms
//     activeRooms.set(sessionId, room);
//     console.log(`✅ Step 4: Room ${sessionId} saved to activeRooms`);
    
//     // Add creator's permissions
//     if (userParams.userId) {
//       room.userPermissions.set(userParams.userId, userParams.permissions);
//       console.log('✅ Step 5: Creator permissions added');
//     }
    
//     // ✅ CRITICAL: Initialize Yjs shared data structures with room settings
//     try {
//       const ySettings = doc.getMap('room_settings');
//       ySettings.set('allowViewersToDraw', userParams.allowViewersToDraw);
//       ySettings.set('streamerId', userParams.userId);
//       ySettings.set('streamerName', userParams.userName);
//       ySettings.set('createdAt', new Date().toISOString());
//       ySettings.set('updatedAt', new Date().toISOString());
//       console.log('✅ Step 6: Room settings saved to Yjs:', {
//         allowViewersToDraw: userParams.allowViewersToDraw,
//         streamerId: userParams.userId,
//         streamerName: userParams.userName
//       });
      
//       // Initialize whiteboard array with empty state
//       const yCanvasArray = doc.getArray('whiteboard');
//       if (yCanvasArray.length === 0) {
//         const initialState = {
//           version: '5.3.0',
//           objects: [],
//           background: '#ffffff',
//           sessionId: sessionId,
//           allowViewersToDraw: userParams.allowViewersToDraw,
//           createdAt: new Date().toISOString(),
//           updatedBy: userParams.userId
//         };
//         yCanvasArray.insert(0, [initialState]);
//         console.log('✅ Step 7: Canvas array initialized');
//       }
      
//     } catch (error) {
//       console.error('❌ Error initializing Yjs data structures:', error);
//     }
    
//     console.log(`✨ FINISHED: Room ${sessionId} created successfully!`);
    
//     // ✅ FIXED: Awareness updates handler with proper broadcast
//     awareness.on("update", ({ added, updated, removed }, origin) => {
//       try {
//         const changedClients = added.concat(updated, removed);
//         const encoder = encoding.createEncoder();
//         encoding.writeVarUint(encoder, messageAwareness);
        
//         encoding.writeVarUint8Array(
//           encoder,
//           awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
//         );
        
//         const buff = encoding.toUint8Array(encoder);

//         room.clients.forEach((userInfo, client) => {
//           if (client !== origin && client.readyState === 1) {
//             client.send(buff);
//           }
//         });
//       } catch (error) {
//         console.error('❌ Error in awareness update handler:', error);
//       }
//     });

//     // ✅ FIXED: Document update handler with proper origin tracking
//     doc.on('update', (update, origin) => {
//       try {
//         room.stats.lastActivity = new Date().toISOString();
        
//         // Update stats
//         if (origin && room.clients.has(origin)) {
//           const userInfo = room.clients.get(origin);
//           room.stats.totalDraws++;
//           userInfo.lastActive = new Date().toISOString();
//           userInfo.totalActions = (userInfo.totalActions || 0) + 1;
//         }

//         // Broadcast the update to all other clients
//         const encoder = encoding.createEncoder();
//         encoding.writeVarUint(encoder, messageSync);
//         syncProtocol.writeUpdate(encoder, update);
//         const message = encoding.toUint8Array(encoder);

//         let broadcastCount = 0;
//         room.clients.forEach((userInfo, client) => {
//           if (client !== origin && client.readyState === 1) {
//             client.send(message);
//             broadcastCount++;
//           }
//         });
        
//         if (broadcastCount > 0) {
//           console.log(`📡 Broadcasted update to ${broadcastCount} clients`);
//         }
//       } catch (error) {
//         console.error('❌ Error in document update handler:', error);
//       }
//     });

//   } else if (room) {
//     console.log(`🔄 Joining EXISTING room: ${sessionId}`);
//     console.log('📊 Room current settings:', {
//       allowViewersToDraw: room.allowViewersToDraw,
//       streamer: room.createdByName,
//       clientCount: room.clients?.size || 0
//     });
    
//     // ✅ FIXED: Update existing room if streamer reconnects with new settings
//     if (userParams && userParams.isStreamer && room.createdBy === userParams.userId) {
//       // Update room settings if changed
//       if (room.allowViewersToDraw !== userParams.allowViewersToDraw) {
//         console.log(`🔄 Streamer changing room settings: allowViewersToDraw = ${userParams.allowViewersToDraw}`);
        
//         room.allowViewersToDraw = userParams.allowViewersToDraw;
//         room.sessionInfo.allowViewersToDraw = userParams.allowViewersToDraw;
        
//         // Update Yjs room settings
//         try {
//           const ySettings = room.doc.getMap('room_settings');
//           ySettings.set('allowViewersToDraw', userParams.allowViewersToDraw);
//           ySettings.set('updatedAt', new Date().toISOString());
//           ySettings.set('updatedBy', userParams.userId);
//           console.log('✅ Room settings updated in Yjs');
//         } catch (error) {
//           console.error('❌ Error updating room settings in Yjs:', error);
//         }
//       }
      
//       // Update streamer info
//       room.sessionInfo.title = userParams.roomName || room.sessionInfo.title;
//       room.sessionInfo.streamerName = userParams.userName || room.sessionInfo.streamerName;
//     }
    
//     // Store user permissions
//     if (userParams && userParams.userId) {
//       room.userPermissions.set(userParams.userId, userParams.permissions);
//     }
//   }
  
//   return room;
// }

// function sendSyncStep1(ws, doc) {
//   try {
//     const encoder = encoding.createEncoder();
//     encoding.writeVarUint(encoder, messageSync);
//     syncProtocol.writeSyncStep1(encoder, doc);
    
//     const message = encoding.toUint8Array(encoder);
//     if (ws.readyState === 1) {
//       ws.send(message);
//       console.log('✅ Sent sync step 1');
//     }
//   } catch (error) {
//     console.error('❌ Error sending sync step 1:', error);
//   }
// }

// function sendSyncStep2(ws, doc, update) {
//   try {
//     const encoder = encoding.createEncoder();
//     encoding.writeVarUint(encoder, messageSync);
//     syncProtocol.writeSyncStep2(encoder, doc, update);
//     const message = encoding.toUint8Array(encoder);
//     if (ws.readyState === 1) {
//       ws.send(message);
//     }
//   } catch (error) {
//     console.error('❌ Error sending sync step 2:', error);
//   }
// }

// function sendAwarenessStates(ws, awareness, clientIDs) {
//   try {
//     const encoder = encoding.createEncoder();
//     encoding.writeVarUint(encoder, messageAwareness);
//     encoding.writeVarUint8Array(
//       encoder,
//       awarenessProtocol.encodeAwarenessUpdate(awareness, clientIDs)
//     );
//     const message = encoding.toUint8Array(encoder);
//     if (ws.readyState === 1) {
//       ws.send(message);
//     }
//   } catch (error) {
//     console.error('❌ Error sending awareness states:', error);
//   }
// }

// // ✅ FIXED: Setup connection handlers with proper permission propagation
// // ✅ FIXED: Setup connection handlers with UNIQUE awareness clientID
// function setupConnectionHandlers(ws, room, sessionId, userParams) {
//   try {
//     console.log(`🔗 Setting up connection handlers for ${userParams.userName} (${userParams.roleName})`);
    
//     // Validate room structure
//     if (!room) {
//       console.error(`❌ CRITICAL: Room ${sessionId} is null`);
//       ws.close(1011, 'Room not found');
//       return;
//     }
    
//     if (!room.awareness) {
//       console.error(`❌ CRITICAL: Room ${sessionId} missing awareness object`);
//       try {
//         room.awareness = new awarenessProtocol.Awareness(room.doc);
//         console.log(`✅ Emergency awareness created with clientID: ${room.awareness.clientID}`);
//       } catch (error) {
//         console.error('❌ Emergency awareness creation failed:', error);
//         ws.close(1011, 'Server configuration error');
//         return;
//       }
//     }
    
//     // Increment connection counter
//     room.stats.totalConnections++;
    
//     // Store user info with the connection
//     const userInfo = {
//       userId: userParams.userId,
//       userName: userParams.userName,
//       role: userParams.role,
//       roleName: userParams.roleName,
//       isStreamer: userParams.isStreamer,
//       permissions: userParams.permissions,
//       joinedAt: new Date().toISOString(),
//       lastActive: new Date().toISOString(),
//       totalActions: 0,
//       connectionId: `${userParams.userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
//     };
//     room.clients.set(ws, userInfo);
    
//     // Attach user info to WebSocket
//     ws.userId = userParams.userId;
//     ws.userName = userParams.userName;
//     ws.isStreamer = userParams.isStreamer;
//     ws.role = userParams.role;
//     ws.permissions = userParams.permissions;
    
//     // 🚨🚨🚨 CRITICAL FIX: Generate TRULY UNIQUE awareness clientID
//     // Yjs awareness expects clientID to be a number, but it MUST be unique per connection
//     // Use timestamp + random + userID hash to guarantee uniqueness
    
//     const timestamp = Date.now();
//     const random = Math.floor(Math.random() * 1000000);
//     const userIdHash = Array.from(userParams.userId).reduce((acc, char) => acc + char.charCodeAt(0), 0);
    
//     // Generate a unique number that won't conflict
//     const uniqueClientID = Number(`${timestamp % 1000000}${random % 1000000}${userIdHash % 1000}`) % 2147483647;
    
//     ws.awarenessClientID = uniqueClientID;
    
//     console.log(`✅ Assigned UNIQUE awareness clientID: ${ws.awarenessClientID} to ${userParams.userName}`);
//     console.log(`   - Timestamp part: ${timestamp % 1000000}`);
//     console.log(`   - Random part: ${random % 1000000}`);
//     console.log(`   - User hash: ${userIdHash % 1000}`);

//     // ✅ IMPORTANT: Yjs awareness ke liye clientID set karo
//     // Agar pehle se koi clientID hai to use overwrite karo
//     if (room.awareness && typeof room.awareness.setLocalState === 'function') {
//       // Pehle purani state clear karo agar ye reconnection hai
//       try {
//         // Agar ye existing connection hai to purani awareness state remove karo
//         room.clients.forEach((existingUserInfo, existingClient) => {
//           if (existingClient !== ws && existingClient.awarenessClientID && 
//               existingClient.userId === userParams.userId) {
//             console.log(`🧹 Removing old awareness state for ${userParams.userName}`);
//             awarenessProtocol.removeAwarenessStates(
//               room.awareness, 
//               [existingClient.awarenessClientID], 
//               ws
//             );
//           }
//         });
//       } catch (cleanupError) {
//         console.error('❌ Error cleaning up old awareness:', cleanupError);
//       }
//     }

//     // Set initial awareness state with UNIQUE clientID
//     const awarenessState = {
//       userId: userParams.userId,
//       userName: userParams.userName,
//       role: userParams.role,
//       isStreamer: userParams.isStreamer,
//       cursorPosition: { x: 0, y: 0 },
//       currentTool: 'select',
//       color: '#000000',
//       permissions: userParams.permissions,
//       lastActive: new Date().toISOString(),
//       allowViewersToDraw: room.allowViewersToDraw,
//       clientId: ws.awarenessClientID, // Store in state for debugging
//       connectionTime: new Date().toISOString()
//     };
    
//     try {
//       if (room.awareness && typeof room.awareness.setLocalState === 'function') {
//         // 🚨 CRITICAL: Yjs awareness clientID set karo
//         // Ye hacky hai but kaam karta hai
//         if (room.awareness.clientID !== ws.awarenessClientID) {
//           console.log(`🔄 Overwriting awareness clientID from ${room.awareness.clientID} to ${ws.awarenessClientID}`);
//           // @ts-ignore - Yjs awareness allows setting clientID internally
//           room.awareness.clientID = ws.awarenessClientID;
//         }
        
//         room.awareness.setLocalState(awarenessState);
//         console.log(`✅ Awareness state set for ${userParams.userName} with clientID: ${room.awareness.clientID}`);
//       }
//     } catch (awarenessError) {
//       console.error('❌ Error setting awareness state:', awarenessError);
      
//       // Fallback: Try to create new awareness if failed
//       try {
//         console.log('🔄 Attempting to recreate awareness...');
//         const newAwareness = new awarenessProtocol.Awareness(room.doc);
//         // @ts-ignore
//         newAwareness.clientID = ws.awarenessClientID;
//         room.awareness = newAwareness;
//         room.awareness.setLocalState(awarenessState);
//         console.log('✅ Awareness recreated and state set');
//       } catch (fallbackError) {
//         console.error('❌ Fallback also failed:', fallbackError);
//       }
//     }

//     // Send initial sync
//     sendSyncStep1(ws, room.doc);
    
//     // Send current awareness states
//     if (room.awareness) {
//       const states = Array.from(room.awareness.getStates().keys());
//       if (states.length > 0) {
//         sendAwarenessStates(ws, room.awareness, states);
//       }
//     }

//     // Broadcast user joined with room settings
//     const joinMessage = JSON.stringify({
//       type: 'user_joined',
//       userId: userParams.userId,
//       userName: userParams.userName,
//       role: userParams.roleName,
//       isStreamer: userParams.isStreamer,
//       timestamp: new Date().toISOString(),
//       totalParticipants: room.clients.size,
//       roomSettings: {
//         allowViewersToDraw: room.allowViewersToDraw,
//         streamerId: room.createdBy,
//         streamerName: room.createdByName
//       },
//       clientId: ws.awarenessClientID // Send for debugging
//     });
    
//     room.clients.forEach((clientInfo, client) => {
//       if (client !== ws && client.readyState === 1) {
//         client.send(joinMessage);
//       }
//     });
    
//     // ✅ FIXED: Handle incoming messages with proper sync
//     ws.on("message", (data) => {
//       try {
//         userInfo.lastActive = new Date().toISOString();
        
//         const uint8 = data instanceof Buffer ? new Uint8Array(data) : data;
//         const decoder = decoding.createDecoder(uint8);
//         const messageType = decoding.readVarUint(decoder);

//         if (messageType === messageSync) {
//           const encoder = encoding.createEncoder();
//           encoding.writeVarUint(encoder, messageSync);

//           // Pass ws as origin for doc update tracking
//           const syncMessageType = syncProtocol.readSyncMessage(
//             decoder, 
//             encoder, 
//             room.doc, 
//             ws 
//           );

//           const reply = encoding.toUint8Array(encoder);
//           if (reply.length > 1 && ws.readyState === 1) {
//             ws.send(reply);
//           }
//           return;
//         }

//         if (messageType === messageAwareness) {
//           if (!room.awareness) return;
          
//           const update = decoding.readVarUint8Array(decoder);
          
//           try {
//             if (room.awareness && typeof room.awareness.getLocalState === 'function') {
//               const currentState = room.awareness.getLocalState();
//               if (currentState) {
//                 room.awareness.setLocalState({
//                   ...currentState,
//                   lastActive: new Date().toISOString()
//                 });
//               }
//             }
//           } catch (stateError) {
//             console.error('Error updating awareness state:', stateError);
//           }
          
//           awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
//           return;
//         }
        
//         // Handle custom JSON messages
//         try {
//           const textData = data.toString();
//           if (textData.startsWith('{') || textData.startsWith('[')) {
//             const jsonData = JSON.parse(textData);
//             jsonData.userId = userParams.userId;
//             jsonData.userName = userParams.userName;
//             jsonData.timestamp = new Date().toISOString();
            
//             // Broadcast to other clients
//             const broadcastMessage = JSON.stringify(jsonData);
//             room.clients.forEach((clientInfo, client) => {
//               if (client !== ws && client.readyState === 1) {
//                 client.send(broadcastMessage);
//               }
//             });
//           }
//         } catch (jsonError) {
//           // Not a JSON message, ignore
//         }
        
//       } catch (err) {
//         console.error("❌ Yjs WS message error:", err?.message || err);
//       }
//     });

//     // ✅ FIXED: Clean disconnect handling
//     ws.on("close", () => {
//       const userInfo = room.clients.get(ws);
//       const userName = userInfo?.userName || 'Unknown';
//       const roleName = userInfo?.roleName || 'viewer';
      
//       console.log(`🔌 Yjs client left: ${userName} (${roleName}) from ${sessionId}`);
//       console.log(`   - ClientID: ${ws.awarenessClientID}`);
      
//       // Remove from clients map
//       room.clients.delete(ws);
      
//       // Remove user permissions
//       if (userInfo?.userId) {
//         room.userPermissions.delete(userInfo.userId);
//       }

//       // 🚨 CRITICAL: Remove awareness state with EXACT clientID
//       try {
//         if (ws.awarenessClientID != null && room.awareness) {
//           console.log(`🧹 Removing awareness state for clientID: ${ws.awarenessClientID}`);
//           awarenessProtocol.removeAwarenessStates(
//             room.awareness, 
//             [ws.awarenessClientID], 
//             ws
//           );
//         }
//       } catch (e) {
//         console.error("❌ Error removing awareness states:", e);
//       }

//       // Broadcast user left message
//       const leaveMessage = JSON.stringify({
//         type: 'user_left',
//         userId: userInfo?.userId,
//         userName: userName,
//         timestamp: new Date().toISOString(),
//         totalParticipants: room.clients.size,
//         clientId: ws.awarenessClientID
//       });
      
//       room.clients.forEach((clientInfo, client) => {
//         if (client.readyState === 1) {
//           client.send(leaveMessage);
//         }
//       });
      
//       console.log(`👥 Remaining in room ${sessionId}: ${room.clients.size}`);

//       // Cleanup empty room after 1 minute
//       if (room.clients.size === 0) {
//         console.log(`⏳ Room ${sessionId} is empty, will delete in 1 minute if no one joins`);
//         setTimeout(() => {
//           if (room.clients.size === 0) {
//             activeRooms.delete(sessionId);
//             console.log(`🧹 Yjs Room deleted: ${sessionId}`);
//           }
//         }, 60000);
//       }
//     });

//     ws.on("error", (error) => {
//       console.error(`❌ WebSocket error for ${userParams.userName} in ${sessionId}:`, error.message);
//     });

//     // ✅ FIXED: Enhanced welcome message with clientID
//     const welcomeMessage = JSON.stringify({
//       type: 'welcome',
//       sessionId: sessionId,
//       roomInfo: {
//         ...room.sessionInfo,
//         allowViewersToDraw: room.allowViewersToDraw
//       },
//       yourInfo: {
//         userId: userParams.userId,
//         userName: userParams.userName,
//         role: userParams.roleName,
//         isStreamer: userParams.isStreamer,
//         permissions: userParams.permissions,
//         clientId: ws.awarenessClientID
//       },
//       roomSettings: {
//         allowViewersToDraw: room.allowViewersToDraw,
//         streamerId: room.createdBy,
//         streamerName: room.createdByName
//       },
//       totalParticipants: room.clients.size,
//       serverTime: new Date().toISOString()
//     });
    
//     if (ws.readyState === 1) {
//       ws.send(welcomeMessage);
//     }
    
//     console.log(`✅ ${userParams.userName} (${userParams.roleName}) connected to room ${sessionId}. Total: ${room.clients.size}`);
//     console.log(`🎨 Room settings: allowViewersToDraw = ${room.allowViewersToDraw}`);
//     console.log(`🆔 ClientID: ${ws.awarenessClientID}`);
    
//   } catch (error) {
//     console.error(`❌ Error in setupConnectionHandlers for ${sessionId}:`, error);
//     try {
//       const errorMessage = JSON.stringify({
//         type: 'error',
//         message: 'Server error setting up connection',
//         timestamp: new Date().toISOString()
//       });
//       if (ws.readyState === 1) {
//         ws.send(errorMessage);
//         ws.close(1011, 'Server error');
//       }
//     } catch (closeError) {
//       // Ignore
//     }
//   }
// }

// // Get room info (for monitoring/debugging)
// export function getActiveRoomsInfo() {
//   const roomsInfo = [];
//   activeRooms.forEach((room, sessionId) => {
//     const clientsInfo = Array.from(room.clients.values()).map(client => ({
//       userId: client.userId,
//       userName: client.userName,
//       role: client.roleName,
//       isStreamer: client.isStreamer,
//       joinedAt: client.joinedAt,
//       lastActive: client.lastActive,
//       permissions: client.permissions
//     }));
    
//     roomsInfo.push({
//       sessionId,
//       createdBy: room.createdByName,
//       allowViewersToDraw: room.allowViewersToDraw,
//       totalClients: room.clients.size,
//       clients: clientsInfo,
//       sessionInfo: room.sessionInfo,
//       stats: room.stats
//     });
//   });
//   return roomsInfo;
// }

// // Debug function to monitor rooms
// function debugRoomCreation() {
//   console.log('\n=== DEBUG ROOM STATUS ===');
//   console.log('Active rooms count:', activeRooms.size);
//   activeRooms.forEach((room, sessionId) => {
//     console.log(`\n📁 Room: ${sessionId}`);
//     console.log(`  - Streamer: ${room.createdByName}`);
//     console.log(`  - Allow Viewers to Draw: ${room.allowViewersToDraw}`);
//     console.log(`  - Clients: ${room.clients?.size || 0}`);
//     console.log(`  - Total Draws: ${room.stats?.totalDraws || 0}`);
//     console.log(`  - Last Activity: ${room.stats?.lastActivity || 'Never'}`);
//   });
//   console.log('==========================\n');
// }

// // ✅ FIXED: Main WebSocket server setup
// export function setupYWebsocketCompatibleServer(httpServer) {
//   console.log('🚀 Setting up Yjs WebSocket server...');
  
//   // Debug room status every 30 seconds
//   setInterval(debugRoomCreation, 30000);
  
//   const wss = new WebSocketServer({ 
//     noServer: true,
//     clientTracking: false,
//     perMessageDeflate: {
//       zlibDeflateOptions: {
//         chunkSize: 1024,
//         memLevel: 7,
//         level: 3
//       },
//       zlibInflateOptions: {
//         chunkSize: 10 * 1024
//       },
//       clientNoContextTakeover: true,
//       serverNoContextTakeover: true,
//       serverMaxWindowBits: 10,
//       concurrencyLimit: 10,
//       threshold: 1024
//     }
//   });

//   httpServer.on("upgrade", (request, socket, head) => {
//     try {
//       const url = request.url;
//       console.log(`📡 WebSocket upgrade request: ${url}`);
      
//       // Ignore socket.io
//       if (url.startsWith("/socket.io/")) {
//         return;
//       }
      
//       // Only handle /yjs/ paths for Yjs
//       if (!url.startsWith("/yjs/")) {
//         console.log("❌ Yjs WS rejected: Invalid path", url);
//         socket.destroy();
//         return;
//       }

//       // Extract sessionId from URL path
//       const pathParts = url.split('/');
//       const sessionId = pathParts[2]?.split('?')[0];
      
//       if (!sessionId || sessionId.length < 5) {
//         console.log("❌ Yjs WS rejected: Invalid sessionId", sessionId);
//         socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
//         socket.destroy();
//         return;
//       }

//       console.log(`🔍 Processing Yjs connection for session: ${sessionId}`);
      
//       // Parse and validate authentication parameters
//       const userParams = parseAndValidateParams(url);
//       if (!userParams) {
//         console.log("❌ Yjs WS rejected: Invalid authentication for session", sessionId);
//         socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
//         socket.destroy();
//         return;
//       }

//       // Get or create room
//       const room = getRoom(sessionId, userParams);
//       if (!room) {
//         console.log(`❌ Failed to get/create room for session: ${sessionId}`);
//         socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
//         socket.destroy();
//         return;
//       }
      
//       if (!room.awareness) {
//         console.log(`❌ Room created but missing awareness for session: ${sessionId}`);
//         socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
//         socket.destroy();
//         return;
//       }
      
//       // Check permissions
//       if (!checkRoomPermissions(userParams, room)) {
//         console.log(`🚫 Permission denied for ${userParams.userName} in room ${sessionId}`);
//         socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
//         socket.destroy();
//         return;
//       }

//       // Handle the upgrade
//       wss.handleUpgrade(request, socket, head, (ws) => {
//         ws.sessionId = sessionId;
//         wss.emit("connection", ws, request);
        
//         // Setup connection handlers with authenticated user info
//         setupConnectionHandlers(ws, room, sessionId, userParams);
//       });
//     } catch (e) {
//       console.error("❌ Yjs WS upgrade error:", e.message);
//       console.error('Stack:', e.stack);
//       socket.destroy();
//     }
//   });

//   wss.on("connection", (ws) => {
//     console.log(`📡 New Yjs WebSocket connection established for session: ${ws.sessionId}`);
//   });

//   wss.on("error", (error) => {
//     console.error("❌ Yjs WebSocket server error:", error.message);
//   });

//   wss.on("close", () => {
//     console.log("🔴 Yjs WebSocket server closed");
//   });

//   console.log("✅ Yjs WebSocket Server with JWT Authentication enabled on /yjs/:sessionId");
//   console.log("🎨 Viewer drawing permission propagation FIXED");
  
//   return {
//     cleanup: () => {
//       console.log("🧹 Cleaning up Yjs WebSocket server...");
//       wss.clients.forEach((client) => {
//         try {
//           client.close(1000, "Server shutdown");
//         } catch (error) {
//           // Ignore close errors
//         }
//       });
//       wss.close();
//       activeRooms.clear();
//     },
//     getStats: () => {
//       return {
//         totalRooms: activeRooms.size,
//         totalConnections: Array.from(activeRooms.values()).reduce(
//           (sum, room) => sum + room.clients.size, 0
//         ),
//         rooms: getActiveRoomsInfo()
//       };
//     },
//     getRoom: (sessionId) => {
//       return activeRooms.get(sessionId);
//     }
//   };
// }

// // Health check endpoint for monitoring
// export function getYjsHealth(req, res) {
//   try {
//     const stats = {
//       status: 'healthy',
//       timestamp: new Date().toISOString(),
//       totalRooms: activeRooms.size,
//       totalConnections: Array.from(activeRooms.values()).reduce(
//         (sum, room) => sum + room.clients.size, 0
//       ),
//       rooms: getActiveRoomsInfo(),
//       uptime: process.uptime()
//     };
//     res.json(stats);
//   } catch (error) {
//     res.status(500).json({
//       status: 'error',
//       message: error.message
//     });
//   }
// }

// export default {
//   setupYWebsocketCompatibleServer,
//   getYjsHealth,
//   getActiveRoomsInfo
// };