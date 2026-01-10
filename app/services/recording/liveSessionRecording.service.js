import fs from "fs";
import path from "path";
import os from "os";
import { generateSDP, saveSDPFile } from "./sdpGenerator.js";
import { startFFmpeg } from "./ffmpegRunner.js";

export const startLiveRecording = async ({ state, router, sessionId }) => {

  // 🔹 TEMP DIR (cross-platform)
  const TMP_DIR = path.join(os.tmpdir(), "live-recordings");

  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  // 🔹 Plain transport
  const transport = await router.createPlainTransport({
    listenIp: { ip: "127.0.0.1" },
    rtcpMux: false,
    comedia: true
  });

  // 🎥 Streamer Video
  const streamerVideoProducer = [...state.producers.values()]
    .find(p => p.kind === "video");

  if (!streamerVideoProducer) {
    throw new Error("No video producer found for recording");
  }

  const videoConsumer = await transport.consume({
    producerId: streamerVideoProducer.id,
    rtpCapabilities: router.rtpCapabilities
  });

  // 🎙 All audio producers
  const audioConsumers = [];
  for (const producer of state.producers.values()) {
    if (producer.kind === "audio") {
      const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities
      });
      audioConsumers.push(consumer);
    }
  }

  // 🔹 SDP paths
  const base = path.join(TMP_DIR, `session-${sessionId}`);
  const videoSdp = `${base}-video.sdp`;
  const audioSdps = audioConsumers.map(
    (_, i) => `${base}-audio-${i}.sdp`
  );

  // 🎥 Video SDP
  saveSDPFile(videoSdp, generateSDP({
    ip: "127.0.0.1",
    port: transport.tuple.localPort,
    payloadType: 96,
    codec: "VP8/90000",
    kind: "video"
  }));

  // 🎙 Audio SDP(s)
  audioSdps.forEach((file, i) => {
    saveSDPFile(file, generateSDP({
      ip: "127.0.0.1",
      port: transport.tuple.localPort + i + 1,
      payloadType: 111,
      codec: "opus/48000/2",
      kind: "audio"
    }));
  });

  // 🎬 Output file
  const outputFile = `${base}.mp4`;

  // ▶ Start FFmpeg
  const ffmpegProcess = startFFmpeg({
    videoSdp,
    audioSdps,
    output: outputFile
  });

  // 🔹 Save recording state
  state.recording = {
    transport,
    videoConsumer,
    audioConsumers,
    ffmpegProcess,
    filePath: outputFile,
    startTime: new Date() // 👈 duration calculation ke liye
  };
};
