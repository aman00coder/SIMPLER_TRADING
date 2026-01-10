import fs from "fs";
import path from "path";
import os from "os";
import { generateSDP, saveSDPFile } from "./sdpGenerator.js";
import { startFFmpeg } from "./ffmpegRunner.js";

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

export const startLiveRecording = async ({ state, router, sessionId }) => {

  const TMP_DIR = path.join(os.tmpdir(), "live-recordings");
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

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

  // 🔥 THIS IS THE MISSING PIECE
  await videoTransport.connect({
    ip: "127.0.0.1",
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

  // ================= START FFMPEG =================
  const outputFile = `${base}.mp4`;

  const ffmpegProcess = startFFmpeg({
    videoSdp,
    audioSdps,
    output: outputFile
  });

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
