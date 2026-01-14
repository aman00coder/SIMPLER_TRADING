import fs from "fs";
import path from "path";
import os from "os";
import fetch from "node-fetch"; // npm install node-fetch

import { generateSDP, saveSDPFile } from "./sdpGenerator.js";
import { startFFmpeg, waitForFFmpegExit } from "./ffmpegRunner.js";
import { generatePresignedUrl } from "../../middleware/aws.s3.js";

/**
 * Wait until video producer is available
 */
const waitForVideoProducer = async (state, timeout = 10000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const producer = [...state.producers.values()].find(p => p.kind === "video");
    if (producer) return producer;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Video producer not found");
};

/**
 * Upload file to S3 using pre-signed URL
 */
const uploadToS3ViaPresignedUrl = async (filePath, sessionId) => {
  try {
    console.log("📤 Starting S3 upload via pre-signed URL...");
    
    const stats = fs.statSync(filePath);
    if (stats.size < 100 * 1024) {
      throw new Error("Recording file too small (no frames received)");
    }

    const fileName = `recording_${sessionId}_${Date.now()}.mp4`;
    
    // Get pre-signed URL for upload
    const presignedData = await generatePresignedUrl({
      fileName: fileName,
      fileType: "video/mp4",
      folder: "live-recordings",
      expiresIn: 3600 // 1 hour for safety
    });

    console.log("🔗 Got pre-signed URL:", presignedData.uploadUrl.substring(0, 100) + "...");

    // Read file as buffer
    const fileBuffer = fs.readFileSync(filePath);
    
    // Upload using pre-signed URL
    const response = await fetch(presignedData.uploadUrl, {
      method: 'PUT',
      body: fileBuffer,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': stats.size.toString()
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`S3 upload failed: ${response.status} - ${errorText}`);
    }

    console.log("✅ File uploaded to S3:", presignedData.fileUrl);

    return {
      fileUrl: presignedData.fileUrl,
      fileName: fileName,
      fileKey: presignedData.fileKey
    };
  } catch (error) {
    console.error("❌ Pre-signed URL upload error:", error);
    throw error;
  }
};

/**
 * Start FFmpeg and handle S3 upload when finished
 */
const startFFmpegWithS3Upload = ({ 
  videoSdp, 
  audioSdps, 
  sessionId,
  state
}) => {
  return new Promise((resolve, reject) => {
    const TMP_DIR = path.join(os.tmpdir(), "live-recordings");
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    
    const localOutput = path.join(TMP_DIR, `temp_${sessionId}_${Date.now()}.mp4`);
    
    console.log("🎬 Starting FFmpeg recording to:", localOutput);
    
    // Start FFmpeg
    const ffmpegProcess = startFFmpeg({
      videoSdp,
      audioSdps,
      output: localOutput
    });

    // Save FFmpeg process reference in state
    state.recording.ffmpegProcess = ffmpegProcess;
    state.recording.filePath = localOutput;

    // Monitor FFmpeg stderr for logs
    ffmpegProcess.stderr.on('data', (data) => {
      console.log('🎥 FFmpeg:', data.toString().trim());
    });

    // Handle FFmpeg completion
    ffmpegProcess.once("close", async (code, signal) => {
      console.log(`🔴 FFmpeg closed - Code: ${code}, Signal: ${signal}`);
      
      if (code === 0 || signal === "SIGINT") {
        try {
          // Upload to S3 using pre-signed URL
          console.log("📤 Uploading recording to S3...");
          const uploadResult = await uploadToS3ViaPresignedUrl(localOutput, sessionId);
          
          // Cleanup local files
          if (fs.existsSync(localOutput)) {
            fs.unlinkSync(localOutput);
            console.log("🧹 Cleaned local file:", localOutput);
          }
          
          // Cleanup SDP files
          [videoSdp, ...audioSdps].forEach(sdp => {
            if (fs.existsSync(sdp)) {
              fs.unlinkSync(sdp);
              console.log("🧹 Cleaned SDP:", sdp);
            }
          });

          console.log("✅ Recording completed and uploaded");
          resolve(uploadResult);
        } catch (uploadError) {
          console.error("❌ Upload failed:", uploadError);
          reject(uploadError);
        }
      } else {
        const error = new Error(`FFmpeg exited abnormally: code=${code}, signal=${signal}`);
        console.error("❌ FFmpeg error:", error.message);
        reject(error);
      }
    });

    ffmpegProcess.once("error", (err) => {
      console.error("❌ FFmpeg process error:", err);
      reject(err);
    });
  });
};

/**
 * Main recording function
 */
