import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";

const PORT = 3001;
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  path: "/ws",
});

app.get("/", (req, res) => {
  res.send("Hello from mediasoup app!");
});

let worker: any;
let router: any;
let producerTransport: any;
let consumerTransport: any;
let producer: any;
let consumer: any;

let producers: any = [];
const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

(async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", () => {
    // This implies something serious happened, so kill the application
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
  });

  router = await worker.createRouter({ mediaCodecs });
})();

io.on("connection", async (socket) => {
  console.log(`New WebSocket connection: ${socket.id}`);

  socket.emit("connectionSuccess", {
    producers,
  });

  socket.on("disconnect", () => {
    producers = producers.filter((p: any) => p.socketId !== socket.id)
    console.log(`Disconnect: ${socket.id}`);
  });

  socket.on("getRtpCapabilities", (callback) => {
    const rtpCapabilities = router.rtpCapabilities;
    callback({ rtpCapabilities });
  });

  socket.on("createWebRtcTransport", async ({ sender }, callback) => {
    console.log(`Is this a sender request? ${sender}`);
    if (sender) producerTransport = await createWebRtcTransport(callback);
    else consumerTransport = await createWebRtcTransport(callback);
  });

  socket.on("transportConnect", async ({ dtlsParameters }) => {
    console.log("transportConnect")
    await producerTransport.connect({ dtlsParameters });
  });

  socket.on("transportProduce", async ({ kind, rtpParameters, appData }, callback) => {
    console.log("transportProduce")
    producer = await producerTransport.produce({
      kind,
      rtpParameters,
    });

    console.log("Producer ID: ", producer.id, producer.kind);

    producer.on("transportclose", () => {
      console.log("transport for this producer closed ");
      producer.close();
    });

    producers.push({
      producerId: producer.id,
      socketId: socket.id,
    });

    callback({
      id: producer.id,
    });
  });

  socket.on("transportRecvConnect", async ({ dtlsParameters }) => {
    await consumerTransport.connect({ dtlsParameters });
  });

  socket.on("consume", async ({ rtpCapabilities }, callback) => {
    try {
      if (
        router.canConsume({
          producerId: producer.id,
          rtpCapabilities,
        })
      ) {
        // transport can now consume and return a consumer
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        });

        consumer.on("transportclose", () => {
          console.log("transport close from consumer");
        });

        consumer.on("producerclose", () => {
          console.log("producer of consumer closed");
        });

        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };

        callback({ params });
      }
    } catch (error: any) {
      console.log(error.message);
      callback({
        params: {
          error: error,
        },
      });
    }
  });

  socket.on("consumerResume", async () => {
    console.log("consumer resume");
    await consumer.resume();
  });
});

const createWebRtcTransport = async (callback: any) => {
  try {
    const webRtcTransport_options = {
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: "127.0.0.1",
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

    transport.on("close", () => {
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
    console.log(error);
    callback({
      params: {
        error: error,
      },
    });
  }
};

server.listen(PORT, () => {
  console.log(`🚀  Server listening on http://localhost:${PORT}`);
});
