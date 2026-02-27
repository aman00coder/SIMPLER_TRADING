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
//   ADMIN: 1,
//   STREAMER: 2,
//   VIEWER: 3,
// };

// const ROLE_REVERSE_MAP = {
//   1: "ADMIN",
//   2: "STREAMER",
//   3: "VIEWER",
// };

// // JWT Verification for WebSocket
// const verifyWebSocketToken = (token) => {
//   try {
//     if (!token || token === "undefined" || token === "null") {
//       console.log("❌ Token is missing or invalid");
//       return null;
//     }

//     const cleanToken = token.replace(/['"]/g, "").trim();

//     if (!cleanToken || cleanToken.length < 10) {
//       console.log("❌ Token is too short");
//       return null;
//     }

//     const decoded = jwt.verify(
//       cleanToken,
//       process.env.SECRET_KEY || "your-secret-key"
//     );

//     const roleName = ROLE_REVERSE_MAP[decoded.role];
//     if (!roleName) {
//       console.log(`❌ Invalid role in token: ${decoded.role}`);
//       throw new Error("Invalid role in token");
//     }

//     console.log(`✅ Token verified for user: ${decoded.userId}, role: ${roleName}`);

//     return {
//       userId: decoded.userId,
//       role: decoded.role,
//       roleName: roleName,
//       isStreamer: decoded.role === 2,
//       isValid: true,
//       userName:
//         decoded.name ||
//         decoded.userName ||
//         `User_${decoded.userId?.substring(0, 4)}`,
//     };
//   } catch (error) {
//     console.error("WebSocket token verification failed:", error.message);
//     return null;
//   }
// };

// function parseAndValidateParams(urlString) {
//   try {
//     console.log(`🔍 Parsing URL: ${urlString}`);

//     if (!urlString || urlString === "/") {
//       console.error("❌ Empty URL");
//       return null;
//     }

//     const baseUrl = "ws://localhost";
//     const fullUrl = urlString.startsWith("/")
//       ? `${baseUrl}${urlString}`
//       : `${baseUrl}/${urlString}`;

//     let url;
//     try {
//       url = new URL(fullUrl);
//     } catch (e) {
//       console.error("❌ Invalid URL format:", urlString);
//       return null;
//     }

//     const params = {};

//     for (const [key, value] of url.searchParams.entries()) {
//       const cleanValue = String(value ?? "").trim();

//       if (
//         cleanValue === "true" ||
//         cleanValue === "false" ||
//         cleanValue === "1" ||
//         cleanValue === "0" ||
//         cleanValue === "yes" ||
//         cleanValue === "no"
//       ) {
//         params[key] =
//           cleanValue === "true" || cleanValue === "1" || cleanValue === "yes";
//       } else if (!isNaN(cleanValue) && cleanValue !== "") {
//         params[key] = Number(cleanValue);
//       } else {
//         params[key] = cleanValue;
//       }
//     }

//     const BOOLEAN_PARAMS = ["isStreamer", "allowViewersToDraw", "isViewer"];
//     BOOLEAN_PARAMS.forEach((param) => {
//       if (param in params) {
//         params[param] =
//           String(params[param]).toLowerCase() === "true" ||
//           params[param] === true ||
//           params[param] === 1;
//       }
//     });

//     if (!params.token) {
//       console.error("❌ Token is required");
//       throw new Error("Token is required");
//     }

//     const tokenData = verifyWebSocketToken(params.token);
//     if (!tokenData || !tokenData.isValid) {
//       console.error("❌ Invalid or expired token");
//       throw new Error("Invalid or expired token");
//     }

//     const isStreamer =
//       params.isStreamer === true ||
//       tokenData.isStreamer === true ||
//       tokenData.role === 2;

//     const allowViewersToDraw = params.allowViewersToDraw === true;

//     const userId = params.userId || tokenData.userId || `user_${Date.now()}`;
//     const userName =
//       params.userName || tokenData.userName || `User_${userId.substring(0, 4)}`;
//     const roomName = params.roomName || "Whiteboard Session";
//     const roomCode = params.roomCode || "";

//     let permissions = {};
//     if (isStreamer) {
//       permissions = {
//         canDraw: true,
//         canEdit: true,
//         canDelete: true,
//         canClear: true,
//         canChat: true,
//         canExport: true,
//         canImport: true,
//       };
//     } else {
//       permissions = {
//         canDraw: allowViewersToDraw,
//         canEdit: allowViewersToDraw,
//         canDelete: false,
//         canClear: false,
//         canChat: true,
//         canExport: true,
//         canImport: false,
//       };
//     }

//     console.log(
//       `🎨 FINAL - Viewer drawing: ${allowViewersToDraw ? "ENABLED" : "DISABLED"}`
//     );
//     console.log(`👤 FINAL - Role: ${isStreamer ? "STREAMER" : "VIEWER"}`);
//     console.log("🔐 FINAL PERMISSIONS:", permissions);

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
//       connectedAt: new Date().toISOString(),
//     };
//   } catch (e) {
//     console.error("❌ Error parsing params:", e.message);
//     return null;
//   }
// }

