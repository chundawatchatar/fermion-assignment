import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

interface StreamingSession {
  transport: any;
  consumer: any;
  ffmpegProcess: any;
}

let currentSession: StreamingSession | null = null;

async function createPlainTransport(router) {
  const transport = await router.createPlainTransport({
    listenIp: "127.0.0.1",
    rtcpMux: true,     // required for single port RTP+RTCP
    comedia: false,    // we will connect it manually
  });
  return transport;
}

async function cleanupSession(session: StreamingSession) {
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

export async function startFFmpeg(router, producers) {
  try {
    console.log("Starting FFmpeg...");

    if (currentSession) {
      await cleanupSession(currentSession);
    }

    const hlsDir = path.join(__dirname, "..", "public", "hls");
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

    // Create plain transport
    const plainTransport = await createPlainTransport(router);

    // Define fixed FFmpeg port (for receiving RTP)
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

    await consumer.resume();
    console.log("Consumer resumed");

    // Write SDP file
    const sdpPath = path.join(hlsDir, "video.sdp");
    const sdpContent = `
v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFmpeg RTP Input
c=IN IP4 127.0.0.1
t=0 0
m=video 5004 RTP/AVP 101
a=rtpmap:101 H264/90000
    `.trim();

    fs.writeFileSync(sdpPath, sdpContent);

    // Start FFmpeg to listen on port 5004
    const ffmpegArgs = [
      "-protocol_whitelist", "file,udp,rtp",
      "-i", path.join(hlsDir, "video.sdp"),
      "-c:v", "copy",
      "-an",
      "-f", "hls",
      "-hls_time", "2",
      "-hls_list_size", "10",
      "-hls_flags", "delete_segments",
      "-y",
      path.join(hlsDir, "stream.m3u8"),
    ];


    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

    currentSession = {
      transport: plainTransport,
      consumer,
      ffmpegProcess,
    };

    ffmpegProcess.stderr.on("data", (data: Buffer) => {
      const output = data.toString();
      if (output.toLowerCase().includes("error")) {
        console.error(`FFmpeg error: ${output}`);
      } else {
        console.log(`FFmpeg log: ${output}`);
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

export async function stopFFmpeg() {
  if (currentSession) {
    await cleanupSession(currentSession);
    currentSession = null;
    console.log("Streaming stopped");
  }
}
