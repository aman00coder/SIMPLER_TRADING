// import dotenv from "dotenv";
// dotenv.config();

// import express from "express";
// import cookieParser from "cookie-parser";
// import connectDb from "./app/config/db.js";
// import cors from "cors";
// import indexRouter from "./app/routes/indexRouter.js";
// import { fileURLToPath } from "url";
// import path from "path";
// import session from "express-session";
// import morgan from "morgan";

// import http from "http";
// import { setupIntegratedSocket } from "./app/services/socket.integrated.js";
// import mediasoup from "mediasoup";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();

// // 🔹 Create Mediasoup Worker
// const createMediasoupWorker = async () => {
//   const worker = await mediasoup.createWorker({
//     logLevel: process.env.MEDIASOUP_LOG_LEVEL || "warn",
//     rtcMinPort: parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000,
//     rtcMaxPort: parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999,
//   });

//   worker.on("died", () => {
//     console.error("❌ Mediasoup worker died, exiting in 2 seconds...");
//     setTimeout(() => process.exit(1), 2000);
//   });

//   console.log("✅ Mediasoup Worker Created");
//   return worker;
// };

// // Middleware & setup
// app.use(
//   cors({
//     origin: process.env.CORS_ORIGIN?.split(",") || ["http://192.168.1.15:5174"],
//     methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//     credentials: true,
//   })
// );

// app.use(morgan("dev"));
// app.use(express.json({ limit: "500mb" }));
// app.use(express.urlencoded({ limit: "500mb", extended: true }));
// app.use(cookieParser());

// connectDb();

// app.use("/public", express.static(path.join(__dirname, "public")));
// app.use("/apis", indexRouter);

// app.use(
//   session({
//     secret: process.env.SECRET_KEY || "defaultSecretKey",
//     resave: false,
//     saveUninitialized: true,
//     cookie: {
//       secure: process.env.NODE_ENV === "production",
//     },
//   })
// );

// // ✅ Root route
// app.get("/", (req, res) => {
//   res.json({
//     status: "success",
//     message: "🚀✨ Server is running successfully🌟",
//     app: "SIMPLER_TRADING",
//     version: "1.0.0",
//     environment: process.env.NODE_ENV,
//     port: process.env.PORT,
//     serverTime: new Date().toISOString(),
//     note: "API is up and running. Use the documented endpoints to interact."
//   });
// });

// // ✅ Lander route for Nginx /lander
// app.get("/lander", (req, res) => {
//   res.json({
//     status: "success",
//     message: "Backend /lander route is working!",
//   });
// });

// const httpServer = http.createServer(app);
// const PORT = process.env.PORT || 9090;

// // 🔹 Start server after Mediasoup worker is ready
// (async () => {
//   try {
//     const worker = await createMediasoupWorker();

//     const io = await setupIntegratedSocket(httpServer, worker);
//     app.set("io", io);

//     httpServer.listen(PORT, "0.0.0.0", () => {
//       console.log(`🚀✨ Server is running on port ${PORT} 🌟`);
//     });

//     // 🔹 Graceful shutdown
//     const shutdown = async () => {
//       console.log("Shutting down...");
//       try {
//         io.close();
//         await worker.close();
//       } catch (e) {}
//       process.exit(0);
//     };
//     process.on("SIGINT", shutdown);
//     process.on("SIGTERM", shutdown);
//   } catch (err) {
//     console.error("❌ Failed to initialize server:", err);
//     process.exit(1);
//   }
// })();










// import dotenv from "dotenv";
// dotenv.config();

// import express from "express";
// import cookieParser from "cookie-parser";
// import connectDb from "./app/config/db.js";
// import cors from "cors";
// import indexRouter from "./app/routes/indexRouter.js";
// import { fileURLToPath } from "url";
// import path from "path";
// import session from "express-session";
// import morgan from "morgan";

// import http from "http";
// import mediasoup from "mediasoup";

