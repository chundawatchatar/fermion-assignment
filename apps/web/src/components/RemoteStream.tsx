"use client";

import React, { useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import StreamOutput from "./StreamOutput";

type Props = {
  socket: any;
  device: mediasoupClient.types.Device;
  producerId: string;
};

const RemoteStream: React.FC<Props> = ({ socket, device, producerId }) => {
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    const consumeRemoteStream = async () => {
      try {
        const transport = await createRecvTransport();
        const consumer = await connectRecvTransport(transport);
        const stream = new MediaStream([consumer.track]);
        setMediaStream(stream);
      } catch (err) {
        console.error("Error setting up remote stream:", err);
      }
    };

    consumeRemoteStream();
  }, []);

  const createRecvTransport = () => {
    return new Promise((resolve, reject) => {
      socket.emit(
        "createWebRtcTransport",
        { sender: false },
        ({ params: serverParams }: any) => {
          if (serverParams.error) {
            console.log(serverParams.error);
            reject(serverParams.error);
          }

          console.log(serverParams);
          const consumerTransport = device.createRecvTransport(serverParams);

          consumerTransport.on(
            "connect",
            async ({ dtlsParameters }, callback, errback) => {
              try {
                await socket.emit("transportRecvConnect", { dtlsParameters });
                callback();
              } catch (error: any) {
                errback(error);
              }
            }
          );
          resolve(consumerTransport);
        }
      );
    });
  };

  const connectRecvTransport = async (
    consumerTransport
  ): Promise<mediasoupClient.types.Consumer> => {
    return new Promise((resolve, reject) => {
      socket.emit(
        "consume",
        {
          rtpCapabilities: device.rtpCapabilities,
        },
        async ({ params: consumeParams }: any) => {
          if (consumeParams.error) {
            reject(consumeParams.error);
          }

          console.log(consumeParams);

          const consumer = await consumerTransport.consume({
            id: consumeParams.id,
            producerId: producerId,
            kind: consumeParams.kind,
            rtpParameters: consumeParams.rtpParameters,
          });
          resolve(consumer);

          socket.emit("consumerResume");
        }
      );
    });
  };

  if (!mediaStream)
    return <div className="text-gray-400">Waiting for remote stream...</div>;

  return <StreamOutput stream={mediaStream} />;
};

export default RemoteStream;
