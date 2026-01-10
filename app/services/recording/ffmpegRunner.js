import { spawn } from "child_process";

export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {
  const args = [
    "-y",

    // 🔥 MUST for VP8 + SDP
    "-fflags", "+genpts",
    "-protocol_whitelist", "file,udp,rtp,pipe",

    // 🔥 FORCE video size (VERY IMPORTANT)
    "-video_size", "1280x720",

    // 🎥 video input
    "-i", videoSdp
  ];

  // 🎙 audio inputs
  audioSdps.forEach(sdp => {
    args.push("-i", sdp);
  });

  // 🔊 mix audio
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
    // 🔥 encoder settings
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
