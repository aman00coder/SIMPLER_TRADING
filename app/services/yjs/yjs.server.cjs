// const { WebSocketServer } = require('ws');
// const Y = require('yjs');

// function setupYjsServer(httpServer) {
//   const wss = new WebSocketServer({ 
//     noServer: true,
//     clientTracking: true
//   });

//   console.log('\n🎨 YJS WHITEBOARD SERVER (Fixed Room) 🎨');
//   console.log('✅ Endpoint: ws://localhost:9090/yjs');
//   console.log('✅ Fixed Room: "collaborative-whiteboard"');
//   console.log('✅ Ready for connections...\n');

//   // ✅ FIXED SINGLE ROOM
//   const ROOM_NAME = 'collaborative-whiteboard';
  
//   // Single Yjs document for all clients
//   const ydoc = new Y.Doc();
//   const clients = [];
  
//   console.log(`✨ Created Yjs document for room: "${ROOM_NAME}"`);

//   httpServer.on('upgrade', (request, socket, head) => {
//     const pathname = request.url;
    
//     // ✅ ACCEPT ANY /yjs PATH (ignore query parameters)
//     if (pathname.includes('/yjs')) {
//       console.log('\n✅ Yjs connection request');
      
//       wss.handleUpgrade(request, socket, head, (ws) => {
//         wss.emit('connection', ws, request);
//       });
//     } else {
//       // Just ignore non-yjs paths
//       // console.log('Ignoring:', pathname.split('?')[0]);
//     }
//   });

//   wss.on('connection', (ws, request) => {
//     console.log('\n🎉 NEW WHITEBOARD CLIENT CONNECTED!');
    
//     // Add to clients array
//     clients.push(ws);
//     console.log(`👥 Total clients: ${clients.length}`);
    
//     // ✅ Send current document state to new client
//     const update = Y.encodeStateAsUpdate(ydoc);
//     if (update.length > 0) {
//       ws.send(Buffer.from(update));
//       console.log(`📤 Sent ${update.length} bytes to new client`);
//     } else {
//       console.log('📭 Document is empty - new session');
      
//       // Send sync step 1 (empty state vector)
//       const syncStep1 = new Uint8Array([0, 1]);
//       ws.send(Buffer.from(syncStep1));
//     }
    
//     // ✅ Send welcome message
//     ws.send(JSON.stringify({
//       type: 'welcome',
//       room: ROOM_NAME,
//       timestamp: Date.now(),
//       message: 'Connected to collaborative whiteboard',
//       totalClients: clients.length
//     }));
    
//     // Handle Yjs protocol messages
//     ws.on('message', (data) => {
//       try {
//         // Apply update to Yjs document
//         Y.applyUpdate(ydoc, new Uint8Array(data));
        
//         // ✅ Broadcast to ALL other clients
//         clients.forEach(client => {
//           if (client !== ws && client.readyState === 1) {
//             client.send(data);
//           }
//         });
        
//         // Log message type
//         const messageType = new Uint8Array(data)[0];
//         if (messageType === 0) {
//           console.log(`🔄 Sync update from client (${data.length} bytes)`);
//         } else if (messageType === 1) {
//           console.log(`👁️ Awareness update`);
//         }
        
//       } catch (error) {
//         console.error('❌ Error processing Yjs message:', error.message);
//       }
//     });
    
//     // Handle disconnect
//     ws.on('close', () => {
//       console.log('🔌 Client disconnected');
      
//       // Remove from clients array
//       const index = clients.indexOf(ws);
//       if (index > -1) {
//         clients.splice(index, 1);
//       }
      
//       console.log(`👥 Remaining clients: ${clients.length}`);
//     });
    
//     ws.on('error', (error) => {
//       console.error('❌ WebSocket error:', error.message);
//     });
    
//     // Heartbeat to keep connection alive
//     const heartbeat = setInterval(() => {
//       if (ws.readyState === 1) {
//         // Send empty awareness update
//         const awarenessUpdate = new Uint8Array([1, 0, 0]);
//         ws.send(Buffer.from(awarenessUpdate));
//       }
//     }, 30000);
    
//     ws.on('close', () => {
//       clearInterval(heartbeat);
//     });
//   });

//   // Log server status
//   setInterval(() => {
//     console.log('\n📊 WHITEBOARD SERVER STATS ======================');
//     console.log(`Active clients: ${clients.length}`);
    
//     // Check canvas data
//     try {
//       const canvasArray = ydoc.getArray('canvas');
//       if (canvasArray && canvasArray.length > 0) {
//         const canvasData = canvasArray.toJSON();
//         console.log(`Canvas objects: ${Array.isArray(canvasData) ? canvasData.length : 'N/A'}`);
//       } else {
//         console.log('Canvas: Empty');
//       }
//     } catch (e) {
//       console.log('Canvas: Error checking');
//     }
    
//     console.log('================================================\n');
//   }, 10000);

//   return wss;
// }

// module.exports = { setupYjsServer };



const { WebSocketServer } = require('ws');
const Y = require('yjs');

