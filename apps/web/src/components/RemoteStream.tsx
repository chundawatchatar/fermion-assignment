"use client";

import React, { useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import StreamOutput from "./StreamOutput";

type Producer = {
  id: string;
  kind: "audio" | "video";
};

type Props = {
  socket: any; // consider typing this with `Socket<ServerToClientEvents, ClientToServerEvents>`
  device: mediasoupClient.types.Device;
  producers: Producer[];
};

const RemoteStream: React.FC<Props> = ({ socket, device, producers }) => {
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const consumerRefs = useRef<mediasoupClient.types.Consumer[]>([]);

  useEffect(() => {
    if (!producers || producers.length < 2) {
      setError("Waiting for both audio and video producers...");
      setIsLoading(false);
      return;
    }

    let consumerTransport: mediasoupClient.types.Transport | null = null;

    const setupRemoteStream = async () => {
      try {
        setIsLoading(true);
        setError(null);

        consumerTransport = await createRecvTransport();

        const [videoProducer, audioProducer] = producers;

        const videoConsumer = await connectRecvTransport(
          consumerTransport,
          videoProducer.id
        );
        const audioConsumer = await connectRecvTransport(
          consumerTransport,
          audioProducer.id
        );

        consumerRefs.current = [videoConsumer, audioConsumer];

        const remoteStream = new MediaStream([
          videoConsumer.track,
          audioConsumer.track,
        ]);

        setMediaStream(remoteStream);
        setIsLoading(false);
      } catch (err: any) {
        console.error("Error setting up remote stream:", err);
        setError(err.message || "Failed to setup remote stream");
        setIsLoading(false);
      }
    };

    setupRemoteStream();

    return () => {
      consumerRefs.current.forEach((c) => c?.close());
      if (consumerTransport) consumerTransport.close();
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [producers]);

  const createRecvTransport = (): Promise<mediasoupClient.types.Transport> => {
    return new Promise((resolve, reject) => {
      socket.emit(
        "createWebRtcTransport",
        { sender: false },
        ({ params: serverParams }: any) => {
          if (serverParams.error) {
            return reject(new Error(serverParams.error));
          }

          const recvTransport = device.createRecvTransport(serverParams);

          recvTransport.on(
            "connect",
            async ({ dtlsParameters }, callback, errback) => {
              try {
                socket.emit("transportRecvConnect", { dtlsParameters });
                callback();
              } catch (err: any) {
                errback(err);
              }
            }
          );

          recvTransport.on("connectionstatechange", (state) => {
            console.log("Recv transport state:", state);
          });

          resolve(recvTransport);
        }
      );
    });
  };

  const connectRecvTransport = async (
    transport: mediasoupClient.types.Transport,
    producerId: string
  ): Promise<mediasoupClient.types.Consumer> => {
    return new Promise((resolve, reject) => {
      socket.emit(
        "consume",
        {
          rtpCapabilities: device.rtpCapabilities,
          producerId,
        },
        async ({ params }: any) => {
          if (params?.error) {
            return reject(new Error(params.error));
          }

          try {
            const consumer = await transport.consume({
              id: params.id,
              producerId,
              kind: params.kind,
              rtpParameters: params.rtpParameters,
            });

            consumer.on("transportclose", () =>
              console.log("Consumer transport closed")
            );

            socket.emit("consumerResume", { consumerId: consumer.id });

            resolve(consumer);
          } catch (error: any) {
            reject(error);
          }
        }
      );
    });
  };

  // Render states
  if (isLoading) {
    return (
      <div className="rounded-xl overflow-hidden border p-2 w-80 h-48 flex items-center justify-center">
        <span className="text-gray-400">Loading remote stream...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl overflow-hidden border p-2 w-80 h-48 flex items-center justify-center">
        <span className="text-red-500">Error: {error}</span>
      </div>
    );
  }

  if (!mediaStream) {
    return (
      <div className="rounded-xl overflow-hidden border p-2 w-80 h-48 flex items-center justify-center">
        <span className="text-gray-400">No media stream available</span>
      </div>
    );
  }

  return <StreamOutput stream={mediaStream} />;
};

export default RemoteStream;
