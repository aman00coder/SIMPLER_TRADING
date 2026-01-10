import fs from "fs";
import path from "path";
import os from "os";
import { generateSDP, saveSDPFile } from "./sdpGenerator.js";
import { startFFmpeg } from "./ffmpegRunner.js";

/**
 * ✅ Wait for video producer
 */
const waitForVideoProducer = async (state, timeout = 8000) => {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const videoProducer = [...state.producers.values()]
      .find(p => p.kind === "video");

    if (videoProducer) return videoProducer;

    await new Promise(r => setTimeout(r, 100));
  }

  throw new Error("No video producer found (timeout)");
};

export const startLiveRecording = async ({ state, router, sessionId }) => {

  const TMP_DIR = path.join(os.tmpdir(), "live-recordings");
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  // ================= VIDEO =================
  const videoTransport = await router.createPlainTransport({
    listenIp: { ip: "127.0.0.1" },
    rtcpMux: true,
    comedia: true
  });

  const videoProducer = await waitForVideoProducer(state);

  const videoConsumer = await videoTransport.consume({
    producerId: videoProducer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: false
  });

  // ✅ resume consumer
  await videoConsumer.resume();

  // ✅ CORRECT KEYFRAME REQUEST (FIX)
  if (videoConsumer.requestKeyFrame) {
    await videoConsumer.requestKeyFrame();
  }

  // ================= AUDIO =================
  const audioConsumers = [];
  const audioTransports = [];

  for (const producer of state.producers.values()) {
    if (producer.kind === "audio") {
      const audioTransport = await router.createPlainTransport({
        listenIp: { ip: "127.0.0.1" },
        rtcpMux: true,
        comedia: true
      });

      const consumer = await audioTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false
      });

      await consumer.resume();

      audioTransports.push(audioTransport);
      audioConsumers.push({ consumer, transport: audioTransport });
    }
  }

  // ================= SDP =================
  const base = path.join(TMP_DIR, `session-${sessionId}`);
  const videoSdp = `${base}-video.sdp`;
  const audioSdps = audioConsumers.map((_, i) => `${base}-audio-${i}.sdp`);

  saveSDPFile(videoSdp, generateSDP({
    ip: "127.0.0.1",
    port: videoTransport.tuple.localPort,
    kind: "video",
    rtpParameters: videoConsumer.rtpParameters
  }));

  audioConsumers.forEach((item, i) => {
    saveSDPFile(audioSdps[i], generateSDP({
      ip: "127.0.0.1",
      port: item.transport.tuple.localPort,
      kind: "audio",
      rtpParameters: item.consumer.rtpParameters
    }));
  });

  // ================= FFMPEG =================
  const outputFile = `${base}.mp4`;

  const ffmpegProcess = startFFmpeg({
    videoSdp,
    audioSdps,
    output: outputFile
  });

  // ================= SAVE STATE =================
  state.recording = {
    videoTransport,
    audioTransports,
    videoConsumer,
    audioConsumers: audioConsumers.map(a => a.consumer),
    ffmpegProcess,
    filePath: outputFile,
    startTime: new Date()
  };
};
