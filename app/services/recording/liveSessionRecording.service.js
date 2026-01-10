import path from "path";
import { generateSDP, saveSDPFile } from "./sdpGenerator.js";
import { startFFmpeg } from "./ffmpegRunner.js";

export const startLiveRecording = async ({ state, router, sessionId }) => {
  const transport = await router.createPlainTransport({
    listenIp: { ip: "127.0.0.1" },
    rtcpMux: false,
    comedia: true
  });

  // 🎥 Streamer Video
  const streamerVideoProducer = [...state.producers.values()].find(
    p => p.kind === "video"
  );

  const videoConsumer = await transport.consume({
    producerId: streamerVideoProducer.id,
    rtpCapabilities: router.rtpCapabilities
  });

  // 🎙 All audio
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

  // SDP files
  const base = `/tmp/session-${sessionId}`;
  const videoSdp = `${base}-video.sdp`;
  const audioSdps = audioConsumers.map((_, i) => `${base}-audio-${i}.sdp`);

  saveSDPFile(videoSdp, generateSDP({
    ip: "127.0.0.1",
    port: transport.tuple.localPort,
    payloadType: 96,
    codec: "VP8/90000",
    kind: "video"
  }));

  audioSdps.forEach((file, i) => {
    saveSDPFile(file, generateSDP({
      ip: "127.0.0.1",
      port: transport.tuple.localPort + i + 1,
      payloadType: 111,
      codec: "opus/48000/2",
      kind: "audio"
    }));
  });

  const outputFile = `${base}.mp4`;

  const ffmpegProcess = startFFmpeg({
    videoSdp,
    audioSdps,
    output: outputFile
  });

  state.recording = {
    transport,
    videoConsumer,
    audioConsumers,
    ffmpegProcess,
    filePath: outputFile
  };
};
