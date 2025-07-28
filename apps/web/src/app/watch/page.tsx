"use client";
import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";

export default function WatchPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [streamStatus, setStreamStatus] = useState("checking"); // "checking", "not_started", "starting", "playing"
  const [error, setError] = useState("");
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const checkStreamAvailability = async () => {
    try {
      const response = await fetch("http://localhost:3001/hls/stream.m3u8", {
        method: "HEAD",
      });
      
      if (response.ok) {
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  };

  // const startStream = async () => {
  //   try {
  //     await fetch('http://localhost:3001/api/start-stream', { method: 'POST' });
  //     return true;
  //   } catch (error) {
  //     setError("Failed to start stream");
  //     return false;
  //   }
  // };

  const initializeHLS = () => {
    if (!Hls.isSupported() || !videoRef.current) {
      setError("HLS is not supported in this browser");
      return;
    }

    const hls = new Hls({
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 3,
      maxBufferLength: 10,
    });

    hlsRef.current = hls;

    hls.loadSource("http://localhost:3001/hls/stream.m3u8");
    hls.attachMedia(videoRef.current);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setStreamStatus("playing");
      // Jump to live edge and play
      if (videoRef.current) {
        videoRef.current.currentTime = videoRef.current.duration;
        videoRef.current.play().catch(() => {
          // Auto-play might be blocked, but that's okay
        });
      }
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        setError("Stream playback error");
        setStreamStatus("not_started");
      }
    });
  };

  const pollForStream = async () => {
    const isAvailable = await checkStreamAvailability();
    
    if (isAvailable) {
      setStreamStatus("starting");
      // Clear polling interval
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      
      // Small delay to ensure stream is ready
      setTimeout(() => {
        initializeHLS();
      }, 1000);
    } else {
      setStreamStatus("not_started");
    }
  };

  useEffect(() => {
    const initialize = async () => {
      setStreamStatus("checking");
      
      // Try to start the stream
      // await startStream();
      
      // Start polling for stream availability
      pollForStream(); // Check immediately
      
      pollIntervalRef.current = setInterval(() => {
        pollForStream();
      }, 2000); // Check every 2 seconds
    };

    initialize();

    // Cleanup function
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, []);

  const getStatusMessage = () => {
    switch (streamStatus) {
      case "checking":
        return "Checking for stream...";
      case "not_started":
        return "Stream not started yet. Waiting...";
      case "starting":
        return "Stream found! Starting playback...";
      case "playing":
        return null; // Don't show message when playing
      default:
        return "Loading...";
    }
  };

  return (
    <div className="w-full h-screen flex justify-center items-center bg-black">
      <div className="max-w-2xl">
        {streamStatus !== "playing" && (
          <div className="flex flex-col items-center justify-center p-8 text-white">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mb-4"></div>
            <p className="text-lg">{getStatusMessage()}</p>
            {error && <p className="text-red-400 mt-2">{error}</p>}
          </div>
        )}
        
        <video
          ref={videoRef}
          controls
          autoPlay
          muted
          className={`w-full rounded-xl ${streamStatus !== "playing" ? "hidden" : ""}`}
        />
      </div>
    </div>
  );
}