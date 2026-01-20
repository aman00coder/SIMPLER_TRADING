// services/recording/ffmpegRunner.js
import { spawn } from "child_process";

// =================================================
// START FFMPEG
// =================================================
export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {
  const args = [
    "-y",

    // ================= LOGGING =================
    "-loglevel", "warning",
    "-stats",

    // ================= RTP INPUT STABILITY =================
    "-fflags", "+genpts+igndts",
    "-flags", "low_delay",
    "-use_wallclock_as_timestamps", "1",
    "-reorder_queue_size", "5000",
    "-rtbufsize", "300M",
    "-max_delay", "10000000",
    "-rw_timeout", "10000000",
    "-analyzeduration", "15000000",
    "-probesize", "15000000",

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

  // ================= OUTPUT SETTINGS =================
args.push(
  "-fps_mode", "vfr",

  // Video
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-pix_fmt", "yuv420p",
  "-profile:v", "main",
  "-g", "60",
  "-maxrate", "2500k",
  "-bufsize", "5000k",
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

// =================================================
// WAIT FOR FFMPEG EXIT
// =================================================
export const waitForFFmpegExit = (ffmpegProcess, timeoutMs = 15000) => {
  return new Promise((resolve) => {
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.warn("⚠️ FFmpeg exit timeout, force killing...");
      try {
        ffmpegProcess.kill("SIGKILL");
      } catch {}
      resolve();
    }, timeoutMs);

    ffmpegProcess.once("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      console.log(`🎬 FFmpeg closed - code=${code}, signal=${signal}`);
      resolve();
    });

    ffmpegProcess.once("error", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve();
    });
  });
};

// =================================================
// SAFE KILL
// =================================================
export const killFFmpegProcess = (ffmpegProcess) => {
  if (!ffmpegProcess || ffmpegProcess.killed) return true;

  try {
    ffmpegProcess.kill("SIGINT");
    setTimeout(() => {
      if (!ffmpegProcess.killed) {
        ffmpegProcess.kill("SIGKILL");
      }
    }, 3000);
    return true;
  } catch {
    return false;
  }
};
