import fs from "fs";
import path from "path";
import os from "os";
import { generateSDP, saveSDPFile } from "./sdpGenerator.js";
import { startFFmpeg } from "./ffmpegRunner.js";

export const startLiveRecording = async ({ state, router, sessionId }) => {

  const TMP_DIR = path.join(os.tmpdir(), "live-recordings");
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  // 🔥 SEPARATE TRANSPORT FOR VIDEO
  const videoTransport = await router.createPlainTransport({
    listenIp: { ip: "127.0.0.1" },
    rtcpMux: true,
    comedia: true
  });

  const videoProducer = [...state.producers.values()]
    .find(p => p.kind === "video");

  if (!videoProducer) {
    throw new Error("No video producer found");
  }

  const videoConsumer = await videoTransport.consume({
    producerId: videoProducer.id,
    rtpCapabilities: router.rtpCapabilities
  });

  // 🔥 SEPARATE TRANSPORTS FOR AUDIO
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
        rtpCapabilities: router.rtpCapabilities
      });

      audioTransports.push(audioTransport);
      audioConsumers.push({ consumer, transport: audioTransport });
    }
  }

  // 🔹 SDP FILES
  const base = path.join(TMP_DIR, `session-${sessionId}`);
  const videoSdp = `${base}-video.sdp`;
  const audioSdps = audioConsumers.map((_, i) => `${base}-audio-${i}.sdp`);

  // 🎥 VIDEO SDP (UNIQUE PORT)
  saveSDPFile(videoSdp, generateSDP({
    ip: "127.0.0.1",
    port: videoTransport.tuple.localPort,
    payloadType: 96,
    codec: "VP8/90000",
    kind: "video"
  }));

  // 🎙 AUDIO SDPs (UNIQUE PORT EACH)
  audioConsumers.forEach((item, i) => {
    saveSDPFile(audioSdps[i], generateSDP({
      ip: "127.0.0.1",
      port: item.transport.tuple.localPort,
      payloadType: 111,
      codec: "opus/48000/2",
      kind: "audio"
    }));
  });

  // 🎬 OUTPUT
  const outputFile = `${base}.mp4`;

  const ffmpegProcess = startFFmpeg({
    videoSdp,
    audioSdps,
    output: outputFile
  });

  // 🔹 SAVE STATE
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
