import { spawn } from "child_process";

export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {

  const args = [
    "-y", // Overwrite output file

    // Logging
    "-loglevel", "warning",
    "-stats",

    // Input optimizations
    "-fflags", "+genpts",
    "-use_wallclock_as_timestamps", "1",
    "-analyzeduration", "20000000",
    "-probesize", "20000000",

    // Video input
    "-protocol_whitelist", "file,udp,rtp,pipe",
    "-i", videoSdp
  ];

  // Audio inputs
  audioSdps.forEach(sdp => {
    args.push(
      "-protocol_whitelist", "file,udp,rtp,pipe",
      "-i", sdp
    );
  });

  // Complex filter for audio mixing
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

  // Output settings (optimized for S3 upload)
  args.push(
    // Video codec
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-profile:v", "main",
    "-r", "30",
    "-g", "60", // Keyframe interval for streaming
    "-crf", "23", // Quality balance

    // Audio codec
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",

    // MP4 optimizations
    "-movflags", "+faststart+empty_moov", // Important for streaming
    "-f", "mp4",
    
    // Output file
    output
  );

  console.log("🎬 FFmpeg command:", "ffmpeg", args.join(" "));

  const ffmpeg = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"] // Capture both stdout and stderr
  });

  // Log FFmpeg output
  ffmpeg.stdout.on('data', (data) => {
    console.log('🎥 FFmpeg stdout:', data.toString().trim());
  });

  ffmpeg.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line && !line.includes("frame=")) { // Filter stats spam
      console.log('🎥 FFmpeg:', line);
    }
  });

  return ffmpeg;
};

// 🔥 MUST EXPORT THIS
export const waitForFFmpegExit = (ffmpegProcess) => {
  return new Promise((resolve, reject) => {
    let settled = false;

    ffmpegProcess.once("close", (code, signal) => {
      if (settled) return;
      settled = true;

      console.log(`🎬 FFmpeg closed - Code: ${code}, Signal: ${signal}`);
      
      if (code === 0 || signal === "SIGINT") {
        resolve();
      } else {
        reject(
          new Error(`FFmpeg exited abnormally: code=${code}, signal=${signal}`)
        );
      }
    });

    ffmpegProcess.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
};