// function getRoom(sessionId, userParams = null) {
//   console.log(`🔍 Getting room for session: ${sessionId}`);

//   let room = activeRooms.get(sessionId);

//   if (!room && userParams) {
//     console.log(`🆕 Creating NEW room: ${sessionId}`);

//     try {
//       const doc = new Y.Doc();
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
//           allowViewersToDraw: userParams.allowViewersToDraw,
//         },
//         userPermissions: new Map([[userParams.userId, userParams.permissions]]),
//         stats: {
//           totalConnections: 0,
//           totalDraws: 0,
//           lastActivity: new Date().toISOString(),
//         },
//       };

//       // settings map
//       const ySettings = doc.getMap("room_settings");
//       ySettings.set("allowViewersToDraw", userParams.allowViewersToDraw);
//       ySettings.set("streamerId", userParams.userId);
//       ySettings.set("streamerName", userParams.userName);
//       ySettings.set("createdAt", new Date().toISOString());

//       // whiteboard array init
//       const yCanvasArray = doc.getArray("whiteboard");
//       if (yCanvasArray.length === 0) {
//         const initialState = {
//           version: "5.3.0",
//           objects: [],
//           background: "#ffffff",
//           sessionId: sessionId,
//           allowViewersToDraw: userParams.allowViewersToDraw,
//           createdAt: new Date().toISOString(),
//           updatedBy: userParams.userId,
//           updatedByName: userParams.userName,
//         };
//         yCanvasArray.insert(0, [initialState]);
//         console.log("✅ Canvas array initialized with empty state");
//       }

//       activeRooms.set(sessionId, room);
//       console.log(`✅ Room ${sessionId} created successfully`);

//       // awareness broadcast
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
//           console.error("❌ Awareness update error:", error);
//         }
//       });

//       // doc update broadcast
//       doc.on("update", (update, origin) => {
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
//           console.error("❌ Document update error:", error);
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

// // ✅ UPDATED: Connection handlers (server local awareness removed + sync permission gate removed)
// function setupConnectionHandlers(ws, room, sessionId, userParams) {
//   try {
//     console.log(`🔗 Setting up connection handlers for ${userParams.userName} (${userParams.roleName})`);

//     if (!room) {
//       console.error(`❌ CRITICAL: Room ${sessionId} is null`);
//       ws.close(1011, "Room not found");
//       return;
//     }

//     if (!room.awareness) {
//       console.error(`❌ CRITICAL: Room ${sessionId} missing awareness`);
//       ws.close(1011, "Server configuration error");
//       return;
//     }

//     ws.binaryType = "arraybuffer";

//     const userInfo = {
//       userId: userParams.userId,
//       userName: userParams.userName,
//       role: userParams.role,
//       roleName: userParams.roleName,
//       isStreamer: userParams.isStreamer,
//       permissions: userParams.permissions,
//       joinedAt: new Date().toISOString(),
//       lastActive: new Date().toISOString(),
//       connectionId: `${userParams.userId}_${Date.now()}`,
//     };

//     room.clients.set(ws, userInfo);
//     room.stats.totalConnections++;

//     ws.userId = userParams.userId;
//     ws.userName = userParams.userName;
//     ws.isStreamer = userParams.isStreamer;
//     ws.role = userParams.role;
//     ws.permissions = userParams.permissions;

//     // ✅ IMPORTANT:
//     // ❌ DO NOT set room.awareness.setLocalState() on server.
//     // Client already sends awareness updates; server only applies/broadcasts.

//     // Send initial sync step1
//     sendSyncStep1(ws, room.doc);

//     // Send existing awareness states (if any)
//     try {
//       const states = Array.from(room.awareness.getStates().keys());
//       if (states.length > 0) {
//         sendAwarenessStates(ws, room.awareness, states);
//       }
//     } catch (e) {
//       console.error("❌ Error sending awareness states:", e);
//     }

//     // Welcome JSON
//     const welcomeMessage = JSON.stringify({
//       type: "welcome",
//       sessionId: sessionId,
//       roomInfo: {
//         ...room.sessionInfo,
//         allowViewersToDraw: room.allowViewersToDraw,
//       },
//       yourInfo: {
//         userId: userParams.userId,
//         userName: userParams.userName,
//         role: userParams.roleName,
//         isStreamer: userParams.isStreamer,
//         permissions: userParams.permissions,
//       },
//       roomSettings: {
//         allowViewersToDraw: room.allowViewersToDraw,
//         streamerId: room.createdBy,
//         streamerName: room.createdByName,
//       },
//       totalParticipants: room.clients.size,
//       serverTime: new Date().toISOString(),
//     });

//     if (ws.readyState === 1) ws.send(welcomeMessage);

