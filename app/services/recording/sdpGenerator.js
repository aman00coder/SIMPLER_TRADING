import fs from "fs";

export const generateSDP = ({ ip, port, payloadType, codec, kind }) => {
  return `
v=0
o=- 0 0 IN IP4 ${ip}
s=Mediasoup Record
c=IN IP4 ${ip}
t=0 0
m=${kind} ${port} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${codec}
a=fmtp:${payloadType} max-fs=12288;max-fr=60
a=framesize:${payloadType} 1280-720
a=recvonly
`;
};

// ✅ MISSING EXPORT (THIS FIXES CRASH)
export const saveSDPFile = (filePath, sdp) => {
  fs.writeFileSync(filePath, sdp);
};