// // 🔥 Socket.io (existing)
// import { setupIntegratedSocket } from "./app/services/socket.integrated.js";

// // 🔥 Yjs WebSocket (NEW)
// import { setupYjsServer } from "./app/services/yjs/yjs.server.cjs";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();

// /* =========================
//    🔹 Mediasoup Worker
// ========================= */
// const createMediasoupWorker = async () => {
//   const worker = await mediasoup.createWorker({
//     logLevel: process.env.MEDIASOUP_LOG_LEVEL || "warn",
//     rtcMinPort: parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000,
//     rtcMaxPort: parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999,
//   });

//   worker.on("died", () => {
//     console.error("❌ Mediasoup worker died, exiting in 2 seconds...");
//     setTimeout(() => process.exit(1), 2000);
//   });

//   console.log("✅ Mediasoup Worker Created");
//   return worker;
// };

// /* =========================
//    🔹 Middlewares
// ========================= */
// app.use(
//   cors({
//     origin: process.env.CORS_ORIGIN?.split(",") || ["http://192.168.1.15:5174"],
//     methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//     credentials: true,
//   })
// );

// app.use(morgan("dev"));
// app.use(express.json({ limit: "500mb" }));
// app.use(express.urlencoded({ limit: "500mb", extended: true }));
// app.use(cookieParser());

// connectDb();

// app.use("/public", express.static(path.join(__dirname, "public")));
// app.use("/apis", indexRouter);

// app.use(
//   session({
//     secret: process.env.SECRET_KEY || "defaultSecretKey",
//     resave: false,
//     saveUninitialized: true,
//     cookie: {
//       secure: process.env.NODE_ENV === "production",
//     },
//   })
// );

// /* =========================
//    🔹 Routes
// ========================= */
// app.get("/", (req, res) => {
//   res.json({
//     status: "success",
//     message: "🚀✨ Server is running successfully 🌟",
//     app: "SIMPLER_TRADING",
//     version: "1.0.0",
//     environment: process.env.NODE_ENV,
//     port: process.env.PORT,
//     serverTime: new Date().toISOString(),
//   });
// });

// app.get("/lander", (req, res) => {
//   res.json({
//     status: "success",
//     message: "Backend /lander route is working!",
//   });
// });

// /* =========================
//    🔹 HTTP Server
// ========================= */
// const httpServer = http.createServer(app);
// const PORT = process.env.PORT || 9090;

// /* =========================
//    🔹 Boot Server
// ========================= */
// (async () => {
//   try {
//     // 1️⃣ Mediasoup
//     const worker = await createMediasoupWorker();

//     // 2️⃣ Socket.io (existing system)
//     const io = await setupIntegratedSocket(httpServer, worker);
//     app.set("io", io);

//     // 3️⃣ 🔥 Yjs Real-time Collaboration (NEW)
//     setupYjsServer(httpServer);

//     // 4️⃣ Start server
//     httpServer.listen(PORT, "0.0.0.0", () => {
//       console.log(`🚀✨ Server running on port ${PORT}`);
//       console.log(`🧩 Yjs WS endpoint: ws://localhost:${PORT}/yjs`);
//     });

//     // 🔹 Graceful shutdown
//     const shutdown = async () => {
//       console.log("🛑 Shutting down server...");
//       try {
//         io.close();
//         await worker.close();
//       } catch (e) {}
//       process.exit(0);
//     };

//     process.on("SIGINT", shutdown);
//     process.on("SIGTERM", shutdown);

//   } catch (err) {
//     console.error("❌ Failed to initialize server:", err);
//     process.exit(1);
//   }
// })();






import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cookieParser from "cookie-parser";
import connectDb from "./app/config/db.js";
import cors from "cors";
import indexRouter from "./app/routes/indexRouter.js";
import { fileURLToPath } from "url";
import path from "path";
import session from "express-session";
import morgan from "morgan";

import http from "http";
import mediasoup from "mediasoup";

