// services/recording/liveSessionRecording.services.js
import fs from "fs";
import path from "path";
import os from "os";

import { generateSDP, saveSDPFile } from "./sdpGenerator.js";
import { startFFmpeg } from "./ffmpegRunner.js";

const waitForVideoProducer = async (state, timeout = 10000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const producer = [...state.producers.values()].find(
      p => p.kind === "video" && !p.closed
    );
    if (producer) return producer;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Video producer not found");
};

const requestKeyframeWithRetry = async (producer, retries = 5) => {
  for (let i = 0; i < retries; i++) {
    try {
      await producer.requestKeyFrame();
      console.log(`🎯 Keyframe requested (attempt ${i + 1})`);
      return true;
    } catch (err) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
};

export const startLiveRecording = async ({ state, router, sessionId }) => {
  if (state.recording?.active) {
    throw new Error("Recording already active");
  }

  if (!state.recording) {
    state.recording = {};
  }

  const VIDEO_PORT = 5004;
  const VIDEO_RTCP_PORT = 5005;
  const AUDIO_BASE_PORT = 6000;
  const serverIp = process.env.SERVER_IP || "127.0.0.1";

  const videoProducer = await waitForVideoProducer(state);

  // ⚠️ Viewer-less warning (important for stability)
  if (!state.viewers || state.viewers.size === 0) {
    console.warn("⚠️ No viewers connected. Recording may be unstable.");
  }

  // 🔥 KEYFRAME GUARANTEE
  const keyframeOk = await requestKeyframeWithRetry(videoProducer);
  if (!keyframeOk) {
    throw new Error("Keyframe not received. Cannot start recording safely.");
  }

  // ---------------- VIDEO TRANSPORT ----------------
  const videoTransport = await router.createPlainTransport({
    listenIp: { ip: "0.0.0.0", announcedIp: serverIp },
    rtcpMux: false,
    comedia: false
  });

  await videoTransport.connect({
    ip: serverIp,
    port: VIDEO_PORT,
    rtcpPort: VIDEO_RTCP_PORT
  });

  const videoConsumer = await videoTransport.consume({
    producerId: videoProducer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: true
  });

  await videoConsumer.resume();

  // ---------------- AUDIO TRANSPORTS ----------------
  const audioConsumers = [];
  const audioTransports = [];
  let index = 0;

  for (const producer of state.producers.values()) {
    if (producer.kind === "audio" && !producer.closed) {
      const port = AUDIO_BASE_PORT + index * 2;

      const audioTransport = await router.createPlainTransport({
        listenIp: { ip: "0.0.0.0", announcedIp: serverIp },
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
        paused: true
      });

      await consumer.resume();

      audioConsumers.push({ consumer, port });
      audioTransports.push(audioTransport);
      index++;
    }
  }

  // ⏳ IMPORTANT: RTP warm-up delay
  await new Promise(r => setTimeout(r, 2000));

  // ---------------- SDP GENERATION ----------------
  const TMP_DIR = path.join(os.tmpdir(), "live-recordings");
  fs.mkdirSync(TMP_DIR, { recursive: true });

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

  // ---------------- START FFMPEG ----------------
  const outputFile = path.join(
    TMP_DIR,
    `recording_${sessionId}_${Date.now()}.mp4`
  );

  state.recording = {
    active: true,
    startTime: Date.now(),
    videoTransport,
    audioTransports,
    videoConsumer,
    audioConsumers,
    filePath: outputFile,
    ffmpegProcess: startFFmpeg({
      videoSdp,
      audioSdps,
      output: outputFile
    })
  };

  return state.recording;
};
