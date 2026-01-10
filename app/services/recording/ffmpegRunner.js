import { spawn } from "child_process";

export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {

  const args = [
    "-y",

    "-loglevel", "warning",
    "-stats",

    "-fflags", "+genpts",
    "-use_wallclock_as_timestamps", "1",

    "-analyzeduration", "20000000",
    "-probesize", "20000000",

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
      `${audioSdps.map((_, i) => `[${i + 1}:a]`).join("")}amix=inputs=${audioSdps.length}:dropout_transition=0[a]`,
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
    "-profile:v", "baseline",
    "-r", "30",

    "-c:a", "aac",
    "-b:a", "128k",

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
