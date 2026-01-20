// services/recording/liveSessionRecording.services.js
import fs from "fs";
import path from "path";
import os from "os";
import fetch from "node-fetch";

import { generateSDP, saveSDPFile } from "./sdpGenerator.js";
import { startFFmpeg } from "./ffmpegRunner.js";
import { generatePresignedUrl } from "../../middleware/aws.s3.js";

const waitForVideoProducer = async (state, timeout = 10000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const producer = [...state.producers.values()].find(p => p.kind === "video");
    if (producer) return producer;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Video producer not found");
};

export const startLiveRecording = async ({ state, router, sessionId }) => {
  if (state.recording?.active) {
    throw new Error("Recording already active");
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

  const VIDEO_PORT = 5004;
  const VIDEO_RTCP_PORT = 5005;
  const AUDIO_BASE_PORT = 6000;
  const serverIp = process.env.SERVER_IP || "127.0.0.1";

  const videoProducer = await waitForVideoProducer(state);

  // 🔥🔥 MAIN FIX: force keyframe BEFORE recording
  try {
    videoProducer.requestKeyFrame();
    console.log("🎯 Keyframe requested from video producer");
  } catch {
    console.warn("⚠️ Failed to request keyframe");
  }

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
    paused: false
  });

  await videoConsumer.resume();

  const audioConsumers = [];
  const audioTransports = [];
  let index = 0;

  for (const producer of state.producers.values()) {
    if (producer.kind === "audio") {
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
        paused: false
      });

      await consumer.resume();

      audioConsumers.push({ consumer, port });
      audioTransports.push(audioTransport);
      index++;
    }
  }

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

  state.recording.startTime = new Date();
  state.recording.active = true;

  state.recording.recordingPromise = startFFmpeg({
    videoSdp,
    audioSdps,
    output: path.join(
      TMP_DIR,
      `recording_${sessionId}_${Date.now()}.mp4`
    )
  });

  return state.recording;
};