//     // Broadcast join
//     const joinMessage = JSON.stringify({
//       type: "user_joined",
//       userId: userParams.userId,
//       userName: userParams.userName,
//       role: userParams.roleName,
//       isStreamer: userParams.isStreamer,
//       timestamp: new Date().toISOString(),
//       totalParticipants: room.clients.size,
//     });

//     room.clients.forEach((_, client) => {
//       if (client !== ws && client.readyState === 1) {
//         client.send(joinMessage);
//       }
//     });

//     // Message handler
//     ws.on("message", (data) => {
//       try {
//         const info = room.clients.get(ws);
//         if (info) info.lastActive = new Date().toISOString();

//         // JSON message
//         if (data && (data.toString().startsWith("{") || data.toString().startsWith("["))) {
//           try {
//             const textData = data.toString();
//             const jsonData = JSON.parse(textData);

//             if (jsonData.type === "sync" || jsonData.type === "awareness") return;

//             jsonData.userId = userParams.userId;
//             jsonData.userName = userParams.userName;
//             jsonData.timestamp = new Date().toISOString();

//             const broadcastMessage = JSON.stringify(jsonData);
//             room.clients.forEach((_, client) => {
//               if (client !== ws && client.readyState === 1) {
//                 client.send(broadcastMessage);
//               }
//             });
//             return;
//           } catch {
//             // not JSON, continue binary
//           }
//         }

//         // binary normalize
//         let uint8Array;
//         if (data instanceof Buffer) uint8Array = new Uint8Array(data);
//         else if (data instanceof ArrayBuffer) uint8Array = new Uint8Array(data);
//         else if (data instanceof Uint8Array) uint8Array = data;
//         else if (typeof data === "string") return;
//         else {
//           console.error("❌ Unknown data type:", typeof data);
//           return;
//         }

//         if (uint8Array.length < 2) {
//           console.error("❌ Message too short:", uint8Array.length);
//           return;
//         }

//         let decoder;
//         try {
//           decoder = decoding.createDecoder(uint8Array);
//         } catch (decodeError) {
//           console.error("❌ Failed to create decoder:", decodeError.message);
//           return;
//         }

//         let messageType;
//         try {
//           messageType = decoding.readVarUint(decoder);
//         } catch (readError) {
//           console.error("❌ Failed to read message type:", readError.message);
//           return;
//         }

//         if (messageType === messageSync) {
//           // ✅ IMPORTANT:
//           // ❌ DO NOT block viewer sync when allowViewersToDraw is false.
//           // View-only users still need sync to SEE drawings.

//           try {
//             const encoder = encoding.createEncoder();
//             encoding.writeVarUint(encoder, messageSync);

//             syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);

//             const reply = encoding.toUint8Array(encoder);
//             if (reply.length > 1 && ws.readyState === 1) {
//               ws.send(reply);
//             }
//           } catch (syncError) {
//             console.error("❌ SyncProtocol error:", syncError.message);
//           }
//           return;
//         }

//         if (messageType === messageAwareness) {
//           if (!room.awareness) return;

//           try {
//             const update = decoding.readVarUint8Array(decoder);
//             awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
//           } catch (awarenessError) {
//             console.error("❌ Awareness error:", awarenessError.message);
//           }
//           return;
//         }
//       } catch (err) {
//         console.error("❌ Yjs WS message error:", err?.message || err);
//       }
//     });

//     // Disconnect handling
//     ws.on("close", () => {
//       const userInfo = room.clients.get(ws);
//       const userName = userInfo?.userName || "Unknown";
//       console.log(`🔌 Client disconnected: ${userName} from ${sessionId}`);

//       // ✅ Remove awareness states safely by matching userId
//       try {
//         const idsToRemove = [];
//         room.awareness.getStates().forEach((state, clientId) => {
//           if (state?.userId && userInfo?.userId && state.userId === userInfo.userId) {
//             idsToRemove.push(clientId);
//           }
//         });

//         if (idsToRemove.length > 0) {
//           awarenessProtocol.removeAwarenessStates(room.awareness, idsToRemove, ws);
//           console.log(`🧹 Removed awareness clientIDs:`, idsToRemove);
//         }
//       } catch (e) {
//         console.error("❌ Error removing awareness states:", e);
//       }

//       room.clients.delete(ws);

//       if (userInfo?.userId) {
//         room.userPermissions.delete(userInfo.userId);
//       }

//       const leaveMessage = JSON.stringify({
//         type: "user_left",
//         userId: userInfo?.userId,
//         userName: userName,
//         timestamp: new Date().toISOString(),
//         totalParticipants: room.clients.size,
//       });

//       room.clients.forEach((_, client) => {
//         if (client.readyState === 1) {
//           client.send(leaveMessage);
//         }
//       });

//       console.log(`👥 Remaining in room ${sessionId}: ${room.clients.size}`);

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
//       ws.close(1011, "Server error");
//     } catch {}
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
//       console.log("✅ Sent sync step 1");
//     }
//   } catch (error) {
//     console.error("❌ Error sending sync step 1:", error);
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
//     console.error("❌ Error sending awareness states:", error);
//   }
// }

