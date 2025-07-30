import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as mediasoup from "mediasoup";

interface StreamingSession {
  transport: any;
  consumer: any;
  ffmpegProcess: any;
}

const hlsDir = path.join(__dirname, "..", "public", "hls");
let currentSession: StreamingSession | null = null;

function cleanupHLSFiles(hlsDir: string): void {
  try {
    if (!fs.existsSync(hlsDir)) {
      return;
    }

    const files = fs.readdirSync(hlsDir);
    
    files.forEach(file => {
      const filePath = path.join(hlsDir, file);
      
      if (file.endsWith('.ts') || file.endsWith('.m3u8') || file.endsWith('.sdp')) {
        try {
          fs.unlinkSync(filePath);
          console.log(`Removed old HLS file: ${file}`);
        } catch (err) {
          console.warn(`Failed to remove file ${file}:`, err);
        }
      }
    });
    
    console.log('HLS cleanup completed');
  } catch (error) {
    console.error('HLS cleanup failed:', error);
  }
}

async function createPlainTransport(router: mediasoup.types.Router): Promise<any> {
  const transport = await router.createPlainTransport({
    listenIp: "127.0.0.1",
    rtcpMux: true,
    comedia: false,
  });
  return transport;
}

function generateSDP(rtpParameters: any, port: number): string {
  const videoCodec = rtpParameters.codecs.find(
    codec => codec.mimeType.toLowerCase() === 'video/vp8' || 
             codec.mimeType.toLowerCase() === 'video/h264'
  );
  
  if (!videoCodec) {
    throw new Error('No supported video codec (VP8/H.264) found in RTP parameters');
  }

  const payloadType = videoCodec.payloadType;
  const clockRate = videoCodec.clockRate;
  const codecName = videoCodec.mimeType.split('/')[1].toUpperCase();
  
  console.log('Using codec:', codecName, 'payload type:', payloadType, 'clock rate:', clockRate);

  const sdpLines = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=MediaSoup RTP Stream",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=video ${port} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} ${codecName}/${clockRate}`,
  ];

  if (videoCodec.parameters && Object.keys(videoCodec.parameters).length > 0) {
    const fmtpParams = Object.entries(videoCodec.parameters)
      .map(([key, value]) => `${key}=${value}`)
      .join(';');
    sdpLines.push(`a=fmtp:${payloadType} ${fmtpParams}`);
  }

  return sdpLines.join('\n');
}

async function cleanupSession(session: StreamingSession): Promise<void> {
  if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
    session.ffmpegProcess.kill("SIGTERM");
    // Wait a bit for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (session.consumer && !session.consumer.closed) {
    session.consumer.close();
  }
  if (session.transport && !session.transport.closed) {
    session.transport.close();
  }

  cleanupHLSFiles(hlsDir);
}

