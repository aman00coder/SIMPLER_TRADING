import fs from "fs";

/**
 * ✅ Generate SDP dynamically from mediasoup RTP parameters
 */
export const generateSDP = ({ ip, port, kind, rtpParameters }) => {
  const codec = rtpParameters.codecs[0];
  const payloadType = codec.payloadType;
  const clockRate = codec.clockRate;
  const codecName = codec.mimeType.split("/")[1];
  const ssrc = rtpParameters.encodings[0].ssrc;

  return `v=0
o=- 0 0 IN IP4 ${ip}
s=Mediasoup Record
c=IN IP4 ${ip}
t=0 0
m=${kind} ${port} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${codecName}/${clockRate}
a=ssrc:${ssrc} cname:mediasoup
a=recvonly
`;
};

/**
 * ✅ Save SDP file
 */
export const saveSDPFile = (filePath, sdp) => {
  fs.writeFileSync(filePath, sdp);
};
