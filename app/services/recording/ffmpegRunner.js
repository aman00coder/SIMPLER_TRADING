import { spawn } from "child_process";

export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {
  const args = [
    "-y",
    "-loglevel", "warning",
    "-stats",

    // RTP stability
    "-fflags", "+genpts+igndts",
    "-flags", "low_delay",
    "-use_wallclock_as_timestamps", "1",
    "-reorder_queue_size", "5000",
    "-rtbufsize", "300M",
    "-max_delay", "10000000",
    "-rw_timeout", "10000000",
    "-analyzeduration", "15000000",
    "-probesize", "15000000",

    // Video SDP (index 0)
    "-protocol_whitelist", "file,udp,rtp,pipe",
    "-i", videoSdp
  ];

  // Audio SDPs (index 1,2,3...)
  audioSdps.forEach((sdp) => {
    args.push(
      "-protocol_whitelist", "file,udp,rtp,pipe",
      "-i", sdp
    );
  });

  // ================= FILTER COMPLEX (DYNAMIC) =================
  const audioInputCount = audioSdps.length;

  let filterComplex = "";

  // 🎥 VIDEO FILTER (always)
  filterComplex +=
    "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,fps=25[v];";

  // 🎤 AUDIO FILTER (dynamic)
  if (audioInputCount === 1) {
    filterComplex +=
      "[1:a]aresample=async=1:first_pts=0[a]";
  } else if (audioInputCount > 1) {
    const audioInputs = audioSdps
      .map((_, i) => `[${i + 1}:a]`)
      .join("");

    filterComplex +=
      `${audioInputs}amix=inputs=${audioInputCount}:dropout_transition=2,aresample=async=1:first_pts=0[a]`;
  }

  args.push(
    "-filter_complex", filterComplex,
    "-map", "[v]",
    "-map", "[a]"
  );

  // ================= OUTPUT =================
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

  return ffmpeg;
};
