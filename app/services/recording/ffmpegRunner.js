//ff
import { spawn } from "child_process";

export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {
  const args = [
    "-y",

    // ================= LOGGING =================
    "-loglevel", "warning",
    "-stats",

    // ================= RTP / LOW LATENCY FIXES =================
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-max_delay", "500000",          // 0.5 sec
    "-rw_timeout", "5000000",        // 5 sec read/write timeout
    "-use_wallclock_as_timestamps", "1",

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
      `${audioSdps.map((_, i) => `[${i + 1}:a]`).join("")}amix=inputs=${audioSdps.length}:dropout_transition=0[a]`,
      "-map", "0:v",
      "-map", "[a]"
    );
  } else {
    args.push("-map", "0:v");
  }

  // ================= OUTPUT SETTINGS =================
  args.push(
    // Video
    "-c:v", "copy",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-profile:v", "main",
    "-r", "30",
    "-g", "60",
    "-crf", "23",

    // Audio
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",

    // MP4 flags
    "-movflags", "+faststart+empty_moov",
    "-f", "mp4",

    output
  );

  console.log("🎬 FFmpeg command:\nffmpeg", args.join(" "));

  const ffmpeg = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  // ================= LOGS =================
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
// WAIT FOR EXIT (GRACEFUL)
// =================================================
export const waitForFFmpegExit = (ffmpegProcess, timeoutMs = 10000) => {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn("⚠️ FFmpeg exit timeout, force killing...");
      ffmpegProcess.kill("SIGKILL");
      resolve(); // ✅ IMPORTANT: do NOT reject (file still usable)
    }, timeoutMs);

    ffmpegProcess.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      console.log(`🎬 FFmpeg closed - Code: ${code}, Signal: ${signal}`);
      resolve();
    });

    ffmpegProcess.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
};

// =================================================
// SAFE KILL (USED BY CONTROLLER)
// =================================================
export const killFFmpegProcess = (ffmpegProcess) => {
  if (!ffmpegProcess || ffmpegProcess.killed) return true;

  try {
    console.log("🛑 Sending SIGINT to FFmpeg...");
    ffmpegProcess.kill("SIGINT");

    setTimeout(() => {
      if (!ffmpegProcess.killed) {
        console.warn("🔄 Force killing FFmpeg (SIGKILL)...");
        ffmpegProcess.kill("SIGKILL");
      }
    }, 3000);

    return true;
  } catch (err) {
    console.error("❌ Error killing FFmpeg process:", err.message);
    return false;
  }
};