// function checkRoomPermissions(userParams, room) {
//   if (!room) {
//     console.log("🆕 No existing room, creating new one");
//     return true;
//   }

//   const { userId, isStreamer } = userParams;

//   if (isStreamer && room.createdBy === userId) {
//     console.log("✅ Streamer rejoining own room");
//     return true;
//   }

//   if (isStreamer && room.createdBy && room.createdBy !== userId) {
//     console.log(`🚫 Multiple streamers not allowed in room ${room.sessionInfo?.sessionId}`);
//     return false;
//   }

//   console.log("✅ Permission check passed");
//   return true;
// }

// export function getActiveRoomsInfo() {
//   const roomsInfo = [];
//   activeRooms.forEach((room, sessionId) => {
//     const clientsInfo = Array.from(room.clients.values()).map((client) => ({
//       userId: client.userId,
//       userName: client.userName,
//       role: client.roleName,
//       isStreamer: client.isStreamer,
//       joinedAt: client.joinedAt,
//       lastActive: client.lastActive,
//       permissions: client.permissions,
//     }));

//     roomsInfo.push({
//       sessionId,
//       createdBy: room.createdByName,
//       allowViewersToDraw: room.allowViewersToDraw,
//       totalClients: room.clients.size,
//       clients: clientsInfo,
//       sessionInfo: room.sessionInfo,
//       stats: room.stats,
//     });
//   });
//   return roomsInfo;
// }

// function debugRoomCreation() {
//   console.log("\n=== DEBUG ROOM STATUS ===");
//   console.log("Active rooms count:", activeRooms.size);
//   activeRooms.forEach((room, sessionId) => {
//     console.log(`\n📁 Room: ${sessionId}`);
//     console.log(`  - Streamer: ${room.createdByName}`);
//     console.log(`  - Allow Viewers to Draw: ${room.allowViewersToDraw}`);
//     console.log(`  - Clients: ${room.clients?.size || 0}`);
//     console.log(`  - Awareness states: ${room.awareness?.getStates?.().size ?? "N/A"}`);
//     console.log(`  - Total Draws: ${room.stats?.totalDraws || 0}`);
//     console.log(`  - Last Activity: ${room.stats?.lastActivity || "Never"}`);
//   });
//   console.log("==========================\n");
// }

// // Main WebSocket server setup
// export function setupYWebsocketCompatibleServer(httpServer) {
//   console.log("🚀 Setting up Yjs WebSocket server...");

//   setInterval(debugRoomCreation, 30000);

//   const wss = new WebSocketServer({
//     noServer: true,
//     clientTracking: false,
//     perMessageDeflate: false,
//     skipUTF8Validation: true,
//     maxPayload: 50 * 1024 * 1024,
//   });

//   httpServer.on("upgrade", (request, socket, head) => {
//     try {
//       const url = request.url;
//       console.log(`📡 WebSocket upgrade request: ${url}`);

//       // ignore socket.io upgrades
//       if (url.startsWith("/socket.io/")) return;

//       // accept only yjs
//       if (!url.startsWith("/yjs/")) return;

//       const pathParts = url.split("/");
//       const sessionId = pathParts[2]?.split("?")[0];

//       if (!sessionId || sessionId.length < 5) {
//         console.log("❌ Yjs WS rejected: Invalid sessionId", sessionId);
//         socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
//         socket.destroy();
//         return;
//       }

//       console.log(`🔍 Processing Yjs connection for session: ${sessionId}`);

//       const userParams = parseAndValidateParams(url);

//       if (!userParams) {
//         console.log("❌ Yjs WS rejected: Invalid authentication");
//         socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
//         socket.destroy();
//         return;
//       }

//       const room = getRoom(sessionId, userParams);

//       if (!room) {
//         console.log(`❌ Failed to get/create room for session: ${sessionId}`);
//         socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
//         socket.destroy();
//         return;
//       }

//       if (!room.awareness) {
//         console.log(`❌ Room missing awareness for session: ${sessionId}`);
//         socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
//         socket.destroy();
//         return;
//       }

//       if (!checkRoomPermissions(userParams, room)) {
//         console.log(`🚫 Permission denied for ${userParams.userName} in room ${sessionId}`);
//         socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
//         socket.destroy();
//         return;
//       }

//       wss.handleUpgrade(request, socket, head, (ws) => {
//         ws.sessionId = sessionId;
//         wss.emit("connection", ws, request);
//         setupConnectionHandlers(ws, room, sessionId, userParams);
//       });
//     } catch (e) {
//       console.error("❌ Yjs WS upgrade error:", e.message);
//       console.error("Stack:", e.stack);
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
//   console.log("🎨 Updated: No server local awareness, viewer sync allowed, safe awareness cleanup");