function setupYjsServer(httpServer) {
  const wss = new WebSocketServer({ 
    noServer: true,
    clientTracking: true
  });

  console.log('\n🎨 YJS WHITEBOARD SERVER (Fixed Room) 🎨');
  console.log('✅ Endpoint: ws://localhost:9090/yjs');
  console.log('✅ Fixed Room: "collaborative-whiteboard"');
  console.log('✅ Ready for connections...\n');

  // ✅ FIXED SINGLE ROOM
  const ROOM_NAME = 'collaborative-whiteboard';
  
  // Single Yjs document for all clients
  const ydoc = new Y.Doc();
  const clients = [];
  
  console.log(`✨ Created Yjs document for room: "${ROOM_NAME}"`);

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url;
    
    // ✅ ACCEPT ANY /yjs PATH
    if (pathname.includes('/yjs')) {
      console.log('\n✅ Yjs connection request');
      
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws, request) => {
    console.log('\n🎉 NEW WHITEBOARD CLIENT CONNECTED!');
    
    // Add to clients array
    clients.push(ws);
    console.log(`👥 Total clients: ${clients.length}`);
    
    // ✅ Send current document state to new client
    try {
      const update = Y.encodeStateAsUpdate(ydoc);
      if (update.length > 0) {
        ws.send(Buffer.from(update));
        console.log(`📤 Sent ${update.length} bytes to new client`);
      } else {
        console.log('📭 Document is empty - new session');
        // No need to send anything, Yjs client will request sync
      }
    } catch (error) {
      console.error('❌ Error sending initial state:', error.message);
    }
    
    // ✅ Send welcome message (JSON - for debugging only)
    try {
      ws.send(JSON.stringify({
        type: 'welcome',
        room: ROOM_NAME,
        timestamp: Date.now(),
        message: 'Connected to collaborative whiteboard',
        totalClients: clients.length
      }));
    } catch (error) {
      console.error('❌ Error sending welcome:', error.message);
    }
    
// Backend yjs-server.js में message handler को update करें
ws.on('message', (data) => {
  try {
    // ✅ FIX: Skip small messages (likely Yjs protocol control messages)
    if (!data || data.length < 5) {
      // These are likely Yjs protocol messages (sync, awareness, etc.)
      // Just forward them without processing
      console.log(`📨 Yjs protocol message (${data.length} bytes)`);
      
      // Forward to all other clients
      clients.forEach(client => {
        if (client !== ws && client.readyState === 1) {
          try {
            client.send(data);
          } catch (sendError) {
            console.error('❌ Broadcast error:', sendError.message);
          }
        }
      });
      return;
    }
    
    // For larger messages, try to parse as JSON (our canvas data)
    try {
      const messageStr = data.toString();
      const message = JSON.parse(messageStr);
      
      console.log(`📨 JSON message (${data.length} bytes):`, message.type || 'unknown');
      
      // If it's canvas data, apply to Yjs
      if (message.type === 'canvas-update' && message.data) {
        // Get Yjs array
        const yCanvasArray = ydoc.getArray('canvas');
        
        // Clear and update
        yCanvasArray.delete(0, yCanvasArray.length);
        yCanvasArray.insert(0, [message.data]);
        
        console.log(`🔄 Canvas updated (${JSON.stringify(message.data).length} chars)`);
      }
      
      // Forward to all other clients
      clients.forEach(client => {
        if (client !== ws && client.readyState === 1) {
          try {
            client.send(data);
          } catch (sendError) {
            console.error('❌ Broadcast error:', sendError.message);
          }
        }
      });
      
    } catch (jsonError) {
      // Not JSON, just forward as binary
      console.log(`📨 Binary message (${data.length} bytes)`);
      
      clients.forEach(client => {
        if (client !== ws && client.readyState === 1) {
          try {
            client.send(data);
          } catch (sendError) {
            console.error('❌ Broadcast error:', sendError.message);
          }
        }
      });
    }
    
  } catch (error) {
    console.error('❌ Message handler error:', error.message);
  }
});
    // Handle disconnect
    ws.on('close', () => {
      console.log('🔌 Client disconnected');
      
      // Remove from clients array
      const index = clients.indexOf(ws);
      if (index > -1) {
        clients.splice(index, 1);
      }
      
      console.log(`👥 Remaining clients: ${clients.length}`);
    });
    
    ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error.message);
    });
    
    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      if (ws.readyState === 1) {
        try {
          // Send awareness update (type 1, empty)
          const awarenessUpdate = new Uint8Array([1]);
          ws.send(Buffer.from(awarenessUpdate));
        } catch (error) {
          console.error('❌ Heartbeat error:', error.message);
        }
      }
    }, 15000); // Every 15 seconds
    
    ws.on('close', () => {
      clearInterval(heartbeat);
    });
  });

  // Log server status
  setInterval(() => {
    console.log('\n📊 WHITEBOARD SERVER STATS ======================');
    console.log(`Active clients: ${clients.length}`);
    
    // Check canvas data
    try {
      const canvasArray = ydoc.getArray('canvas');
      if (canvasArray) {
        console.log(`Canvas array length: ${canvasArray.length}`);
        
        // Try to get first item for debugging
        if (canvasArray.length > 0) {
          try {
            const firstItem = canvasArray.get(0);
            console.log(`First item type: ${typeof firstItem}`);
          } catch (e) {
            // Ignore
          }
        }
      }
    } catch (e) {
      console.log('Canvas check error:', e.message);
    }
    
    console.log('================================================\n');
  }, 10000);

  return wss;
}

module.exports = { setupYjsServer };