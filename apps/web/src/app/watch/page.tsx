'use client'

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';


const WatchPage = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string>('');
  const [streamStatus, setStreamStatus] = useState<any>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    checkStreamStatus();
    const interval = setInterval(checkStreamStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isLive) {
      initializeHLS();
    } else {
      cleanupHLS();
    }
    return cleanupHLS;
  }, [isLive]);

  const checkStreamStatus = async () => {
    try {
      const response = await fetch('http://localhost:3001/api/stream-status');
      const status = await response.json();
      setStreamStatus(status);
      setIsLive(status.isLive);
      
      if (status.isLive && !hlsRef.current) {
        // Small delay to ensure HLS segments are available
        setTimeout(() => {
          initializeHLS();
        }, 2000);
      }
    } catch (err) {
      console.error('Failed to check stream status:', err);
    }
  };

  const initializeHLS = () => {
    if (!videoRef.current) return;

    const hlsUrl = 'http://localhost:3001/hls/stream.m3u8';

    if (Hls.isSupported()) {
      hlsRef.current = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        maxBufferLength: 10,
        maxMaxBufferLength: 20,
        maxBufferSize: 60 * 1000 * 1000,
        maxBufferHole: 0.5,
        highBufferWatchdogPeriod: 2,
        nudgeOffset: 0.1,
        nudgeMaxRetry: 3,
        maxFragLookUpTolerance: 0.25,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 5,
        liveDurationInfinity: true,
        liveBackBufferLength: 2,
      });

      hlsRef.current.loadSource(hlsUrl);
      hlsRef.current.attachMedia(videoRef.current);

      hlsRef.current.on(Hls.Events.MEDIA_ATTACHED, () => {
        console.log('HLS media attached');
      });

      hlsRef.current.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        console.log('HLS manifest parsed, starting playback');
        videoRef.current?.play().catch(err => {
          console.error('Autoplay failed:', err);
          setError('Click play button to start watching');
        });
        setError('');
        setRetryCount(0);
      });

      hlsRef.current.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS error:', data);
        
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              setError('Network error - retrying...');
              if (retryCount < 5) {
                setTimeout(() => {
                  hlsRef.current?.startLoad();
                  setRetryCount(prev => prev + 1);
                }, 2000);
              } else {
                setError('Stream unavailable. Please check if streamers are live.');
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              setError('Media error - attempting recovery...');
              hlsRef.current?.recoverMediaError();
              break;
            default:
              setError('Playback error occurred');
              hlsRef.current?.destroy();
              hlsRef.current = null;
              break;
          }
        }
      });

      hlsRef.current.on(Hls.Events.BUFFER_APPENDED, () => {
        // Successfully receiving stream data
        setError('');
      });

    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      videoRef.current.src = hlsUrl;
      videoRef.current.addEventListener('loadedmetadata', () => {
        videoRef.current?.play().catch(err => {
          console.error('Autoplay failed:', err);
          setError('Click play button to start watching');
        });
      });
    } else {
      setError('HLS is not supported in this browser');
    }
  };

  const cleanupHLS = () => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.src = '';
    }
  };

  const handlePlayClick = () => {
    if (videoRef.current) {
      videoRef.current.play().catch(err => {
        console.error('Play failed:', err);
        setError('Failed to start playback');
      });
    }
  };

  const handleRetry = () => {
    setError('');
    setRetryCount(0);
    cleanupHLS();
    setTimeout(() => {
      if (isLive) {
        initializeHLS();
      }
    }, 1000);
  };

  const getStreamStatusText = () => {
    if (!streamStatus) return 'Checking...';
    if (!streamStatus.isLive) return 'Stream Offline';
    
    const producers = [];
    if (streamStatus.producers.video) producers.push('Video');
    if (streamStatus.producers.audio) producers.push('Audio');
    
    return `Live - ${producers.join(' + ') || 'No media'}`;
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Watch Live Stream</h1>
        
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className={`px-3 py-1 rounded flex items-center space-x-2 ${
              isLive ? 'bg-red-500' : 'bg-gray-500'
            }`}>
              <div className={`w-2 h-2 rounded-full ${
                isLive ? 'bg-white animate-pulse' : 'bg-gray-300'
              }`}></div>
              <span>{getStreamStatusText()}</span>
            </div>
            
            {error && (
              <button
                onClick={handleRetry}
                className="px-4 py-1 bg-blue-500 hover:bg-blue-600 rounded text-sm"
              >
                Retry
              </button>
            )}
          </div>
          
          <div className="text-sm text-gray-400">
            Viewers: Live
          </div>
        </div>

        {error && (
          <div className="bg-yellow-600 text-white p-4 rounded mb-6 flex items-center justify-between">
            <span>{error}</span>
            {error.includes('Click play') && (
              <button
                onClick={handlePlayClick}
                className="px-4 py-2 bg-white text-yellow-600 rounded hover:bg-gray-100"
              >
                Play
              </button>
            )}
          </div>
        )}

        <div className="bg-black rounded-lg overflow-hidden mb-6">
          <video
            ref={videoRef}
            controls
            className="w-full"
            style={{ aspectRatio: '16/9' }}
            poster="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYwMCIgaGVpZ2h0PSI5MDAiIHZpZXdCb3g9IjAgMCAxNjAwIDkwMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjE2MDAiIGhlaWdodD0iOTAwIiBmaWxsPSIjMTExODI3Ii8+Cjx0ZXh0IHg9IjgwMCIgeT0iNDUwIiBmaWxsPSIjNkI3Mjg4IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXNpemU9IjQ4IiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiI+V2FpdGluZyBmb3IgbGl2ZSBzdHJlYW0uLi48L3RleHQ+Cjwvc3ZnPgo="
          />
        </div>

        {!isLive && (
          <div className="text-center py-12">
            <div className="text-6xl mb-4">📺</div>
            <h2 className="text-2xl font-semibold mb-4">Stream is Currently Offline</h2>
            <p className="text-gray-400 mb-6">
              Waiting for streamers to go live. The page will automatically update when the stream starts.
            </p>
            <div className="text-sm text-gray-500">
              <p>To start streaming:</p>
              <p>1. Open /stream in another tab</p>
              <p>2. Click &quot;Start Camera&quot; to begin broadcasting</p>
              <p>3. This page will automatically start playing the live stream</p>
            </div>
          </div>
        )}

        {isLive && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-2">
              <div className="bg-gray-800 rounded-lg p-6">
                <h3 className="text-xl font-semibold mb-4">Stream Information</h3>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Status:</span>
                    <span className="text-green-400">🔴 LIVE</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Video Quality:</span>
                    <span>Auto (HLS Adaptive)</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Latency:</span>
                    <span>~5-10 seconds</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Format:</span>
                    <span>HLS Stream</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-gray-800 rounded-lg p-6">
              <h3 className="text-xl font-semibold mb-4">Stream Health</h3>
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-400">Video:</span>
                  <span className={streamStatus?.producers?.video ? 'text-green-400' : 'text-red-400'}>
                    {streamStatus?.producers?.video ? '✓' : '✗'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Audio:</span>
                  <span className={streamStatus?.producers?.audio ? 'text-green-400' : 'text-red-400'}>
                    {streamStatus?.producers?.audio ? '✓' : '✗'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Connection:</span>
                  <span className="text-green-400">Stable</span>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mt-8 p-4 bg-gray-800 rounded-lg">
          <h3 className="text-lg font-semibold mb-2 flex items-center">
            <span className="mr-2">ℹ️</span>
            How it Works
          </h3>
          <div className="text-gray-300 space-y-2 text-sm">
            <p><strong>Real-time Flow:</strong></p>
            <p>1. Streamers connect via WebRTC on /stream page</p>
            <p>2. Server uses Mediasoup to handle WebRTC connections</p>
            <p>3. FFMPEG transcodes WebRTC streams to HLS format</p>
            <p>4. You&apos;re watching the HLS stream with ~5-10s latency</p>
            <p className="text-blue-400 mt-3">
              This simulates how platforms like YouTube Live work - WebRTC for low-latency interaction between streamers, HLS for scalable viewer delivery.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WatchPage;