export const startLiveRecording = async ({ state, router, sessionId }) => {
  const TMP_DIR = path.join(os.tmpdir(), "live-recordings");
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  // ✅ FIX: Initialize recording state BEFORE starting FFmpeg
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

  // ================= FIXED PORTS =================
  const VIDEO_PORT = 5004;
  const VIDEO_RTCP_PORT = 5005;
  const AUDIO_BASE_PORT = 6000;

  // ================= VIDEO =================
  const videoTransport = await router.createPlainTransport({
    listenIp: { ip: "127.0.0.1" },
    rtcpMux: false,
    comedia: false
  });

  await videoTransport.connect({
    ip: "127.0.0.1",
    port: VIDEO_PORT,
    rtcpPort: VIDEO_RTCP_PORT
  });

  const videoProducer = await waitForVideoProducer(state);

  // 🔴 GUARD: recording might be stopped meanwhile
  if (state.recording && state.recording.active === false) {
    videoTransport.close();
    return;
  }

  const videoConsumer = await videoTransport.consume({
    producerId: videoProducer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: false
  });

  await videoConsumer.resume();

  // ================= AUDIO =================
  const audioConsumers = [];
  const audioTransports = [];

  let audioIndex = 0;

  for (const producer of state.producers.values()) {
    if (producer.kind === "audio") {
      const port = AUDIO_BASE_PORT + audioIndex * 2;

      const audioTransport = await router.createPlainTransport({
        listenIp: { ip: "127.0.0.1" },
        rtcpMux: false,
        comedia: false
      });

      await audioTransport.connect({
        ip: "127.0.0.1",
        port,
        rtcpPort: port + 1
      });

      // 🔴 GUARD
      if (state.recording && state.recording.active === false) {
        audioTransport.close();
        continue;
      }

      const consumer = await audioTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false
      });

      await consumer.resume();

      audioConsumers.push({ consumer, port });
      audioTransports.push(audioTransport);
      audioIndex++;
    }
  }

  // ================= SDP =================
  const base = path.join(TMP_DIR, `session-${sessionId}`);
  const videoSdp = `${base}-video.sdp`;
  const audioSdps = audioConsumers.map((_, i) => `${base}-audio-${i}.sdp`);

  saveSDPFile(videoSdp, generateSDP({
    ip: "127.0.0.1",
    port: VIDEO_PORT,
    kind: "video",
    rtpParameters: videoConsumer.rtpParameters
  }));

  audioConsumers.forEach((item, i) => {
    saveSDPFile(audioSdps[i], generateSDP({
      ip: "127.0.0.1",
      port: item.port,
      kind: "audio",
      rtpParameters: item.consumer.rtpParameters
    }));
  });

  // ================= START FFMPEG WITH S3 UPLOAD =================
  const recordingPromise = startFFmpegWithS3Upload({
    videoSdp,
    audioSdps,
    sessionId,
    state
  });

  // ================= UPDATE RECORDING STATE =================
  state.recording.active = true;
  state.recording.videoTransport = videoTransport;
  state.recording.audioTransports = audioTransports;
  state.recording.videoConsumer = videoConsumer;
  state.recording.audioConsumers = audioConsumers.map(a => a.consumer);
  state.recording.recordingPromise = recordingPromise;
  // ✅ FIX: Set startTime properly
  state.recording.startTime = new Date();
  state.recording.filePath = path.join(TMP_DIR, `temp_${sessionId}_${Date.now()}.mp4`);

  console.log("✅ Recording started with pre-signed URL flow");
  console.log("🎬 Recording started at:", state.recording.startTime.toISOString());
  console.log("📁 Temporary file path:", state.recording.filePath);
  console.log("📊 Recording state initialized:", {
    active: state.recording.active,
    hasVideoTransport: !!state.recording.videoTransport,
    hasAudioTransports: state.recording.audioTransports.length,
    hasRecordingPromise: !!state.recording.recordingPromise,
    startTimeSet: !!state.recording.startTime
  });

  // Handle recording promise completion
  recordingPromise
    .then((uploadResult) => {
      console.log("✅ Recording completed successfully:", uploadResult);
      
      // Update state after successful recording
      if (state.recording) {
        state.recording.active = false;
        state.recording.completed = true;
        state.recording.uploadResult = uploadResult;
        state.recording.endTime = new Date();
        
        // Calculate duration
        if (state.recording.startTime && state.recording.endTime) {
          const duration = Math.floor(
            (state.recording.endTime.getTime() - state.recording.startTime.getTime()) / 1000
          );
          state.recording.duration = duration;
          console.log(`⏱️ Recording duration: ${duration} seconds`);
        }
      }
    })
    .catch((error) => {
      console.error("❌ Recording failed:", error);
      
      // Update state on error
      if (state.recording) {
        state.recording.active = false;
        state.recording.error = error.message;
        state.recording.endTime = new Date();
      }
    });

  return state.recording;
};