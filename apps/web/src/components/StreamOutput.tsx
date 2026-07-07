"use client";

import React, { useEffect, useRef } from "react";

type Props = {
  stream: MediaStream;
  isLocal?: boolean;
};

const StreamOutput: React.FC<Props> = ({ stream, isLocal = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      const video = videoRef.current;
      video.srcObject = stream;

      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {
          // Browser still requires manual playback.
        });
      });
    }
  }, [stream]);

  return (
    <div className="flex flex-col items-center bg-gray-100 rounded-lg p-2 shadow">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        controls={!isLocal}
        className="w-full aspect-video bg-black rounded-lg"
      />
      <div className="mt-2 text-xs text-gray-700 font-mono">
        {isLocal ? "You" : "Remote User"}
      </div>
    </div>
  );
};

export default StreamOutput;