export async function startFFmpeg(router: mediasoup.types.Router, producers: Map<string, any[]>): Promise<void> {
  try {
    console.log("Starting FFmpeg streaming...");

    if(currentSession) return

    // if (currentSession) {
    //   console.log("Cleaning up existing session...");
    //   await cleanupSession(currentSession);
    //   currentSession = null;
    // }

    if (!fs.existsSync(hlsDir)) {
      fs.mkdirSync(hlsDir, { recursive: true });
    }

    let videoProducer: any = null;
    // let audioProducer: any = null
    for (const producerList of producers.values()) {
      videoProducer = producerList.find((p: any) => p.kind === "video");
      // audioProducer = producerList.find((p: any) => p.kind === "audio");
      if (videoProducer) break;
    }
    
    if (!videoProducer) {
      throw new Error("No video producer found");
    }

    console.log('Found video producer:', videoProducer.id);

    const plainTransport = await createPlainTransport(router);
    const ffmpegRtpPort = 5004;

    await plainTransport.connect({
      ip: "127.0.0.1",
      port: ffmpegRtpPort,
    });

    console.log("Transport connected to FFmpeg on port", ffmpegRtpPort);

    const consumer = await plainTransport.consume({
      producerId: videoProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: false, // Start immediately, don't wait for resume
    });

    const rtpParameters = consumer.rtpParameters;
    console.log('RTP Parameters configured');
    
    const sdpPath = path.join(hlsDir, "video.sdp");
    const sdpContent = generateSDP(rtpParameters, ffmpegRtpPort);
    
    console.log('Generated SDP content');
    fs.writeFileSync(sdpPath, sdpContent);

    console.log("Consumer started, RTP should be flowing...");

    // Shorter wait time since we're not paused
    await new Promise(resolve => setTimeout(resolve, 500));

    // Optimized FFmpeg args for lower latency
    const ffmpegArgs = [
      "-protocol_whitelist", "file,udp,rtp",
      "-f", "sdp",
      "-i", sdpPath,
      "-c:v", "libx264",
      "-preset", "ultrafast", // Fastest encoding
      "-tune", "zerolatency", // Optimize for low latency
      "-profile:v", "baseline",
      "-level", "3.1",
      "-pix_fmt", "yuv420p",
      "-g", "15", // Smaller GOP for faster startup
      "-keyint_min", "15", // Force keyframes more frequently
      "-sc_threshold", "0", // Disable scene change detection
      "-an", // No audio
      "-f", "hls",
      "-hls_time", "1", // Shorter segments for faster startup
      "-hls_list_size", "6", // Keep fewer segments
      "-hls_flags", "delete_segments+independent_segments",
      "-hls_start_number_source", "datetime",
      "-hls_allow_cache", "0", // Disable caching
      "-start_number", "0",
      "-y",
      path.join(hlsDir, "stream.m3u8"),
    ];

    console.log('Starting FFmpeg with optimized settings...');

    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

    currentSession = {
      transport: plainTransport,
      consumer,
      ffmpegProcess,
    };

    let ffmpegStarted = false;

    ffmpegProcess.stderr.on("data", (data: Buffer) => {
      const output = data.toString();
      
      // Log important messages and detect when streaming actually starts
      if (output.includes('Opening \'') && output.includes('stream.m3u8')) {
        console.log('FFmpeg: HLS output opened');
        ffmpegStarted = true;
      } else if (output.includes('frame=') && !ffmpegStarted) {
        console.log('FFmpeg: First frame processed');
        ffmpegStarted = true;
      } else if (output.includes('error') || output.includes('Error')) {
        console.error(`FFmpeg Error: ${output.trim()}`);
      }
    });

    ffmpegProcess.stdout.on("data", (data: Buffer) => {
      console.log(`FFmpeg stdout: ${data.toString().trim()}`);
    });

    ffmpegProcess.on("error", (error: Error) => {
      console.error("FFmpeg process error:", error);
      if (currentSession) {
        currentSession = null;
      }
    });

    ffmpegProcess.on("exit", (code: number) => {
      console.log(`FFmpeg exited with code ${code}`);
      if (currentSession) {
        cleanupSession(currentSession);
        currentSession = null;
      }
    });

    // Monitor for successful startup
    setTimeout(() => {
      const m3u8Path = path.join(hlsDir, "stream.m3u8");
      if (fs.existsSync(m3u8Path)) {
        console.log("✅ HLS stream is ready!");
      } else {
        console.warn("⚠️  HLS stream not ready yet after 5 seconds");
      }
    }, 5000);

    console.log("FFmpeg streaming initialization completed");
  } catch (error) {
    console.error("Failed to start streaming:", error);
    if (currentSession) {
      await cleanupSession(currentSession);
      currentSession = null;
    }
    throw error;
  }
}

export async function stopFFmpeg(): Promise<void> {
  if (currentSession) {
    console.log("Stopping FFmpeg streaming...");
    await cleanupSession(currentSession);
    currentSession = null;
    console.log("Streaming stopped");
  }
}
