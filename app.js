import dotenv from 'dotenv';
dotenv.config();
 
import express from 'express';
import cookieParser from 'cookie-parser';
import connectDb from './app/config/db.js';
import cors from 'cors';
import indexRouter from './app/routes/indexRouter.js';
import { fileURLToPath } from 'url';
import path from 'path';
import session from 'express-session';
import morgan from 'morgan';
 
import http from 'http';
import setupSocket  from './app/services/socket.js';
import setupSocketWebRtc  from './app/services/socket.webrtc.js';
 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
 
const app = express();
 
app.use(cors({
    origin: (origin, callback) => {
        callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));
 
app.use(morgan("dev"));

// ✅ Use built-in express middleware
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(cookieParser());

connectDb();
 
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/apis', indexRouter);
 
app.use(session({
    secret: process.env.SECRET_KEY || "defaultSecretKey",
    resave: false,
    saveUninitialized: true,
}));
 
app.get("/", (req, res) => {
    res.json({
        message: "🚀✨ Server is running successfully 🌟"
    });
});
 
const httpServer = http.createServer(app);
 
// ✅ Initialize socket.io layers
setupSocket(httpServer);

const io = setupSocketWebRtc(httpServer); // return milta hai
app.set("io", io); // ✅ controller ke liye save

const PORT = process.env.PORT || 9090;
httpServer.listen(PORT, () => {
    console.log(`🚀✨ Server is running on port ${PORT} 🌟`);
});
