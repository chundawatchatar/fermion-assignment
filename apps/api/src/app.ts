import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import path from "path";
import cors from "cors";

import { startFFmpeg, stopFFmpeg } from "./ffmpeg";

const PORT = 3001;
const ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP || "127.0.0.1";
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  path: "/ws",
});

app.use(cors());
app.use(express.json());

app.use("/hls", express.static(path.join(__dirname, "..", "public", "hls")));

app.get("/", (req, res) => {
  res.send("Hello from mediasoup app!");
});

let worker: mediasoup.types.Worker;
let router: mediasoup.types.Router;

// Store transports and producers per socket
type SocketTransports = {
  producerTransport?: any;
  consumerTransports: Map<string, any>;
};
type TransportMap = Map<string, SocketTransports>;
type ProducerMap = Map<string, any[]>;
type ConsumerMap = Map<string, any[]>;

const transports: TransportMap = new Map();
const producers: ProducerMap = new Map();
const consumers: ConsumerMap = new Map();

const hasVideoProducers = (): boolean => {
  for (const producerList of producers.values()) {
    if (
      producerList.some(
        (producer: any) => producer.kind === "video" && !producer.closed,
      )
    ) {
      return true;
    }
  }

  return false;
};

const refreshFFmpegMix = (): void => {
  if (hasVideoProducers()) {
    startFFmpeg(router, producers).catch((error) => {
      console.error("Failed to refresh FFmpeg mix:", error);
    });
    return;
  }

  stopFFmpeg().catch((error) => {
    console.error("Failed to stop FFmpeg mix:", error);
  });
};

const closeConsumerTransport = (
  socketId: string,
  transportId: string,
): void => {
  const socketTransports = transports.get(socketId);
  const transport = socketTransports?.consumerTransports.get(transportId);

  if (!transport) {
    return;
  }

  transport.close();
  socketTransports?.consumerTransports.delete(transportId);

  const socketConsumers = consumers.get(socketId) || [];
  const remainingConsumers = socketConsumers.filter((consumer: any) => {
    if (consumer.appData?.transportId === transportId) {
      if (!consumer.closed) {
        consumer.close();
      }
      return false;
    }

    return true;
  });

  consumers.set(socketId, remainingConsumers);
};

const mediaCodecs: mediasoup.types.RtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    preferredPayloadType: 100,
    clockRate: 48000,
    channels: 2,
    parameters: {
      useinbandfec: 1,
      usedtx: 1,
    },
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    preferredPayloadType: 101,
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1500,
      "x-google-max-bitrate": 3000,
      "x-google-min-bitrate": 500,
    },
  },
];

(async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", () => {
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000);
  });

  router = await worker.createRouter({ mediaCodecs });
})();

