import { spawn } from "child_process";

export const startFFmpeg = ({ videoSdp, audioSdps, output }) => {
  const args = [
    "-protocol_whitelist", "file,udp,rtp",
    "-i", videoSdp
  ];

  audioSdps.forEach(sdp => {
    args.push("-i", sdp);
  });

  args.push(
    "-filter_complex", `amix=inputs=${audioSdps.length}`,
    "-map", "0:v",
    "-map", "[a]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-c:a", "aac",
    "-movflags", "+faststart",
    output
  );

  return spawn("ffmpeg", args);
};
