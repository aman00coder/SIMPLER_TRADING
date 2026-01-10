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
a=recvonly
`;
};

export const saveSDPFile = (filePath, sdp) => {
  fs.writeFileSync(filePath, sdp);
};
