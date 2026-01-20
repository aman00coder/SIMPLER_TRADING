// services/recording/liveSessionRecording.services.js
import fs from "fs";
import path from "path";
import os from "os";
import fetch from "node-fetch";

import { generateSDP, saveSDPFile } from "./sdpGenerator.js";
import { startFFmpeg } from "./ffmpegRunner.js";
import { generatePresignedUrl } from "../../middleware/aws.s3.js";

// =====================================================
// WAIT FOR VIDEO PRODUCER
// =====================================================
const waitForVideoProducer = async (state, timeout = 10000) => {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const producer = [...state.producers.values()].find(
      (p) => p.kind === "video"
    );
    if (producer) return producer;
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error("Video producer not found");
};

// =====================================================
// UPLOAD TO S3 USING PRESIGNED URL
// =====================================================
const uploadToS3ViaPresignedUrl = async (filePath, sessionId) => {
  console.log("📤 Uploading recording to S3...");

  const stats = fs.statSync(filePath);
  if (!stats || stats.size < 100 * 1024) {
    throw new Error("Recording file too small / empty");
  }

  const fileName = `recording_${sessionId}_${Date.now()}.mp4`;

  const presigned = await generatePresignedUrl({
    fileName,
    fileType: "video/mp4",
    folder: "live-recordings",
    expiresIn: 3600
  });

  const buffer = fs.readFileSync(filePath);

  const response = await fetch(presigned.uploadUrl, {
    method: "PUT",
    body: buffer,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": buffer.length
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`S3 upload failed: ${response.status} ${text}`);
  }

  console.log("✅ Uploaded to S3:", presigned.fileUrl);

  return {
    fileUrl: presigned.fileUrl,
    fileName,
    fileKey: presigned.fileKey
  };
};

// =====================================================
// START FFMPEG + HANDLE UPLOAD
// =====================================================
const startFFmpegWithS3Upload = ({
  videoSdp,
  audioSdps,
  sessionId,
  state
}) => {
  return new Promise((resolve) => {
    const TMP_DIR = path.join(os.tmpdir(), "live-recordings");
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true });
    }

    const localOutput = path.join(
      TMP_DIR,
      `recording_${sessionId}_${Date.now()}.mp4`
    );

    console.log("🎬 FFmpeg output file:", localOutput);

    const ffmpeg = startFFmpeg({
      videoSdp,
      audioSdps,
      output: localOutput
    });

    state.recording.ffmpegProcess = ffmpeg;
    state.recording.filePath = localOutput;

    ffmpeg.once("close", async (code, signal) => {
      console.log(`🔴 FFmpeg closed (code=${code}, signal=${signal})`);

      let result = {
        success: false,
        fileUrl: null,
        fileName: null,
        duration: 0,
        reason: null
      };

      try {
        const stats = fs.existsSync(localOutput)
          ? fs.statSync(localOutput)
          : null;

        if (!stats || stats.size < 100 * 1024) {
          result.reason = "Recording too short / empty";
        } else {
          const upload = await uploadToS3ViaPresignedUrl(
            localOutput,
            sessionId
          );

          const endTime = Date.now();
          const startTime = state.recording.startTime?.getTime() || endTime;

          result = {
            success: true,
            fileUrl: upload.fileUrl,
            fileName: upload.fileName,
            duration: Math.floor((endTime - startTime) / 1000)
          };
        }
      } catch (err) {
        console.error("❌ Recording upload error:", err.message);
        result.reason = err.message;
      }

      // ================= CLEANUP =================
      try {
        if (fs.existsSync(localOutput)) fs.unlinkSync(localOutput);
        [videoSdp, ...audioSdps].forEach((f) => {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        });
      } catch {}

      resolve(result); // ✅ ALWAYS RESOLVE
    });

    ffmpeg.once("error", (err) => {
      console.error("❌ FFmpeg runtime error:", err.message);
      resolve({
        success: false,
        fileUrl: null,
        fileName: null,
        duration: 0,
        reason: err.message
      });
    });
  });
};

