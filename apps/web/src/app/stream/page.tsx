"use client";

import React, { useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import StreamOutput from "@/components/StreamOutput";
import RemoteStream from "@/components/RemoteStream";
import io from "socket.io-client";
import { Camera, Mic, MicOff, CameraOff } from "lucide-react";

// Define RemoteProducer type
type RemoteProducer = {
  socketId: string;
  producers: { id: string; kind: "audio" | "video" }[];
};

const MediasoupClientComponent = () => {
  const socket = useRef(
    io("http://localhost:3001", {
      path: "/ws",
      transports: ["websocket"],
    })
  ).current;

  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteProducers, setRemoteProducers] = useState<RemoteProducer[]>([]);
  const [isJoined, setIsJoined] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);

  const params = {
    encodings: [
      { rid: "r0", maxBitrate: 100_000, scalabilityMode: "S1T3" },
      { rid: "r1", maxBitrate: 300_000, scalabilityMode: "S1T3" },
      { rid: "r2", maxBitrate: 900_000, scalabilityMode: "S1T3" },
    ],
    codecOptions: {
      videoGoogleStartBitrate: 1000,
    },
  };

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

    const handleDisconnect = (reason: string) => {
      console.log(`Disconnected: ${reason}`);
      setRemoteProducers([]);
      setIsJoined(false);
      socket.off("newProducer", handleNewProducer);
      socket.off("onRoomJoined", handleRoomJoined);
      socket.off("producerClosed", handleProducerClosed);
      socket.off("disconnect", handleDisconnect);
    };

    socket.on("newProducer", handleNewProducer);
    socket.on("onRoomJoined", handleRoomJoined);
    socket.on("producerClosed", handleProducerClosed);
    socket.on("disconnect", handleDisconnect);
  };

  const getRtpCapabilities = () => {
    return new Promise((resolve, reject) => {
      socket.emit("getRtpCapabilities", (data: any, error: any) => {
        if (error) return reject(error);
        resolve(data.rtpCapabilities);
      });
    });
  };

  const joinRoom = async () => {
    if (!localStream || isJoined) return;

    addSocketListeners();

    setIsConnecting(true);
    try {
      const rtpCapabilities: any = await getRtpCapabilities();
      const device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities: rtpCapabilities });

      if (!device.canProduce("video")) {
        alert("cannot produce video");
        return;
      }

      deviceRef.current = device;

      const videoParams = { track: localStream.getVideoTracks()[0], ...params };
      const audioParams = { track: localStream.getAudioTracks()[0] };

      const sendTransport = await createSendTransport(device);
      await connectSendTransport(sendTransport, videoParams);
      await connectSendTransport(sendTransport, audioParams);

      setIsJoined(true);
      console.log("Successfully joined the room");
    } catch (error) {
      console.error("Error joining room:", error);
    } finally {
      setIsConnecting(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        setLocalStream(stream);
        // const cleanup = addSocketListeners();
        // return cleanup;
      } catch (error) {
        console.error("Error in init:", error);
      }
    };

    init();

    return () => {
      socket.disconnect();
      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
      }
      // cleanupPromise?.then((cleanup) => cleanup?.());
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

          const sendTransport = device.createSendTransport(serverParams);

          sendTransport.on(
            "connect",
            async ({ dtlsParameters }, callback, errback) => {
              try {
                socket.emit("transportConnect", { dtlsParameters });
                callback();
              } catch (error: any) {
                errback(error);
              }
            }
          );

          sendTransport.on("produce", (parameters, callback, errback) => {
            socket.emit(
              "transportProduce",
              {
                kind: parameters.kind,
                rtpParameters: parameters.rtpParameters,
                appData: parameters.appData,
              },
              ({ id, error }: any) => {
                if (error) {
                  errback(new Error(error));
                } else {
                  callback({ id });
                }
              }
            );
          });

          sendTransport.on("connectionstatechange", (state) => {
            console.log("Producer transport state:", state);
          });

          resolve(sendTransport);
        }
      );
    });
  };

  const connectSendTransport = async (
    sendTransport: any,
    transportParams: any
  ) => {
    try {
      const producer = await sendTransport.produce(transportParams);

      producer.on("trackended", () => {
        console.log("track ended");
      });

      producer.on("transportclose", () => {
        console.log("transport closed");
      });

      console.log("Producer created:", producer.id, producer.kind);
    } catch (error) {
      console.error("Error connecting send transport:", error);
    }
  };

  const toggleVideo = () => {
    const videoTrack = localStream?.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      setIsVideoEnabled(videoTrack.enabled);
    }
  };

  const toggleAudio = () => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setIsAudioEnabled(audioTrack.enabled);
    }
  };

  const getGridCols = (count: number) => {
    if (count <= 1) return "grid-cols-1";
    if (count === 2) return "grid-cols-2";
    if (count <= 4) return "grid-cols-2 md:grid-cols-2";
    if (count <= 6) return "grid-cols-2 md:grid-cols-3";
    if (count <= 9) return "grid-cols-2 md:grid-cols-3 lg:grid-cols-3";
    return "grid-cols-2 md:grid-cols-3 lg:grid-cols-4";
  };

  return (
    <div className="p-6 min-h-screen flex flex-col justify-between text-white">
      <div className="flex-1">
        <div
          className={`grid gap-6 ${getGridCols(remoteProducers.length + 1)} max-w-5xl mx-auto`}
        >
          {localStream && (
            <div className="relative">
              <StreamOutput stream={localStream} isLocal />
            </div>
          )}

          {deviceRef.current &&
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

      <div className="h-20 flex items-center justify-center">
        <div className="flex gap-4 items-center">
          <button
            onClick={toggleVideo}
            disabled={!localStream}
            className={`p-3 rounded-full transition-colors ${
              isVideoEnabled
                ? "bg-gray-700 hover:bg-gray-600 text-white"
                : "bg-red-600 hover:bg-red-700 text-white"
            } disabled:opacity-50`}
          >
            {isVideoEnabled ? <Camera size={20} /> : <CameraOff size={20} />}
          </button>

          <button
            onClick={toggleAudio}
            disabled={!localStream}
            className={`p-3 rounded-full transition-colors ${
              isAudioEnabled
                ? "bg-gray-700 hover:bg-gray-600 text-white"
                : "bg-red-600 hover:bg-red-700 text-white"
            } disabled:opacity-50`}
          >
            {isAudioEnabled ? <Mic size={20} /> : <MicOff size={20} />}
          </button>

          <button
            onClick={joinRoom}
            disabled={!localStream || isJoined || isConnecting}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {isConnecting ? "Joining..." : isJoined ? "Joined" : "Join"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MediasoupClientComponent;
