"use client";

import React, { useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import RemoteStream from "@/components/RemoteStream";
import io from "socket.io-client";

// Define RemoteProducer type
type RemoteProducer = {
  socketId: string;
  producers: { id: string; kind: "audio" | "video" }[];
};

const CaptureComponent = () => {
  const socket = useRef(
    io("http://localhost:3001", {
      path: "/ws",
      transports: ["websocket"],
    })
  ).current;

  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const [remoteProducers, setRemoteProducers] = useState<RemoteProducer[]>([]);
  const recordedVideoRef = useRef<HTMLVideoElement | null>(null);

  const addSocketListeners = () => {
    const handleNewProducer = ({ producers, socketId }) => {
      setRemoteProducers((prev) => {
        const exists = prev.some((p) => p.socketId === socketId);
        return exists ? prev : [...prev, { socketId, producers }];
      });
    };

    const handleRoomJoined = (existingProducers: RemoteProducer[]) => {
      console.log("Room joined with producers:", existingProducers);
      setRemoteProducers(existingProducers);
    };

    const handleProducerClosed = ({ socketId }: { socketId: string }) => {
      setRemoteProducers((prev) => prev.filter((p) => p.socketId !== socketId));
    };

    socket.on("newProducer", handleNewProducer);
    socket.on("onRoomJoined", handleRoomJoined);
    socket.on("producerClosed", handleProducerClosed);

    return () => {
      socket.off("newProducer", handleNewProducer);
      socket.off("onRoomJoined", handleRoomJoined);
      socket.off("producerClosed", handleProducerClosed);
    };
  };

  const getRtpCapabilities = () => {
    return new Promise((resolve, reject) => {
      socket.emit("getRtpCapabilities", (data: any, error: any) => {
        if (error) return reject(error);
        resolve(data.rtpCapabilities);
      });
    });
  };

  useEffect(() => {
    const init = async () => {
      try {
        const cleanup = addSocketListeners();
        const rtpCapabilities: any = await getRtpCapabilities();
        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        deviceRef.current = device;
        return cleanup;
      } catch (error) {
        console.error("Error in init:", error);
      }
    };

    const cleanupPromise = init();

    return () => {
      socket.disconnect();
      cleanupPromise?.then((cleanup) => cleanup?.());
    };
  }, []);

  const getGridCols = (count: number) => {
    if (count <= 1) return "grid-cols-1";
    if (count === 2) return "grid-cols-2";
    if (count <= 4) return "grid-cols-2 md:grid-cols-2";
    if (count <= 6) return "grid-cols-2 md:grid-cols-3";
    if (count <= 9) return "grid-cols-2 md:grid-cols-3 lg:grid-cols-3";
    return "grid-cols-2 md:grid-cols-3 lg:grid-cols-4";
  };

  return (
    <div className="p-6 min-h-screen justify-between text-white">
      <div
        className={`grid gap-6 ${getGridCols(remoteProducers.length + 1)} max-w-5xl mx-auto`}
      >
        {remoteProducers.length &&
          remoteProducers.map(({ producers, socketId }) => (
            <div key={socketId} className="relative">
              <RemoteStream
                socket={socket}
                device={deviceRef.current!}
                producers={producers}
              />
            </div>
          ))}
      </div>
    </div>
  );
};

export default CaptureComponent;