// =====================================================
// MAIN ENTRY: START LIVE RECORDING
// =====================================================
export const startLiveRecording = async ({ state, router, sessionId }) => {
  console.log("🎬 START LIVE RECORDING:", sessionId);

  // 🔐 Guard: prevent double recording
  if (state.recording?.active) {
    throw new Error("Recording already active for this session");
  }

  if (!state.recording) {
    state.recording = {
      active: false,
      videoTransport: null,
      audioTransports: [],
      videoConsumer: null,
      audioConsumers: [],
      recordingPromise: null,
      startTime: null,
      ffmpegProcess: null,
      filePath: null
    };
  }

  // ================= PORTS =================
  const VIDEO_PORT = 5004;
  const VIDEO_RTCP_PORT = 5005;
  const AUDIO_BASE_PORT = 6000;

  // ================= SERVER IP =================
  const serverIp = process.env.SERVER_IP || "127.0.0.1";

  // ================= VIDEO TRANSPORT =================
  const videoTransport = await router.createPlainTransport({
    listenIp: {
      ip: "0.0.0.0",
      announcedIp: serverIp
    },
    rtcpMux: false,
    comedia: false
  });

  await videoTransport.connect({
    ip: serverIp,
    port: VIDEO_PORT,
    rtcpPort: VIDEO_RTCP_PORT
  });

  const videoProducer = await waitForVideoProducer(state);

  const videoConsumer = await videoTransport.consume({
    producerId: videoProducer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: false
  });

  await videoConsumer.resume();

  // ================= AUDIO TRANSPORTS =================
  const audioConsumers = [];
  const audioTransports = [];

  let index = 0;
  for (const producer of state.producers.values()) {
    if (producer.kind === "audio") {
      const port = AUDIO_BASE_PORT + index * 2;

      const audioTransport = await router.createPlainTransport({
        listenIp: {
          ip: "0.0.0.0",
          announcedIp: serverIp
        },
        rtcpMux: false,
        comedia: false
      });

      await audioTransport.connect({
        ip: serverIp,
        port,
        rtcpPort: port + 1
      });

      const consumer = await audioTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false
      });

      await consumer.resume();

      audioConsumers.push({ consumer, port });
      audioTransports.push(audioTransport);
      index++;
    }
  }

  // ================= SDP FILES =================
  const TMP_DIR = path.join(os.tmpdir(), "live-recordings");
  const base = path.join(TMP_DIR, `session-${sessionId}`);

  const videoSdp = `${base}-video.sdp`;
  const audioSdps = audioConsumers.map((_, i) => `${base}-audio-${i}.sdp`);

  saveSDPFile(
    videoSdp,
    generateSDP({
      ip: serverIp,
      port: VIDEO_PORT,
      kind: "video",
      rtpParameters: videoConsumer.rtpParameters
    })
  );

  audioConsumers.forEach((a, i) => {
    saveSDPFile(
      audioSdps[i],
      generateSDP({
        ip: serverIp,
        port: a.port,
        kind: "audio",
        rtpParameters: a.consumer.rtpParameters
      })
    );
  });

  // ================= START FFMPEG =================
  state.recording.startTime = new Date();
  state.recording.active = true;

  const recordingPromise = startFFmpegWithS3Upload({
    videoSdp,
    audioSdps,
    sessionId,
    state
  });

  // ================= STATE UPDATE =================
  state.recording.videoTransport = videoTransport;
  state.recording.audioTransports = audioTransports;
  state.recording.videoConsumer = videoConsumer;
  state.recording.audioConsumers = audioConsumers.map((a) => a.consumer);
  state.recording.recordingPromise = recordingPromise;

  console.log("✅ Recording started successfully");
  console.log("📡 Server IP:", serverIp);
  console.log("🔊 Audio streams:", audioConsumers.length);

  return state.recording;
};
