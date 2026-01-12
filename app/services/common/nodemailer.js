// config/emailTransporter.js

import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Email transporter setup
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, // e.g., smtp.gmail.com
    port: parseInt(process.env.SMTP_PORT), // e.g., 465 or 587
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for 587
    auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASSWORD,
    },
    tls: {
        rejectUnauthorized: false,
    },
});

// Verify transporter
transporter.verify((err, success) => {
    if (err) {
        console.error("❌ Email transporter verification failed:", err.message);
    } else {
        console.log("✅ Email transporter is configured and ready.");
    }
});

export default transporter;
