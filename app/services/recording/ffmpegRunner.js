// services/recording/ffmpegRunner.js
import { spawn } from "child_process";

export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {
  const args = [
    "-y",

    // ================= LOGGING =================
    "-loglevel", "warning",
    "-stats",

    // ================= INPUT / TIMESTAMP FIXES =================
    "-fflags", "+genpts",
    "-use_wallclock_as_timestamps", "1",
    "-async", "1",
    "-max_delay", "4000000",
    "-rw_timeout", "5000000",
    "-analyzeduration", "10000000",
    "-probesize", "10000000",

    // ================= VIDEO INPUT =================
    "-protocol_whitelist", "file,udp,rtp,pipe",
    "-i", videoSdp
  ];

  // ================= AUDIO INPUTS =================
  audioSdps.forEach((sdp) => {
    args.push(
      "-protocol_whitelist", "file,udp,rtp,pipe",
      "-i", sdp
    );
  });

  // ================= AUDIO MIXING =================
  if (audioSdps.length > 0) {
    args.push(
      "-filter_complex",
      `${audioSdps
        .map((_, i) => `[${i + 1}:a]`)
        .join("")}amix=inputs=${audioSdps.length}:dropout_transition=2:normalize=0,aresample=async=1:first_pts=0[a]`,
      "-map", "0:v",
      "-map", "[a]"
    );
  } else {
    args.push("-map", "0:v");
  }

  // ================= OUTPUT SETTINGS (IMPORTANT) =================
  args.push(
    // 🔥 OUTPUT-only options
    "-fps_mode", "cfr",

    // Video
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-profile:v", "main",
    "-r", "30",
    "-g", "60",
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-crf", "23",

    // Audio
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",

    // MP4
    "-movflags", "+faststart",
    "-f", "mp4",
    output
  );

  console.log("🎬 FFmpeg command:\nffmpeg", args.join(" "));

  const ffmpeg = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  ffmpeg.stderr.on("data", (data) => {
    const line = data.toString().trim();
    if (line && !line.includes("frame=")) {
      console.log("🎥 FFmpeg:", line);
    }
  });

  ffmpeg.on("error", (err) => {
    console.error("❌ FFmpeg process error:", err.message);
  });

  return ffmpeg;
};

export const waitForFFmpegExit = (ffmpegProcess, timeoutMs = 10000) => {
  return new Promise((resolve) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpegProcess.kill("SIGKILL");
      resolve();
    }, timeoutMs);

    ffmpegProcess.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    });
  });
};
