import fs from "fs";
import path from "path";
import os from "os";
import { generateSDP, saveSDPFile } from "./sdpGenerator.js";
import { startFFmpeg } from "./ffmpegRunner.js";

/**
 * ✅ Wait until a video producer exists
 */
const waitForVideoProducer = async (state, timeout = 8000) => {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const videoProducer = [...state.producers.values()].find(
      p => p.kind === "video"
    );

    if (videoProducer) return videoProducer;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error("No video producer found (timeout)");
};

export const startLiveRecording = async ({ state, router, sessionId }) => {
  // ================= TMP DIR =================
  const TMP_DIR = path.join(os.tmpdir(), "live-recordings");
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  // ================= VIDEO TRANSPORT =================
  const videoTransport = await router.createPlainTransport({
    listenIp: { ip: "127.0.0.1" },
    rtcpMux: false,          // ❗ important for FFmpeg
    comedia: false           // ❗ we will connect manually
  });

  // ================= VIDEO CONSUMER =================
  const videoProducer = await waitForVideoProducer(state);

  const videoConsumer = await videoTransport.consume({
    producerId: videoProducer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: false
  });

  await videoConsumer.resume();

  // 🔥 MUST: request keyframe from CONSUMER (not producer)
  if (videoConsumer.requestKeyFrame) {
    await videoConsumer.requestKeyFrame();
  }

  // ================= AUDIO TRANSPORTS =================
  const audioConsumers = [];
  const audioTransports = [];

  for (const producer of state.producers.values()) {
    if (producer.kind === "audio") {
      const audioTransport = await router.createPlainTransport({
        listenIp: { ip: "127.0.0.1" },
        rtcpMux: false,
        comedia: false
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

  // ================= SDP FILES =================
  const base = path.join(TMP_DIR, `session-${sessionId}`);
  const videoSdp = `${base}-video.sdp`;
  const audioSdps = audioConsumers.map((_, i) => `${base}-audio-${i}.sdp`);

  // 🎥 VIDEO SDP
  saveSDPFile(
    videoSdp,
    generateSDP({
      ip: "127.0.0.1",
      port: videoTransport.tuple.localPort,
      kind: "video",
      rtpParameters: videoConsumer.rtpParameters
    })
  );

  // 🎙 AUDIO SDPs
  audioConsumers.forEach((item, i) => {
    saveSDPFile(
      audioSdps[i],
      generateSDP({
        ip: "127.0.0.1",
        port: item.transport.tuple.localPort,
        kind: "audio",
        rtpParameters: item.consumer.rtpParameters
      })
    );
  });

  // ================= CONNECT TRANSPORTS =================
  // 🔥 THIS IS THE REAL FIX — RTP WILL FLOW ONLY AFTER THIS

  await videoTransport.connect({
    ip: "127.0.0.1",
    port: videoTransport.tuple.localPort,
    rtcpPort: videoTransport.tuple.localPort + 1
  });

  for (const t of audioTransports) {
    await t.connect({
      ip: "127.0.0.1",
      port: t.tuple.localPort,
      rtcpPort: t.tuple.localPort + 1
    });
  }

  // ================= START FFMPEG =================
  const outputFile = `${base}.mp4`;

  const ffmpegProcess = startFFmpeg({
    videoSdp,
    audioSdps,
    output: outputFile
  });

  // ================= SAVE RECORDING STATE =================
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
