"use client";

import React, { useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import StreamOutput from "@/components/StreamOutput";
import RemoteStream from "@/components/RemoteStream";
import io from "socket.io-client";

const MediasoupClientComponent = () => {
  const socket = useRef(
    io("http://localhost:3001", {
      path: "/ws",
      transports: ["websocket"],
    })
  ).current;
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteProducers, setRemoteProducers] = useState<any[]>([]);

  let params: any = {
    encodings: [
      { rid: "r0", maxBitrate: 100000, scalabilityMode: "S1T3" },
      { rid: "r1", maxBitrate: 300000, scalabilityMode: "S1T3" },
      { rid: "r2", maxBitrate: 900000, scalabilityMode: "S1T3" },
    ],
    codecOptions: {
      videoGoogleStartBitrate: 1000,
    },
  };

  useEffect(() => {
    const init = async (rtpCapabilities: any) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        setLocalStream(stream);

        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        deviceRef.current = device;

        const track = stream.getVideoTracks()[0];
        params = { track, ...params };
        const transport = await createSendTransport(device);
        await connectSendTransport(transport);
      } catch (error) {
        console.error("Error in init:", error);
      }
    };

    socket.emit("getRtpCapabilities", (data: any) => {
      init(data.rtpCapabilities);
    });

    socket.on("newProducer", ({ producerId, socketId }) => {
      console.log("New producer:", producerId, "from socket:", socketId);
      setRemoteProducers((prev) => {
        // Check if producer already exists
        const exists = prev.some(p => p.producerId === producerId);
        if (!exists) {
          return [...prev, { producerId, socketId }];
        }
        return prev;
      });
    });

    socket.on("connectionSuccess", ({ producers }) => {
      console.log("Connection success, existing producers:", producers);
      setRemoteProducers(producers);
    });

    socket.on("producerClosed", ({ socketId }) => {
      console.log("Producer closed for socket:", socketId);
      setRemoteProducers((prev) => 
        prev.filter(p => p.socketId !== socketId)
      );
    });

    // Cleanup on unmount
    return () => {
      socket.disconnect();
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const createSendTransport = (device: mediasoupClient.Device) => {
    return new Promise((resolve, reject) => {
      socket.emit(
        "createWebRtcTransport",
        { sender: true },
        ({ params: serverParams }: any) => {
          if (serverParams.error) {
            console.error("Error creating send transport:", serverParams.error);
            reject(serverParams.error);
            return;
          }

          console.log("Send transport params:", serverParams);
          const producerTransport = device.createSendTransport(serverParams);

          producerTransport.on(
            "connect",
            async ({ dtlsParameters }, callback, errback) => {
              try {
                socket.emit("transportConnect", { dtlsParameters });
                callback();
              } catch (error: any) {
                console.error("Error in transport connect:", error);
                errback(error);
              }
            }
          );

          producerTransport.on(
            "produce",
            (parameters, callback, errback) => {
              try {
                socket.emit(
                  "transportProduce",
                  {
                    kind: parameters.kind,
                    rtpParameters: parameters.rtpParameters,
                    appData: parameters.appData,
                  },
                  ({ id, error }: any) => {
                    if (error) {
                      console.error("Error in transport produce:", error);
                      errback(new Error(error));
                    } else {
                      callback({ id });
                    }
                  }
                );
              } catch (error: any) {
                console.error("Error in produce event:", error);
                errback(error);
              }
            }
          );

          producerTransport.on("connectionstatechange", (state) => {
            console.log("Producer transport connection state:", state);
          });

          resolve(producerTransport);
        }
      );
    });
  };

  const connectSendTransport = async (producerTransport: any) => {
    try {
      const producer = await producerTransport.produce(params);

      producer.on("trackended", () => {
        console.log("track ended");
      });

      producer.on("transportclose", () => {
        console.log("transport ended");
      });

      console.log("Producer created successfully:", producer.id);
    } catch (error) {
      console.error("Error connecting send transport:", error);
    }
  };

  return (
    <div className="grid grid-cols-3 gap-4 p-4">
      {localStream && <StreamOutput stream={localStream} isLocal />}
      {remoteProducers.length > 0 && deviceRef.current && 
        remoteProducers.map(({ producerId, socketId }) => (
          <RemoteStream
            key={`${producerId}-${socketId}`}
            socket={socket}
            device={deviceRef.current!}
            producerId={producerId}
          />
        ))
      }
    </div>
  );
};

export default MediasoupClientComponent;