import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as mediasoup from "mediasoup";

interface StreamingSession {
  transport: any;
  consumer: any;
  ffmpegProcess: any;
}

let currentSession: StreamingSession | null = null;

function cleanupHLSFiles(hlsDir: string): void {
  try {
    if (!fs.existsSync(hlsDir)) {
      return;
    }

    const files = fs.readdirSync(hlsDir);
    
    files.forEach(file => {
      const filePath = path.join(hlsDir, file);
      
      // Remove .ts segments, .m3u8 playlists, and .sdp files
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

// Generate SDP based on actual RTP parameters
function generateSDP(rtpParameters: any, port: number): string {
  // Look for VP8 or H.264 codec
  const videoCodec = rtpParameters.codecs.find(
    codec => codec.mimeType.toLowerCase() === 'video/vp8' || 
             codec.mimeType.toLowerCase() === 'video/h264'
  );
  
  if (!videoCodec) {
    throw new Error('No supported video codec (VP8/H.264) found in RTP parameters');
  }

  const payloadType = videoCodec.payloadType;
  const clockRate = videoCodec.clockRate;
  const codecName = videoCodec.mimeType.split('/')[1].toUpperCase(); // VP8 or H264
  
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

  // Add fmtp line if there are parameters
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
  }
  if (session.consumer && !session.consumer.closed) {
    session.consumer.close();
  }
  if (session.transport && !session.transport.closed) {
    session.transport.close();
  }
}

export async function startFFmpeg(router: mediasoup.types.Router, producers: Map<string, any[]>): Promise<void> {
  try {
    console.log("Starting FFmpeg...");

    if (currentSession) {
      await cleanupSession(currentSession);
    }

    const hlsDir = path.join(__dirname, "..", "public", "hls");
    cleanupHLSFiles(hlsDir)
    if (!fs.existsSync(hlsDir)) {
      fs.mkdirSync(hlsDir, { recursive: true });
    }

    // Get the first video producer
    let videoProducer: any = null;
    for (const producerList of producers.values()) {
      videoProducer = producerList.find((p: any) => p.kind === "video");
      if (videoProducer) break;
    }

    if (!videoProducer) {
      throw new Error("No video producer found");
    }

    console.log('Found video producer:', videoProducer.id);

    // Create plain transport
    const plainTransport = await createPlainTransport(router);

    // Define fixed FFmpeg port
    const ffmpegRtpPort = 5004;

    // Connect transport to FFmpeg
    await plainTransport.connect({
      ip: "127.0.0.1",
      port: ffmpegRtpPort,
    });

    console.log("Transport connected to FFmpeg on port", ffmpegRtpPort);

    // Create consumer
    const consumer = await plainTransport.consume({
      producerId: videoProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });

    // Get actual RTP parameters
    const rtpParameters = consumer.rtpParameters;
    console.log('RTP Parameters:', JSON.stringify(rtpParameters, null, 2));

    // Generate proper SDP file
    const sdpPath = path.join(hlsDir, "video.sdp");
    const sdpContent = generateSDP(rtpParameters, ffmpegRtpPort);
    
    console.log('Generated SDP:');
    console.log(sdpContent);
    
    fs.writeFileSync(sdpPath, sdpContent);

    // Resume consumer to start sending RTP
    await consumer.resume();
    console.log("Consumer resumed, RTP should be flowing...");

    // Wait a moment for RTP to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Start FFmpeg with VP8 to H.264 transcoding
    const ffmpegArgs = [
      "-protocol_whitelist", "file,udp,rtp",
      "-f", "sdp",
      "-i", sdpPath,
      "-c:v", "libx264", // Transcode VP8 to H.264 for HLS
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-profile:v", "baseline", // Better compatibility
      "-level", "3.1",
      "-pix_fmt", "yuv420p", // Ensure compatible pixel format
      "-g", "30", // GOP size
      "-an", // No audio
      "-f", "hls",
      "-hls_time", "2",
      "-hls_list_size", "10",
      "-hls_flags", "delete_segments+independent_segments",
      "-hls_start_number_source", "datetime",
      "-y",
      path.join(hlsDir, "stream.m3u8"),
    ];

    console.log('Starting FFmpeg with command:', 'ffmpeg', ffmpegArgs.join(' '));

    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

    currentSession = {
      transport: plainTransport,
      consumer,
      ffmpegProcess,
    };

    ffmpegProcess.stderr.on("data", (data: Buffer) => {
      const output = data.toString();
      // Only log important messages to reduce noise
      if (output.includes('error') || output.includes('Error') || 
          output.includes('frame=') || output.includes('time=')) {
        console.log(`FFmpeg: ${output.trim()}`);
      }
    });

    ffmpegProcess.on("error", (error: Error) => {
      console.error("FFmpeg process error:", error);
    });

    ffmpegProcess.on("exit", (code: number) => {
      console.log(`FFmpeg exited with code ${code}`);
      if (currentSession) {
        cleanupSession(currentSession);
        currentSession = null;
      }
    });

    console.log("Streaming started successfully");
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
    await cleanupSession(currentSession);
    currentSession = null;
    console.log("Streaming stopped");
  }
}