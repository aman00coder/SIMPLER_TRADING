import { spawn } from "child_process";

// =================================================
// START FFMPEG (REAL PRODUCTION SAFE – RECORDING)
// =================================================
export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {
  const args = [
    "-y",

    // LOGGING
    "-loglevel", "warning",
    "-stats",

    // RECORDING SAFE FLAGS (NO LOW LATENCY)
    "-fflags", "+genpts+discardcorrupt",
    "-use_wallclock_as_timestamps", "1",
    "-thread_queue_size", "8192",
    "-rtbufsize", "500M",
    "-max_delay", "15000000",
    "-analyzeduration", "30000000",
    "-probesize", "30000000",

    // VIDEO INPUT
    "-protocol_whitelist", "file,udp,rtp,pipe",
    "-i", videoSdp
  ];

  // AUDIO INPUTS
  audioSdps.forEach((sdp) => {
    args.push(
      "-thread_queue_size", "8192",
      "-protocol_whitelist", "file,udp,rtp,pipe",
      "-i", sdp
    );
  });

  // ================= FILTER COMPLEX =================
  let filterComplex =
    "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease," +
    "fps=25,setpts=N/25/TB[v];" +
    "[1:a]asetpts=N/SR/TB," +
    "aresample=async=1000:first_pts=0[a]";

  args.push(
    "-filter_complex", filterComplex,
    "-map", "[v]",
    "-map", "[a]"
  );

  // ================= OUTPUT =================
  args.push(
    // CFR ONLY (NO VSYNC)
    "-r", "25",
    "-fps_mode", "cfr",

    // VIDEO
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-profile:v", "main",
    "-g", "50",
    "-x264opts", "keyint=50:min-keyint=25:no-scenecut",
    "-crf", "23",
    "-maxrate", "2500k",
    "-bufsize", "5000k",

    // AUDIO
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",

    // MP4 SAFETY
    "-movflags", "+faststart+frag_keyframe+empty_moov",
    "-avoid_negative_ts", "make_zero",

    "-f", "mp4",
    output
  );

  console.log("🎬 FFmpeg command:\nffmpeg", args.join(" "));

  return spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
};

// =================================================
// WAIT FOR FFMPEG EXIT
// =================================================
export const waitForFFmpegExit = (ffmpegProcess, timeoutMs = 20000) => {
  return new Promise((resolve) => {
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.warn("⚠️ FFmpeg timeout, force killing...");
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
  });
};
