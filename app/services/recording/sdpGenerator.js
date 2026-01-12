import fs from "fs";

export const generateSDP = ({ ip, port, kind, rtpParameters }) => {
  const codec = rtpParameters.codecs[0];
  const pt = codec.payloadType;
  const clockRate = codec.clockRate;
  const codecName = codec.mimeType.split("/")[1];
  const ssrc = rtpParameters.encodings[0].ssrc;

  return `v=0
o=- 0 0 IN IP4 ${ip}
s=Mediasoup Record
c=IN IP4 ${ip}
t=0 0
m=${kind} ${port} RTP/AVP ${pt}
a=rtpmap:${pt} ${codecName}/${clockRate}
a=ssrc:${ssrc} cname:mediasoup
a=sendrecv
`;
};

export const saveSDPFile = (filePath, sdp) => {
  fs.writeFileSync(filePath, sdp);
};
