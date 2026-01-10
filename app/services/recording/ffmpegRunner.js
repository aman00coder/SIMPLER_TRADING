import { spawn } from "child_process";

export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {
  const args = [
    "-y",

    // 🔥 RTP stability
    "-fflags", "+genpts+igndts",
    "-flags", "low_delay",
    "-strict", "experimental",
    "-rtbufsize", "150M",
    "-max_delay", "500000",

    "-analyzeduration", "30000000",
    "-probesize", "30000000",

    // ================= VIDEO =================
    "-protocol_whitelist", "file,udp,rtp,pipe",
    "-i", videoSdp
  ];

  // ================= AUDIO =================
  audioSdps.forEach(sdp => {
    args.push(
      "-protocol_whitelist", "file,udp,rtp,pipe",
      "-i", sdp
    );
  });

  // ================= MAPPING =================
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

  // ================= OUTPUT =================
  args.push(
    // 🔥 FORCE SIZE (fix 0x0 issue)
    "-vf", "scale=1280:720",

    "-fps_mode", "cfr",
    "-r", "30",

    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "baseline",
    "-pix_fmt", "yuv420p",

    "-c:a", "aac",
    "-ar", "48000",

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