// 🔥 Socket.io
import { setupIntegratedSocket } from "./app/services/socket.integrated.js";

// ✅ Yjs (y-websocket compatible) server (Node v24 safe)
import { setupYWebsocketCompatibleServer, getYjsHealth } from "./app/services/yjs/yjs.server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* =========================
   🔹 Mediasoup Worker
========================= */
const createMediasoupWorker = async () => {
  const worker = await mediasoup.createWorker({
    logLevel: process.env.MEDIASOUP_LOG_LEVEL || "warn",
    rtcMinPort: parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000,
    rtcMaxPort: parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999,
  });

  worker.on("died", () => {
    console.error("❌ Mediasoup worker died, exiting...");
    setTimeout(() => process.exit(1), 2000);
  });

  console.log("✅ Mediasoup Worker Created");
  return worker;
};

/* =========================
   🔹 Middlewares
========================= */
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") || ["http://192.168.1.15:5174"],
    credentials: true,
  })
);

app.use(morgan("dev"));
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ limit: "500mb", extended: true }));
app.use(cookieParser());

connectDb();

app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/apis", indexRouter);

app.use(
  session({
    secret: process.env.SECRET_KEY || "defaultSecretKey",
    resave: false,
    saveUninitialized: true,
  })
);

/* =========================
   🔹 Routes
========================= */
app.get("/", (req, res) => {
  res.json({
    status: "success",
    message: "🚀 Server running",
    time: new Date().toISOString(),
  });
});

// ✅ Yjs Health Check Route
app.get("/yjs-health", getYjsHealth);

/* =========================
   🔹 HTTP Server
========================= */
const httpServer = http.createServer(app);
const PORT = process.env.PORT || 9090;

/* =========================
   🔹 Boot Server
========================= */
(async () => {
  try {
    // 1️⃣ Mediasoup
    const worker = await createMediasoupWorker();

    // 2️⃣ Socket.io
    const io = await setupIntegratedSocket(httpServer, worker);
    app.set("io", io);

    // 3️⃣ ✅ Yjs WS (y-websocket compatible): ws://HOST:PORT/yjs/:sessionId
    const yjsServer = setupYWebsocketCompatibleServer(httpServer);
    
    // Store Yjs server instance for cleanup
    app.set("yjsServer", yjsServer);

    // 4️⃣ Listen
    httpServer.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🧩 Yjs WS: ws://localhost:${PORT}/yjs/<sessionId>`);
      console.log(`📊 Yjs Health: http://localhost:${PORT}/yjs-health`);
    });

    const shutdown = async () => {
      console.log("🛑 Shutting down gracefully...");
      
      try {
        // Close Socket.io
        io.close();
        console.log("✅ Socket.io closed");
      } catch (socketErr) {
        console.error("Error closing socket.io:", socketErr.message);
      }

      try {
        // Close Yjs WebSocket server
        if (yjsServer && typeof yjsServer.cleanup === 'function') {
          yjsServer.cleanup();
          console.log("✅ Yjs WebSocket server cleaned up");
        }
      } catch (yjsErr) {
        console.error("Error cleaning up Yjs server:", yjsErr.message);
      }

      try {
        // Close Mediasoup worker
        await worker.close();
        console.log("✅ Mediasoup worker closed");
      } catch (workerErr) {
        console.error("Error closing mediasoup worker:", workerErr.message);
      }

      setTimeout(() => {
        console.log("👋 Server shutdown complete");
        process.exit(0);
      }, 1000);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // ✅ Optional: Monitor Yjs server stats periodically
    if (yjsServer && typeof yjsServer.getStats === 'function') {
      setInterval(() => {
        try {
          const stats = yjsServer.getStats();
          console.log(`📊 Yjs Stats: ${stats.totalRooms} rooms, ${stats.totalConnections} connections`);
        } catch (err) {
          // Silent fail for monitoring
        }
      }, 60000); // Every 60 seconds
    }

  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
})();