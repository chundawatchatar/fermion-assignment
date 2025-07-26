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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const consumerRef = useRef<mediasoupClient.types.Consumer | null>(null);

  useEffect(() => {
    const consumeRemoteStream = async () => {
      try {
        setIsLoading(true);
        setError(null);
        
        const transport = await createRecvTransport();
        const consumer = await connectRecvTransport(transport);
        consumerRef.current = consumer;
        
        const stream = new MediaStream([consumer.track]);
        setMediaStream(stream);
        setIsLoading(false);
      } catch (err: any) {
        console.error("Error setting up remote stream:", err);
        setError(err.message || "Failed to setup remote stream");
        setIsLoading(false);
      }
    };

    consumeRemoteStream();

    // Cleanup on unmount
    return () => {
      if (consumerRef.current) {
        consumerRef.current.close();
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [producerId]);

  const createRecvTransport = (): Promise<mediasoupClient.types.Transport> => {
    return new Promise((resolve, reject) => {
      socket.emit(
        "createWebRtcTransport",
        { sender: false },
        ({ params: serverParams }: any) => {
          if (serverParams.error) {
            console.error("Error creating recv transport:", serverParams.error);
            reject(new Error(serverParams.error));
            return;
          }

          console.log("Recv transport params:", serverParams);
          const consumerTransport = device.createRecvTransport(serverParams);

          consumerTransport.on(
            "connect",
            async ({ dtlsParameters }, callback, errback) => {
              try {
                socket.emit("transportRecvConnect", { dtlsParameters });
                callback();
              } catch (error: any) {
                console.error("Error in recv transport connect:", error);
                errback(error);
              }
            }
          );

          consumerTransport.on("connectionstatechange", (state) => {
            console.log("Consumer transport connection state:", state);
          });

          resolve(consumerTransport);
        }
      );
    });
  };

  const connectRecvTransport = async (
    consumerTransport: mediasoupClient.types.Transport
  ): Promise<mediasoupClient.types.Consumer> => {
    return new Promise((resolve, reject) => {
      socket.emit(
        "consume",
        {
          rtpCapabilities: device.rtpCapabilities,
          producerId: producerId,
        },
        async ({ params: consumeParams }: any) => {
          if (consumeParams.error) {
            console.error("Error in consume:", consumeParams.error);
            reject(new Error(consumeParams.error));
            return;
          }

          console.log("Consume params:", consumeParams);
          console.log({ producerId })
          
          try {
            const consumer = await consumerTransport.consume({
              id: consumeParams.id,
              producerId: producerId,
              kind: consumeParams.kind,
              rtpParameters: consumeParams.rtpParameters,
            });

            consumer.on("transportclose", () => {
              console.log("Consumer transport closed");
            });

            // Resume the consumer
            socket.emit("consumerResume", { consumerId: consumer.id });
            
            resolve(consumer);
          } catch (error: any) {
            console.error("Error creating consumer:", error);
            reject(error);
          }
        }
      );
    });
  };

  if (isLoading) {
    return (
      <div className="rounded-xl overflow-hidden border p-2 w-80 h-48 flex items-center justify-center">
        <div className="text-gray-400">Loading remote stream...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl overflow-hidden border p-2 w-80 h-48 flex items-center justify-center">
        <div className="text-red-400">Error: {error}</div>
      </div>
    );
  }

  if (!mediaStream) {
    return (
      <div className="rounded-xl overflow-hidden border p-2 w-80 h-48 flex items-center justify-center">
        <div className="text-gray-400">Waiting for remote stream...</div>
      </div>
    );
  }

  return <StreamOutput stream={mediaStream} />;
};

export default RemoteStream;
