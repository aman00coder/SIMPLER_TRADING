import fs from "fs";

/**
 * ✅ Generate FFmpeg compatible SDP from mediasoup RTP params
 */
export const generateSDP = ({ ip, port, kind, rtpParameters }) => {
  const codec = rtpParameters.codecs[0];
  const payloadType = codec.payloadType;
  const clockRate = codec.clockRate;
  const codecName = codec.mimeType.split("/")[1];
  const ssrc = rtpParameters.encodings[0].ssrc;

  let sdp = `v=0
o=- 0 0 IN IP4 ${ip}
s=Mediasoup Record
c=IN IP4 ${ip}
t=0 0
m=${kind} ${port} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${codecName}/${clockRate}
a=ssrc:${ssrc} cname:mediasoup
a=recvonly
`;

  // 🔥 CRITICAL FOR VP8 (SIZE FIX)
  if (codecName.toLowerCase() === "vp8") {
    sdp += `
a=fmtp:${payloadType} max-fs=12288;max-fr=60
a=framesize:${payloadType} 1280-720
`;
  }

  return sdp;
};

export const saveSDPFile = (filePath, sdp) => {
  fs.writeFileSync(filePath, sdp);
};