//   return {
//     cleanup: () => {
//       console.log("🧹 Cleaning up Yjs WebSocket server...");
//       wss.clients.forEach((client) => {
//         try {
//           client.close(1000, "Server shutdown");
//         } catch {}
//       });
//       wss.close();
//       activeRooms.clear();
//     },
//     getStats: () => {
//       return {
//         totalRooms: activeRooms.size,
//         totalConnections: Array.from(activeRooms.values()).reduce(
//           (sum, room) => sum + room.clients.size,
//           0
//         ),
//         rooms: getActiveRoomsInfo(),
//       };
//     },
//     getRoom: (sessionId) => {
//       return activeRooms.get(sessionId);
//     },
//   };
// }

// export function getYjsHealth(req, res) {
//   try {
//     const stats = {
//       status: "healthy",
//       timestamp: new Date().toISOString(),
//       totalRooms: activeRooms.size,
//       totalConnections: Array.from(activeRooms.values()).reduce(
//         (sum, room) => sum + room.clients.size,
//         0
//       ),
//       rooms: getActiveRoomsInfo(),
//       uptime: process.uptime(),
//     };
//     res.json(stats);
//   } catch (error) {
//     res.status(500).json({
//       status: "error",
//       message: error.message,
//     });
//   }
// }

// export default {
//   setupYWebsocketCompatibleServer,
//   getYjsHealth,
//   getActiveRoomsInfo,
// };






















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
  ADMIN: 1,
  STREAMER: 2,
  VIEWER: 3,
};

const ROLE_REVERSE_MAP = {
  1: "ADMIN",
  2: "STREAMER",
  3: "VIEWER",
};

