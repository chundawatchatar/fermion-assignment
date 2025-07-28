"use client";

import Hls from "hls.js";
import { useEffect, useRef } from "react";

export default function WatchPage() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // Start stream on server
    fetch('http://localhost:3001/api/start-stream', { method: 'POST' });

    // Initialize HLS after delay for FFmpeg to start
    setTimeout(() => {
      if (Hls.isSupported()) {
        const hls = new Hls({
          liveSyncDurationCount: 1,
          liveMaxLatencyDurationCount: 3,
          maxBufferLength: 10,
        });
        try {
          hls.loadSource("http://localhost:3001/hls/stream.m3u8");
          hls.attachMedia(videoRef.current!);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            // Jump to live edge and play
            videoRef.current!.currentTime = videoRef.current!.duration;
            videoRef.current!.play();
          });
        } catch (error) {}
      }
    }, 3000);
  }, []);

  return (
    <div className="w-full h-screen flex justify-center items-center bg-black">
      <div className="max-w-2xl">
        <video
          ref={videoRef}
          controls
          autoPlay
          muted
          className="w-full rounded-xl"
        />
      </div>
    </div>
  );
}
