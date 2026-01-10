import { spawn } from "child_process";

// ✅ NAMED EXPORT (IMPORTANT)
export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {

  const args = [
    "-y",

    // timing / RTP safety
    "-use_wallclock_as_timestamps", "1",
    "-fflags", "+genpts",
    "-flags", "low_delay",

    "-analyzeduration", "15000000",
    "-probesize", "15000000",

    // 🔥 whitelist BEFORE every input
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

  // 🔊 audio mixing
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
    // 🎥 force size (VP8 fix)
    "-vf", "scale=1280:720",
    "-pix_fmt", "yuv420p",
    "-r", "30",

    "-c:v", "libx264",
    "-preset", "veryfast",
    "-profile:v", "baseline",

    "-c:a", "aac",
    "-movflags", "+faststart",

    output
  );

  const ffmpeg = spawn("ffmpeg", args);

  ffmpeg.stderr.on("data", data => {
    console.error("🔥 FFmpeg:", data.toString());
  });

  ffmpeg.on("exit", code => {
    console.log("🎬 FFmpeg exited with code:", code);
  });

  return ffmpeg;
};
