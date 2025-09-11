import mediasoup from "mediasoup";

export const createMediasoupWorker = async () => {
  try {
    const minPort = parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000;
    const maxPort = parseInt(process.env.MEDIASOUP_MAX_PORT) || 49999;
    const logLevel = process.env.MEDIASOUP_LOG_LEVEL || "warn";

    const worker = await mediasoup.createWorker({
      logLevel,
      rtcMinPort: minPort,
      rtcMaxPort: maxPort,
    });

    console.log(`Mediasoup Worker Created (Ports: ${minPort}-${maxPort}) for ${process.env.NODE_ENV} environment`);

    worker.on("died", () => {
      console.error("Mediasoup worker died, restarting in 2 seconds...");
      setTimeout(() => createMediasoupWorker().catch(console.error), 2000);
    });

    return worker;
  } catch (error) {
    console.error("Failed to create Mediasoup worker:", error);
    throw error;
  }
};