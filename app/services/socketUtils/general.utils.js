// export const safeEmit = (io, toSocketId, event, payload) => {
//   try {
//     const s = io.sockets.sockets.get(toSocketId);
//     if (s) {
//       s.emit(event, payload);
//       console.log(`Emitted ${event} to socket: ${toSocketId}`);
//     } else {
//       console.log(`Socket not found: ${toSocketId}`);
//     }
//   } catch (err) {
//     console.error("safeEmit error:", err);
//   }
// };

// export const getIceServersFromEnv = () => {
//   const isProduction = process.env.NODE_ENV === "production";

//   const servers = [];
//   const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
//     .split(",")
//     .map(s => s.trim())
//     .filter(Boolean);
//   stunUrls.forEach(url => { if (url) servers.push({ urls: url }); });

//   if (isProduction) {
//     const turnUrls = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
//     const turnUsername = process.env.TURN_USERNAME;
//     const turnPassword = process.env.TURN_PASSWORD;

//     turnUrls.forEach(url => {
//       if (url && turnUsername && turnPassword) {
//         servers.push({
//           urls: url,
//           username: turnUsername,
//           credential: turnPassword
//         });
//       }
//     });
//   }
  
//   if (servers.length === 0) {
//     servers.push({ urls: "stun:stun.l.google.com:19302" });
//     servers.push({ urls: "stun:global.stun.twilio.com:3478" });
//   }

//   return servers;
// };