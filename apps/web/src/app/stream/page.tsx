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
  // const localStream = useRef<MediaStream | null>(null)
  const [remoteProducers, setRemoteProducers] = useState<any[]>([]); // [{ producerId, socketId }]

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
      await connectSendTransport(transport)
    };

    socket.emit("getRtpCapabilities", (data: any) => {
      init(data.rtpCapabilities);
    });

    socket.on("newProducer", ({ producerId, socketId }) => {
      setRemoteProducers((prev) => [...prev, { producerId, socketId }]);
    });
    socket.on("connectionSuccess", ({ producers }) => {
      console.log({producers })
      setRemoteProducers(producers)
      // console.log({ producers });
    });
  }, []);

  const createSendTransport = (device) => {
    return new Promise((resolve) => {
      socket.emit(
        "createWebRtcTransport",
        { sender: true },
        ({ params: serverParams }: any) => {
          if (serverParams.error) {
            console.log(serverParams.error);
            return;
          }

          console.log(serverParams);
          const producerTransport = device.createSendTransport(serverParams);

          producerTransport.on(
            "connect",
            async ({ dtlsParameters }, callback, errback) => {
              try {
                await socket.emit("transportConnect", { dtlsParameters });
                callback();
              } catch (error: any) {
                errback(error);
              }
            }
          );

          producerTransport.on(
            "produce",
            async (parameters, callback, errback) => {
              try {
                await socket.emit(
                  "transportProduce",
                  {
                    kind: parameters.kind,
                    rtpParameters: parameters.rtpParameters,
                    appData: parameters.appData,
                  },
                  ({ id }: any) => {
                    callback({ id });
                  }
                );
              } catch (error: any) {
                errback(error);
              }
            }
          );
          resolve(producerTransport)
        }
      );
    });
  };

  const connectSendTransport = async (producerTransport) => {
    const producer = await producerTransport.produce(params);

    producer.on("trackended", () => {
      console.log("track ended");
    });

    producer.on("transportclose", () => {
      console.log("transport ended");
    });
  };

  return (
    <div className="grid grid-cols-3 gap-4 p-4">
      {localStream && <StreamOutput stream={localStream} isLocal />}
      {remoteProducers.length && deviceRef.current && remoteProducers.map(({ producerId }) => (
        <RemoteStream
          key={producerId}
          socket={socket}
          device={deviceRef.current!}
          producerId={producerId}
        />
      ))}
    </div>
  );
};

export default MediasoupClientComponent;
