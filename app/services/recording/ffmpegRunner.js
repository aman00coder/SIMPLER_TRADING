import { spawn } from "child_process";

// =================================================
// START FFMPEG (FINAL PRODUCTION SAFE)
// =================================================
export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {
  const args = [
    "-y",

    // ---------- LOGGING ----------
    "-loglevel", "warning",
    "-stats",

    // ---------- LIVE / RTP SAFE ----------
    "-fflags", "+genpts+discardcorrupt+nobuffer",
    "-flags", "low_delay",
    "-use_wallclock_as_timestamps", "1",
    "-thread_queue_size", "4096",
    "-rtbufsize", "300M",
    "-max_delay", "5000000",
    "-analyzeduration", "10000000",
    "-probesize", "10000000",

    // ---------- VIDEO INPUT ----------
    "-protocol_whitelist", "file,udp,rtp,pipe",
    "-i", videoSdp
  ];

  // ---------- AUDIO INPUTS ----------
  audioSdps.forEach((sdp) => {
    args.push(
      "-thread_queue_size", "4096",
      "-protocol_whitelist", "file,udp,rtp,pipe",
      "-i", sdp
    );
  });

  // =================================================
  // FILTER COMPLEX (TIMESTAMP SAFE)
  // =================================================
  const audioCount = audioSdps.length;
  let filterComplex = "";

  // VIDEO
  filterComplex +=
    "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease," +
    "fps=25,setpts=N/25/TB[v];";

  // AUDIO
  if (audioCount === 1) {
    filterComplex +=
      "[1:a]asetpts=N/SR/TB," +
      "aresample=async=1000:min_hard_comp=0.1:first_pts=0[a]";
  } else {
    const audioReset = audioSdps
      .map((_, i) => `[${i + 1}:a]asetpts=N/SR/TB`)
      .join(";");

    const audioInputs = audioSdps
      .map((_, i) => `[${i + 1}:a]`)
      .join("");

    filterComplex +=
      `${audioReset};` +
      `${audioInputs}amix=inputs=${audioCount}:dropout_transition=2,` +
      `aresample=async=1000:min_hard_comp=0.1:first_pts=0[a]`;
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
    "-vsync", "1",
    "-r", "25",
    "-fps_mode", "cfr",

    // Video
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-profile:v", "main",
    "-g", "50",
    "-x264opts", "keyint=50:min-keyint=25:no-scenecut",
    "-crf", "23",
    "-maxrate", "2500k",
    "-bufsize", "5000k",

    // Audio
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",

    // MP4 SAFE
    "-movflags", "+faststart+frag_keyframe+empty_moov",
    "-avoid_negative_ts", "make_zero",

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

  return ffmpeg;
};

export const waitForFFmpegExit = (ffmpegProcess, timeoutMs = 20000) => {
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
