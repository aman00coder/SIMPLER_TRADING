import { spawn } from "child_process";

// =================================================
// START FFMPEG (VIDEO + N AUDIO MIX)
// =================================================
export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {
  const args = [
    "-y",

    // ---------- LOGGING ----------
    "-loglevel", "warning",
    "-stats",

    // ---------- RTP STABILITY ----------
    "-fflags", "+genpts+igndts",
    "-flags", "low_delay",
    "-use_wallclock_as_timestamps", "1",
    "-reorder_queue_size", "5000",
    "-rtbufsize", "300M",
    "-max_delay", "10000000",
    "-rw_timeout", "10000000",
    "-analyzeduration", "15000000",
    "-probesize", "15000000",

    // ---------- VIDEO INPUT (index 0) ----------
    "-protocol_whitelist", "file,udp,rtp,pipe",
    "-i", videoSdp
  ];

  // ---------- AUDIO INPUTS (index 1..N) ----------
  audioSdps.forEach((sdp) => {
    args.push(
      "-protocol_whitelist", "file,udp,rtp,pipe",
      "-i", sdp
    );
  });

  // =================================================
  // FILTER COMPLEX (VIDEO + DYNAMIC AUDIO MIX)
  // =================================================
  const audioCount = audioSdps.length;

  let filterComplex = "";

  // 🎥 VIDEO FILTER (ALWAYS)
  filterComplex +=
    "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,fps=25[v];";

  // 🎤 AUDIO FILTER (DYNAMIC)
  if (audioCount === 1) {
    // single audio → no amix
    filterComplex +=
      "[1:a]aresample=async=1:first_pts=0[a]";
  } else if (audioCount > 1) {
    // multiple audio → amix
    const audioInputs = audioSdps
      .map((_, i) => `[${i + 1}:a]`)
      .join("");

    filterComplex +=
      `${audioInputs}amix=inputs=${audioCount}:dropout_transition=2,` +
      `aresample=async=1:first_pts=0[a]`;
  } else {
    throw new Error("No audio inputs provided");
  }

  args.push(
    "-filter_complex", filterComplex,
    "-map", "[v]",
    "-map", "[a]"
  );

  // =================================================
  // OUTPUT SETTINGS
  // =================================================
  args.push(
    "-fps_mode", "vfr",

    // Video
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-profile:v", "main",
    "-g", "50",
    "-maxrate", "2500k",
    "-bufsize", "5000k",
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
    if (line) console.log("🎥 FFmpeg:", line);
  });

  ffmpeg.on("error", (err) => {
    console.error("❌ FFmpeg process error:", err.message);
  });

  return ffmpeg;
};

// =================================================
// WAIT FOR FFMPEG EXIT (FIXES YOUR IMPORT ERROR)
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
// SAFE KILL (OPTIONAL)
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