// JWT Verification for WebSocket
const verifyWebSocketToken = (token) => {
  try {
    if (!token || token === "undefined" || token === "null") {
      console.log("❌ Token is missing or invalid");
      return null;
    }

    const cleanToken = token.replace(/['"]/g, "").trim();

    if (!cleanToken || cleanToken.length < 10) {
      console.log("❌ Token is too short");
      return null;
    }

    const decoded = jwt.verify(
      cleanToken,
      process.env.SECRET_KEY || "your-secret-key"
    );

    const roleName = ROLE_REVERSE_MAP[decoded.role];
    if (!roleName) {
      console.log(`❌ Invalid role in token: ${decoded.role}`);
      throw new Error("Invalid role in token");
    }

    console.log(`✅ Token verified for user: ${decoded.userId}, role: ${roleName}`);

    return {
      userId: decoded.userId,
      role: decoded.role,
      roleName: roleName,
      isStreamer: decoded.role === 2,
      isValid: true,
      userName:
        decoded.name ||
        decoded.userName ||
        `User_${decoded.userId?.substring(0, 4)}`,
    };
  } catch (error) {
    console.error("WebSocket token verification failed:", error.message);
    return null;
  }
};

function parseAndValidateParams(urlString) {
  try {
    console.log(`🔍 Parsing URL: ${urlString}`);

    if (!urlString || urlString === "/") {
      console.error("❌ Empty URL");
      return null;
    }

    const baseUrl = "ws://localhost";
    const fullUrl = urlString.startsWith("/")
      ? `${baseUrl}${urlString}`
      : `${baseUrl}/${urlString}`;

    let url;
    try {
      url = new URL(fullUrl);
    } catch (e) {
      console.error("❌ Invalid URL format:", urlString);
      return null;
    }

    const params = {};

    for (const [key, value] of url.searchParams.entries()) {
      const cleanValue = String(value ?? "").trim();

      if (
        cleanValue === "true" ||
        cleanValue === "false" ||
        cleanValue === "1" ||
        cleanValue === "0" ||
        cleanValue === "yes" ||
        cleanValue === "no"
      ) {
        params[key] =
          cleanValue === "true" || cleanValue === "1" || cleanValue === "yes";
      } else if (!isNaN(cleanValue) && cleanValue !== "") {
        params[key] = Number(cleanValue);
      } else {
        params[key] = cleanValue;
      }
    }

    const BOOLEAN_PARAMS = ["isStreamer", "allowViewersToDraw", "isViewer"];
    BOOLEAN_PARAMS.forEach((param) => {
      if (param in params) {
        params[param] =
          String(params[param]).toLowerCase() === "true" ||
          params[param] === true ||
          params[param] === 1;
      }
    });

    if (!params.token) {
      console.error("❌ Token is required");
      throw new Error("Token is required");
    }

    const tokenData = verifyWebSocketToken(params.token);
    if (!tokenData || !tokenData.isValid) {
      console.error("❌ Invalid or expired token");
      throw new Error("Invalid or expired token");
    }

    const isStreamer =
      params.isStreamer === true ||
      tokenData.isStreamer === true ||
      tokenData.role === 2;

    const allowViewersToDraw = params.allowViewersToDraw === true;

    const userId = params.userId || tokenData.userId || `user_${Date.now()}`;
    const userName =
      params.userName || tokenData.userName || `User_${userId.substring(0, 4)}`;
    const roomName = params.roomName || "Whiteboard Session";
    const roomCode = params.roomCode || "";

    let permissions = {};
    if (isStreamer) {
      permissions = {
        canDraw: true,
        canEdit: true,
        canDelete: true,
        canClear: true,
        canChat: true,
        canExport: true,
        canImport: true,
      };
    } else {
      permissions = {
        canDraw: allowViewersToDraw,
        canEdit: allowViewersToDraw,
        canDelete: false,
        canClear: false,
        canChat: true,
        canExport: true,
        canImport: false,
      };
    }

    console.log(
      `🎨 FINAL - Viewer drawing: ${allowViewersToDraw ? "ENABLED" : "DISABLED"}`
    );
    console.log(`👤 FINAL - Role: ${isStreamer ? "STREAMER" : "VIEWER"}`);
    console.log("🔐 FINAL PERMISSIONS:", permissions);

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
      connectedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error("❌ Error parsing params:", e.message);
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
          allowViewersToDraw: userParams.allowViewersToDraw,
        },
        userPermissions: new Map([[userParams.userId, userParams.permissions]]),
        stats: {
          totalConnections: 0,
          totalDraws: 0,
          lastActivity: new Date().toISOString(),
        },
      };

      // settings map
      const ySettings = doc.getMap("room_settings");
      ySettings.set("allowViewersToDraw", userParams.allowViewersToDraw);
      ySettings.set("streamerId", userParams.userId);
      ySettings.set("streamerName", userParams.userName);
      ySettings.set("createdAt", new Date().toISOString());

      // whiteboard array init
      const yCanvasArray = doc.getArray("whiteboard");
      if (yCanvasArray.length === 0) {
        const initialState = {
          version: "5.3.0",
          objects: [],
          background: "#ffffff",
          sessionId: sessionId,
          allowViewersToDraw: userParams.allowViewersToDraw,
          createdAt: new Date().toISOString(),
          updatedBy: userParams.userId,
          updatedByName: userParams.userName,
        };
        yCanvasArray.insert(0, [initialState]);
        console.log("✅ Canvas array initialized with empty state");
      }

      activeRooms.set(sessionId, room);
      console.log(`✅ Room ${sessionId} created successfully`);

      // awareness broadcast
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
          console.error("❌ Awareness update error:", error);
        }
      });

      // doc update broadcast
      doc.on("update", (update, origin) => {
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
          console.error("❌ Document update error:", error);
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

// ✅ UPDATED: Connection handlers (server local awareness removed + sync permission gate removed)
function setupConnectionHandlers(ws, room, sessionId, userParams) {
  try {
    console.log(`🔗 Setting up connection handlers for ${userParams.userName} (${userParams.roleName})`);

    if (!room) {
      console.error(`❌ CRITICAL: Room ${sessionId} is null`);
      ws.close(1011, "Room not found");
      return;
    }

    if (!room.awareness) {
      console.error(`❌ CRITICAL: Room ${sessionId} missing awareness`);
      ws.close(1011, "Server configuration error");
      return;
    }

    ws.binaryType = "arraybuffer";

    const userInfo = {
      userId: userParams.userId,
      userName: userParams.userName,
      role: userParams.role,
      roleName: userParams.roleName,
      isStreamer: userParams.isStreamer,
      permissions: userParams.permissions,
      joinedAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      connectionId: `${userParams.userId}_${Date.now()}`,
    };

    room.clients.set(ws, userInfo);
    room.stats.totalConnections++;

    ws.userId = userParams.userId;
    ws.userName = userParams.userName;
    ws.isStreamer = userParams.isStreamer;
    ws.role = userParams.role;
    ws.permissions = userParams.permissions;

    // Send initial sync step1
    sendSyncStep1(ws, room.doc);

    // Send existing awareness states (if any)
    try {
      const states = Array.from(room.awareness.getStates().keys());
      if (states.length > 0) {
        sendAwarenessStates(ws, room.awareness, states);
      }
    } catch (e) {
      console.error("❌ Error sending awareness states:", e);
    }

    // Welcome JSON
    const welcomeMessage = JSON.stringify({
      type: "welcome",
      sessionId: sessionId,
      roomInfo: {
        ...room.sessionInfo,
        allowViewersToDraw: room.allowViewersToDraw,
      },
      yourInfo: {
        userId: userParams.userId,
        userName: userParams.userName,
        role: userParams.roleName,
        isStreamer: userParams.isStreamer,
        permissions: userParams.permissions,
      },
      roomSettings: {
        allowViewersToDraw: room.allowViewersToDraw,
        streamerId: room.createdBy,
        streamerName: room.createdByName,
      },
      totalParticipants: room.clients.size,
      serverTime: new Date().toISOString(),
    });

    if (ws.readyState === 1) ws.send(welcomeMessage);

    // Broadcast join
    const joinMessage = JSON.stringify({
      type: "user_joined",
      userId: userParams.userId,
      userName: userParams.userName,
      role: userParams.roleName,
      isStreamer: userParams.isStreamer,
      timestamp: new Date().toISOString(),
      totalParticipants: room.clients.size,
    });

    room.clients.forEach((_, client) => {
      if (client !== ws && client.readyState === 1) {
        client.send(joinMessage);
      }
    });

    // Message handler
    ws.on("message", (data) => {
      try {
        const info = room.clients.get(ws);
        if (info) info.lastActive = new Date().toISOString();

        // JSON message
        if (data && (data.toString().startsWith("{") || data.toString().startsWith("["))) {
          try {
            const textData = data.toString();
            const jsonData = JSON.parse(textData);

            if (jsonData.type === "sync" || jsonData.type === "awareness") return;

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
          } catch {
            // not JSON, continue binary
          }
        }

        // binary normalize
        let uint8Array;
        if (data instanceof Buffer) uint8Array = new Uint8Array(data);
        else if (data instanceof ArrayBuffer) uint8Array = new Uint8Array(data);
        else if (data instanceof Uint8Array) uint8Array = data;
        else if (typeof data === "string") return;
        else {
          console.error("❌ Unknown data type:", typeof data);
          return;
        }

        if (uint8Array.length < 2) {
          console.error("❌ Message too short:", uint8Array.length);
          return;
        }

        let decoder;
        try {
          decoder = decoding.createDecoder(uint8Array);
        } catch (decodeError) {
          console.error("❌ Failed to create decoder:", decodeError.message);
          return;
        }

        let messageType;
        try {
          messageType = decoding.readVarUint(decoder);
        } catch (readError) {
          console.error("❌ Failed to read message type:", readError.message);
          return;
        }

        if (messageType === messageSync) {
          try {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageSync);

            syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);

            const reply = encoding.toUint8Array(encoder);
            if (reply.length > 1 && ws.readyState === 1) {
              ws.send(reply);
            }
          } catch (syncError) {
            console.error("❌ SyncProtocol error:", syncError.message);
          }
          return;
        }

        if (messageType === messageAwareness) {
          if (!room.awareness) return;

          try {
            const update = decoding.readVarUint8Array(decoder);
            awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
          } catch (awarenessError) {
            console.error("❌ Awareness error:", awarenessError.message);
          }
          return;
        }
      } catch (err) {
        console.error("❌ Yjs WS message error:", err?.message || err);
      }
    });

    // Disconnect handling
    ws.on("close", () => {
      const userInfo = room.clients.get(ws);
      const userName = userInfo?.userName || "Unknown";
      console.log(`🔌 Client disconnected: ${userName} from ${sessionId}`);

      // Remove awareness states safely by matching userId
      try {
        const idsToRemove = [];
        room.awareness.getStates().forEach((state, clientId) => {
          if (state?.userId && userInfo?.userId && state.userId === userInfo.userId) {
            idsToRemove.push(clientId);
          }
        });

        if (idsToRemove.length > 0) {
          awarenessProtocol.removeAwarenessStates(room.awareness, idsToRemove, ws);
          console.log(`🧹 Removed awareness clientIDs:`, idsToRemove);
        }
      } catch (e) {
        console.error("❌ Error removing awareness states:", e);
      }

      room.clients.delete(ws);

      if (userInfo?.userId) {
        room.userPermissions.delete(userInfo.userId);
      }

      const leaveMessage = JSON.stringify({
        type: "user_left",
        userId: userInfo?.userId,
        userName: userName,
        timestamp: new Date().toISOString(),
        totalParticipants: room.clients.size,
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
      ws.close(1011, "Server error");
    } catch {}
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
      console.log("✅ Sent sync step 1");
    }
  } catch (error) {
    console.error("❌ Error sending sync step 1:", error);
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
    console.error("❌ Error sending awareness states:", error);
  }
}

// ✅ UPDATED: Simplified permission check - only ensure streamer joins first
function checkRoomPermissions(userParams, room) {
  if (!room) {
    console.log("🆕 No existing room, creating new one");
    return true;
  }

  const { isStreamer } = userParams;

  // Agar viewer hai to check karo ki koi streamer already hai ya nahi
  if (!isStreamer) {
    // Check if at least one streamer exists in the room
    const streamerExists = Array.from(room.clients.values()).some(
      client => client.isStreamer === true
    );
    
    if (!streamerExists) {
      console.log("🚫 Viewer cannot join - streamer not present in room");
      return false;
    }
  }

  console.log("✅ Permission check passed");
  return true;
}

export function getActiveRoomsInfo() {
  const roomsInfo = [];
  activeRooms.forEach((room, sessionId) => {
    const clientsInfo = Array.from(room.clients.values()).map((client) => ({
      userId: client.userId,
      userName: client.userName,
      role: client.roleName,
      isStreamer: client.isStreamer,
      joinedAt: client.joinedAt,
      lastActive: client.lastActive,
      permissions: client.permissions,
    }));

    roomsInfo.push({
      sessionId,
      createdBy: room.createdByName,
      allowViewersToDraw: room.allowViewersToDraw,
      totalClients: room.clients.size,
      clients: clientsInfo,
      sessionInfo: room.sessionInfo,
      stats: room.stats,
    });
  });
  return roomsInfo;
}

function debugRoomCreation() {
  console.log("\n=== DEBUG ROOM STATUS ===");
  console.log("Active rooms count:", activeRooms.size);
  activeRooms.forEach((room, sessionId) => {
    console.log(`\n📁 Room: ${sessionId}`);
    console.log(`  - Streamer: ${room.createdByName}`);
    console.log(`  - Allow Viewers to Draw: ${room.allowViewersToDraw}`);
    console.log(`  - Clients: ${room.clients?.size || 0}`);
    console.log(`  - Awareness states: ${room.awareness?.getStates?.().size ?? "N/A"}`);
    console.log(`  - Total Draws: ${room.stats?.totalDraws || 0}`);
    console.log(`  - Last Activity: ${room.stats?.lastActivity || "Never"}`);
  });
  console.log("==========================\n");
}

// Main WebSocket server setup
export function setupYWebsocketCompatibleServer(httpServer) {
  console.log("🚀 Setting up Yjs WebSocket server...");

  setInterval(debugRoomCreation, 30000);

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    skipUTF8Validation: true,
    maxPayload: 50 * 1024 * 1024,
  });

  httpServer.on("upgrade", (request, socket, head) => {
    try {
      const url = request.url;
      console.log(`📡 WebSocket upgrade request: ${url}`);

      // ignore socket.io upgrades
      if (url.startsWith("/socket.io/")) return;

      // accept only yjs
      if (!url.startsWith("/yjs/")) return;

      const pathParts = url.split("/");
      const sessionId = pathParts[2]?.split("?")[0];

      if (!sessionId || sessionId.length < 5) {
        console.log("❌ Yjs WS rejected: Invalid sessionId", sessionId);
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      console.log(`🔍 Processing Yjs connection for session: ${sessionId}`);

      const userParams = parseAndValidateParams(url);

      if (!userParams) {
        console.log("❌ Yjs WS rejected: Invalid authentication");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      // ✅ UPDATED: Check if room exists and handle viewer before streamer
      const roomExists = activeRooms.has(sessionId);
      
      // Agar room exist nahi karta aur user viewer hai to error do
      if (!roomExists && !userParams.isStreamer) {
        console.log(`🚫 Viewer trying to join non-existent room without streamer: ${sessionId}`);
        
        // Send error response
        const errorResponse = JSON.stringify({
          type: "error",
          code: "STREAMER_NOT_JOINED",
          message: "Streamer has not joined the room yet. Please wait for the streamer to start the session.",
          timestamp: new Date().toISOString()
        });
        
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.write(errorResponse);
        socket.destroy();
        return;
      }

      const room = getRoom(sessionId, userParams);

      if (!room) {
        console.log(`❌ Failed to get/create room for session: ${sessionId}`);
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
        return;
      }

      if (!room.awareness) {
        console.log(`❌ Room missing awareness for session: ${sessionId}`);
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
        return;
      }

      // ✅ Check permissions - ensure streamer is present for viewers
      if (!checkRoomPermissions(userParams, room)) {
        console.log(`🚫 Permission denied for ${userParams.userName} - streamer not present in room ${sessionId}`);
        
        const errorResponse = JSON.stringify({
          type: "error",
          code: "STREAMER_NOT_JOINED",
          message: "Streamer has not joined the room yet. Please wait for the streamer to start the session.",
          timestamp: new Date().toISOString()
        });
        
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.write(errorResponse);
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
      console.error("Stack:", e.stack);
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
  console.log("🎨 Updated: Streamer must join first, viewers can only join after streamer");

  return {
    cleanup: () => {
      console.log("🧹 Cleaning up Yjs WebSocket server...");
      wss.clients.forEach((client) => {
        try {
          client.close(1000, "Server shutdown");
        } catch {}
      });
      wss.close();
      activeRooms.clear();
    },
    getStats: () => {
      return {
        totalRooms: activeRooms.size,
        totalConnections: Array.from(activeRooms.values()).reduce(
          (sum, room) => sum + room.clients.size,
          0
        ),
        rooms: getActiveRoomsInfo(),
      };
    },
    getRoom: (sessionId) => {
      return activeRooms.get(sessionId);
    },
  };
}

export function getYjsHealth(req, res) {
  try {
    const stats = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      totalRooms: activeRooms.size,
      totalConnections: Array.from(activeRooms.values()).reduce(
        (sum, room) => sum + room.clients.size,
        0
      ),
      rooms: getActiveRoomsInfo(),
      uptime: process.uptime(),
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
}

export default {
  setupYWebsocketCompatibleServer,
  getYjsHealth,
  getActiveRoomsInfo,
};