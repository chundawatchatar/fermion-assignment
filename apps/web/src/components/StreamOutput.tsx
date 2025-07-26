'use client'


import React, { useEffect, useRef } from "react";

type Props = {
  stream: MediaStream;
  isLocal?: boolean;
};

const StreamOutput: React.FC<Props> = ({ stream, isLocal = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="rounded-xl overflow-hidden border p-2 w-80">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className="w-full h-48 object-cover"
      />
      <div className="text-center text-xs mt-1">
        {isLocal ? "You" : "Remote User"}
      </div>
    </div>
  );
};

export default StreamOutput;
