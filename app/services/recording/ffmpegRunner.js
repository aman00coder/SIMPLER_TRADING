import { spawn } from "child_process";

export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {

  const args = [
    "-y",

    // 🔥 RTP / timing stability
    "-use_wallclock_as_timestamps", "1",
    "-fflags", "+genpts",
    "-flags", "low_delay",

    // 🔥 IMPORTANT for SDP streams
    "-analyzeduration", "20000000",
    "-probesize", "20000000",

    // 🔥 allow RTP
    "-protocol_whitelist", "file,udp,rtp,pipe",
    "-i", videoSdp
  ];

  // 🎙 audio inputs
  audioSdps.forEach(sdp => {
    args.push(
      "-protocol_whitelist", "file,udp,rtp,pipe",
      "-i", sdp
    );
  });

  // 🔊 audio mix
  if (audioSdps.length > 0) {
    args.push(
      "-filter_complex",
      `${audioSdps.map((_, i) => `[${i + 1}:a]`).join("")}amix=inputs=${audioSdps.length}:dropout_transition=0[a]`,
      "-map", "0:v",
      "-map", "[a]"
    );
  } else {
    args.push("-map", "0:v");
  }

  args.push(
    // 🔥 FORCE valid frames (THIS FIXES 0 BYTE FILE)
    "-vsync", "1",
    "-vf", "scale=1280:720,fps=30",
    "-pix_fmt", "yuv420p",

    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "baseline",
    "-x264opts", "keyint=60:min-keyint=60:no-scenecut",

    "-c:a", "aac",
    "-movflags", "+faststart",

    output
  );

  const ffmpeg = spawn("ffmpeg", args);

  ffmpeg.stderr.on("data", d => {
    console.log("🔥 FFmpeg:", d.toString());
  });

  ffmpeg.on("exit", code => {
    console.log("🎬 FFmpeg exited with code:", code);
  });

  return ffmpeg;
};