io.on("connection", async (socket) => {
  console.log(`New WebSocket connection: ${socket.id}`);

  transports.set(socket.id, { consumerTransports: new Map() });
  producers.set(socket.id, []);
  consumers.set(socket.id, []);

  socket.on("disconnect", () => {
    console.log(`Disconnect: ${socket.id}`);

    const socketTransports = transports.get(socket.id);
    if (socketTransports) {
      if (socketTransports.producerTransport) {
        socketTransports.producerTransport.close();
      }
      socketTransports.consumerTransports.forEach((transport) => {
        transport.close();
      });
    }

    const socketProducers = producers.get(socket.id);
    if (socketProducers) {
      socketProducers.forEach((producer: any) => {
        producer.close();
      });
    }

    const socketConsumers = consumers.get(socket.id);
    if (socketConsumers) {
      socketConsumers.forEach((consumer: any) => {
        consumer.close();
      });
    }

    transports.delete(socket.id);
    producers.delete(socket.id);
    consumers.delete(socket.id);

    refreshFFmpegMix();

    socket.broadcast.emit("producerClosed", { socketId: socket.id });
  });

  socket.on("getRtpCapabilities", (callback) => {
    const rtpCapabilities = router.rtpCapabilities;
    callback({ rtpCapabilities });
  });

  socket.on("createWebRtcTransport", async ({ sender }, callback) => {
    console.log(`Is this a sender request? ${sender} for socket ${socket.id}`);
    try {
      const transport = await createWebRtcTransport(callback);
      const socketTransports: SocketTransports = transports.get(socket.id) || {
        consumerTransports: new Map(),
      };

      if (sender) {
        socketTransports.producerTransport = transport;
      } else {
        socketTransports.consumerTransports.set(transport.id, transport);
        transport.on("@close", () => {
          socketTransports.consumerTransports.delete(transport.id);
        });
      }

      transports.set(socket.id, socketTransports);
    } catch (error) {
      console.error("Error creating WebRTC transport:", error);
      callback({
        params: {
          error: error,
        },
      });
    }
  });

  socket.on("transportConnect", async ({ dtlsParameters }) => {
    console.log("transportConnect for socket:", socket.id);
    try {
      const socketTransports = transports.get(socket.id);
      if (socketTransports && socketTransports.producerTransport) {
        await socketTransports.producerTransport.connect({ dtlsParameters });
      }

      const existingProducers: { socketId: string; producers: any }[] = [];

      producers.forEach((producerList, socketId) => {
        if (socketId !== socket.id && producerList.length >= 2) {
          const minimalProducers = producerList.map((p: any) => ({
            id: p.id,
            kind: p.kind,
          }));
          existingProducers.push({ socketId, producers: minimalProducers });
        }
      });

      socket.emit("onRoomJoined", existingProducers);
    } catch (error) {
      console.error("Error connecting producer transport:", error);
    }
  });

  socket.on(
    "transportProduce",
    async ({ kind, rtpParameters, appData }, callback) => {
      console.log("transportProduce for socket:", socket.id, "kind:", kind);
      try {
        const socketTransports = transports.get(socket.id);
        if (!socketTransports || !socketTransports.producerTransport) {
          throw new Error("Producer transport not found");
        }

        const producer = await socketTransports.producerTransport.produce({
          kind,
          rtpParameters,
        });

        console.log("Producer ID: ", producer.id, producer.kind);

        producer.on("transportclose", () => {
          console.log("transport for this producer closed");
          producer.close();

          const socketProducers = producers.get(socket.id) || [];
          const filteredProducers = socketProducers.filter(
            (p: any) => p.id !== producer.id,
          );
          producers.set(socket.id, filteredProducers);

          if (producer.kind === "video") {
            refreshFFmpegMix();
          }
        });

        const socketProducers = producers.get(socket.id) || [];
        socketProducers.push(producer);
        producers.set(socket.id, socketProducers);

        if (producer.kind === "video") {
          refreshFFmpegMix();
        }

        if (socketProducers.length >= 2) {
          const minimalProducers = socketProducers.map((p: any) => ({
            id: p.id,
            kind: p.kind,
          }));

          socket.broadcast.emit("newProducer", {
            producers: minimalProducers,
            socketId: socket.id,
          });
        }

        callback({
          id: producer.id,
        });
      } catch (error: any) {
        console.error("Error in transportProduce:", error);
        callback({
          error: error.message,
        });
      }
    },
  );

  socket.on("transportRecvConnect", async ({ transportId, dtlsParameters }) => {
    console.log(
      "transportRecvConnect for socket:",
      socket.id,
      "transport:",
      transportId,
    );
    try {
      const socketTransports = transports.get(socket.id);
      const consumerTransport =
        socketTransports?.consumerTransports.get(transportId);

      if (!consumerTransport) {
        throw new Error("Consumer transport not found");
      }

      await consumerTransport.connect({ dtlsParameters });
    } catch (error) {
      console.error("Error connecting consumer transport:", error);
    }
  });

  socket.on(
    "consume",
    async ({ rtpCapabilities, producerId, transportId }, callback) => {
      console.log(
        "consume request for producerId:",
        producerId,
        "from socket:",
        socket.id,
      );
      try {
        let targetProducer: any = null;
        for (const [socketId, producerList] of producers.entries()) {
          const producer = producerList.find((p: any) => p.id === producerId);
          if (producer) {
            targetProducer = producer;
            break;
          }
        }

        if (!targetProducer) {
          throw new Error("Producer not found");
        }

        if (
          router.canConsume({
            producerId: targetProducer.id,
            rtpCapabilities,
          })
        ) {
          const socketTransports = transports.get(socket.id);
          const consumerTransport =
            socketTransports?.consumerTransports.get(transportId);

          if (!consumerTransport) {
            throw new Error("Consumer transport not found");
          }

          const consumer = await consumerTransport.consume({
            producerId: targetProducer.id,
            rtpCapabilities,
            paused: true,
            appData: {
              transportId,
            },
          });

          consumer.on("transportclose", () => {
            console.log("transport close from consumer");
          });

          consumer.on("producerclose", () => {
            console.log("producer of consumer closed");
            const socketConsumers = consumers.get(socket.id) || [];
            const filteredConsumers = socketConsumers.filter(
              (c: any) => c.id !== consumer.id,
            );
            consumers.set(socket.id, filteredConsumers);
          });

          const socketConsumers = consumers.get(socket.id) || [];
          socketConsumers.push(consumer);
          consumers.set(socket.id, socketConsumers);

          const params = {
            id: consumer.id,
            producerId: targetProducer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          };

          callback({ params });
        } else {
          throw new Error("Cannot consume");
        }
      } catch (error: any) {
        console.error("Error in consume:", error);
        callback({
          params: {
            error: error.message,
          },
        });
      }
    },
  );

  socket.on("consumerResume", async ({ consumerId }) => {
    console.log("consumer resume for consumer:", consumerId);
    try {
      const socketConsumers = consumers.get(socket.id) || [];
      const consumer = socketConsumers.find((c: any) => c.id === consumerId);

      if (consumer) {
        await consumer.resume();
      } else {
        console.error("Consumer not found for resume");
      }
    } catch (error) {
      console.error("Error resuming consumer:", error);
    }
  });

  socket.on("closeConsumerTransport", ({ transportId }) => {
    closeConsumerTransport(socket.id, transportId);
  });
});

const createWebRtcTransport = async (
  callback: (params: any) => void,
): Promise<any> => {
  try {
    const webRtcTransport_options = {
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: ANNOUNCED_IP,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    };

    let transport = await router.createWebRtcTransport(webRtcTransport_options);
    console.log(`transport id: ${transport.id}`);

    transport.on("dtlsstatechange", (dtlsState: any) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("@close", () => {
      console.log("transport closed");
    });

    callback({
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    });

    return transport;
  } catch (error: any) {
    console.error("Error creating WebRTC transport:", error);
    callback({
      params: {
        error: error,
      },
    });
    throw error;
  }
};

server.listen(PORT, () => {
  console.log(`🚀  Server listening on http://localhost:${PORT}`);
});
