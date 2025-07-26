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

// Store transports and producers per socket
const transports = new Map(); // socketId -> { producerTransport, consumerTransport }
const producers = new Map(); // socketId -> [{ id, kind }]
const consumers = new Map(); // socketId -> [{ id, producerId }]

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
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000);
  });

  router = await worker.createRouter({ mediaCodecs });
})();

io.on("connection", async (socket) => {
  console.log(`New WebSocket connection: ${socket.id}`);

  // Initialize storage for this socket
  transports.set(socket.id, {});
  producers.set(socket.id, []);
  consumers.set(socket.id, []);

  // Send existing producers to new client
  const existingProducers: any[] = [];
  producers.forEach((producerList, socketId) => {
    if (socketId !== socket.id) {
      producerList.forEach((producer: any) => {
        existingProducers.push({
          producerId: producer.id,
          socketId: socketId,
        });
      });
    }
  });

  socket.emit("connectionSuccess", {
    producers: existingProducers,
  });

  socket.on("disconnect", () => {
    console.log(`Disconnect: ${socket.id}`);
    
    // Clean up transports
    const socketTransports = transports.get(socket.id);
    if (socketTransports) {
      if (socketTransports.producerTransport) {
        socketTransports.producerTransport.close();
      }
      if (socketTransports.consumerTransport) {
        socketTransports.consumerTransport.close();
      }
    }
    
    // Clean up producers
    const socketProducers = producers.get(socket.id);
    if (socketProducers) {
      socketProducers.forEach((producer: any) => {
        producer.close();
      });
    }
    
    // Clean up consumers
    const socketConsumers = consumers.get(socket.id);
    if (socketConsumers) {
      socketConsumers.forEach((consumer: any) => {
        consumer.close();
      });
    }
    
    // Remove from maps
    transports.delete(socket.id);
    producers.delete(socket.id);
    consumers.delete(socket.id);

    // Notify other clients about producer removal
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
      const socketTransports = transports.get(socket.id) || {};
      
      if (sender) {
        socketTransports.producerTransport = transport;
      } else {
        socketTransports.consumerTransport = transport;
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
    } catch (error) {
      console.error("Error connecting producer transport:", error);
    }
  });

  socket.on("transportProduce", async ({ kind, rtpParameters, appData }, callback) => {
    console.log("transportProduce for socket:", socket.id);
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
        
        // Remove from producers map
        const socketProducers = producers.get(socket.id) || [];
        const filteredProducers = socketProducers.filter((p: any) => p.id !== producer.id);
        producers.set(socket.id, filteredProducers);
      });

      // Add to producers map
      const socketProducers = producers.get(socket.id) || [];
      socketProducers.push(producer);
      producers.set(socket.id, socketProducers);

      // Notify other clients about new producer
      socket.broadcast.emit("newProducer", {
        producerId: producer.id,
        socketId: socket.id,
      });

      callback({
        id: producer.id,
      });
    } catch (error: any) {
      console.error("Error in transportProduce:", error);
      callback({
        error: error.message,
      });
    }
  });

  socket.on("transportRecvConnect", async ({ dtlsParameters }) => {
    console.log("transportRecvConnect for socket:", socket.id);
    try {
      const socketTransports = transports.get(socket.id);
      if (socketTransports && socketTransports.consumerTransport) {
        await socketTransports.consumerTransport.connect({ dtlsParameters });
      }
    } catch (error) {
      console.error("Error connecting consumer transport:", error);
    }
  });

  socket.on("consume", async ({ rtpCapabilities, producerId }, callback) => {
    console.log("consume request for producerId:", producerId, "from socket:", socket.id);
    try {
      // Find the producer
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
        if (!socketTransports || !socketTransports.consumerTransport) {
          throw new Error("Consumer transport not found");
        }

        const consumer = await socketTransports.consumerTransport.consume({
          producerId: targetProducer.id,
          rtpCapabilities,
          paused: true,
        });

        consumer.on("transportclose", () => {
          console.log("transport close from consumer");
        });

        consumer.on("producerclose", () => {
          console.log("producer of consumer closed");
          // Remove from consumers map
          const socketConsumers = consumers.get(socket.id) || [];
          const filteredConsumers = socketConsumers.filter((c: any) => c.id !== consumer.id);
          consumers.set(socket.id, filteredConsumers);
        });

        // Add to consumers map
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
  });

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