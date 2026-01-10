import { spawn } from "child_process";

export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {

  const args = [
    "-y",
    "-fflags", "+genpts+nobuffer",
    "-flags", "low_delay",
    "-strict", "experimental",
    "-analyzeduration", "30000000",
    "-probesize", "30000000",
    "-max_delay", "500000",
    "-reorder_queue_size", "1024",

    "-protocol_whitelist", "file,udp,rtp,pipe",
    "-i", videoSdp
  ];

  audioSdps.forEach(sdp => {
    args.push(
      "-protocol_whitelist", "file,udp,rtp,pipe",
      "-i", sdp
    );
  });

  if (audioSdps.length > 0) {
    args.push(
      "-filter_complex",
      `${audioSdps.map((_, i) => `[${i + 1}:a]`).join("")}amix=inputs=${audioSdps.length}[a]`,
      "-map", "0:v",
      "-map", "[a]"
    );
  } else {
    args.push("-map", "0:v");
  }

  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-g", "60",
    "-c:a", "aac",
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
