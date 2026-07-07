import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as mediasoup from "mediasoup";
import * as path from "path";

interface StreamingInput {
  transport: mediasoup.types.PlainTransport;
  consumer: mediasoup.types.Consumer;
  sdpPath: string;
  producerId: string;
}

interface StreamingSession {
  producerIds: string[];
  inputs: StreamingInput[];
  ffmpegProcess: ChildProcessWithoutNullStreams;
  stopping: boolean;
}

const hlsDir = path.join(__dirname, "..", "public", "hls");
const outputPath = path.join(hlsDir, "stream.m3u8");
const maxMixedStreams = 9;

let currentSession: StreamingSession | null = null;
let updateQueue: Promise<void> = Promise.resolve();

function cleanupHLSFiles(): void {
  try {
    if (!fs.existsSync(hlsDir)) {
      return;
    }

    fs.readdirSync(hlsDir).forEach((file) => {
      const filePath = path.join(hlsDir, file);

      if (
        file.endsWith(".ts") ||
        file.endsWith(".m3u8") ||
        file.endsWith(".sdp")
      ) {
        try {
          fs.unlinkSync(filePath);
        } catch (error) {
          console.warn(`Failed to remove HLS file ${file}:`, error);
        }
      }
    });
  } catch (error) {
    console.error("HLS cleanup failed:", error);
  }
}

async function createPlainTransport(
  router: mediasoup.types.Router,
): Promise<mediasoup.types.PlainTransport> {
  return router.createPlainTransport({
    listenIp: "127.0.0.1",
    rtcpMux: true,
    comedia: false,
  });
}

function generateSDP(
  rtpParameters: mediasoup.types.RtpParameters,
  port: number,
): string {
  const videoCodec = rtpParameters.codecs.find((codec) => {
    const mimeType = codec.mimeType.toLowerCase();
    return mimeType === "video/vp8" || mimeType === "video/h264";
  });

  if (!videoCodec) {
    throw new Error("No supported video codec found in RTP parameters");
  }

  const codecName = videoCodec.mimeType.split("/")[1].toUpperCase();
  const sdpLines = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=MediaSoup RTP Stream",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=video ${port} RTP/AVP ${videoCodec.payloadType}`,
    `a=rtpmap:${videoCodec.payloadType} ${codecName}/${videoCodec.clockRate}`,
    "a=recvonly",
    "a=rtcp-mux",
  ];

  if (videoCodec.parameters && Object.keys(videoCodec.parameters).length > 0) {
    const fmtpParams = Object.entries(videoCodec.parameters)
      .map(([key, value]) => `${key}=${value}`)
      .join(";");
    sdpLines.push(`a=fmtp:${videoCodec.payloadType} ${fmtpParams}`);
  }

  return sdpLines.join("\n");
}

function getVideoProducers(producers: Map<string, any[]>): any[] {
  return Array.from(producers.values())
    .flatMap((producerList) => producerList)
    .filter((producer: any) => producer.kind === "video" && !producer.closed)
    .slice(0, maxMixedStreams);
}

function haveSameProducers(currentIds: string[], nextIds: string[]): boolean {
  if (currentIds.length !== nextIds.length) {
    return false;
  }

  const current = [...currentIds].sort();
  const next = [...nextIds].sort();
  return current.every((id, index) => id === next[index]);
}

function buildMosaicFilter(inputCount: number): string {
  const outputWidth = 1280;
  const outputHeight = 720;
  const columns = Math.ceil(Math.sqrt(inputCount));
  const rows = Math.ceil(inputCount / columns);
  const cellWidth = Math.floor(outputWidth / columns);
  const cellHeight = Math.floor(outputHeight / rows);

  const scaledInputs = Array.from({ length: inputCount }, (_, index) => {
    return `[${index}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${index}]`;
  });

  if (inputCount === 1) {
    return `${scaledInputs[0]};[v0]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p[vout]`;
  }

  const labels = Array.from(
    { length: inputCount },
    (_, index) => `[v${index}]`,
  ).join("");
  const layout = Array.from({ length: inputCount }, (_, index) => {
    const x = (index % columns) * cellWidth;
    const y = Math.floor(index / columns) * cellHeight;
    return `${x}_${y}`;
  }).join("|");

  return `${scaledInputs.join(";")};${labels}xstack=inputs=${inputCount}:layout=${layout}:fill=black,format=yuv420p[vout]`;
}

async function cleanupSession(session: StreamingSession): Promise<void> {
  session.stopping = true;

  if (!session.ffmpegProcess.killed) {
    session.ffmpegProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  session.inputs.forEach(({ consumer, transport }) => {
    if (!consumer.closed) {
      consumer.close();
    }
    if (!transport.closed) {
      transport.close();
    }
  });

  cleanupHLSFiles();
}

async function stopCurrentSession(): Promise<void> {
  if (!currentSession) {
    return;
  }

  const session = currentSession;
  currentSession = null;
  await cleanupSession(session);
}

async function startFFmpegNow(
  router: mediasoup.types.Router,
  producers: Map<string, any[]>,
): Promise<void> {
  if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
  }

  const videoProducers = getVideoProducers(producers);
  const producerIds = videoProducers.map((producer) => producer.id);

  if (producerIds.length === 0) {
    await stopCurrentSession();
    return;
  }

  if (
    currentSession &&
    haveSameProducers(currentSession.producerIds, producerIds)
  ) {
    return;
  }

  await stopCurrentSession();
  cleanupHLSFiles();

  const inputs: StreamingInput[] = [];

  try {
    for (const [index, videoProducer] of videoProducers.entries()) {
      const transport = await createPlainTransport(router);
      const port = 5004 + index * 2;

      await transport.connect({
        ip: "127.0.0.1",
        port,
      });

      const consumer = await transport.consume({
        producerId: videoProducer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false,
      });

      const sdpPath = path.join(hlsDir, `video-${index}.sdp`);
      fs.writeFileSync(sdpPath, generateSDP(consumer.rtpParameters, port));

      inputs.push({
        transport,
        consumer,
        sdpPath,
        producerId: videoProducer.id,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    const ffmpegArgs = [
      ...inputs.flatMap(({ sdpPath }) => [
        "-protocol_whitelist",
        "file,udp,rtp",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-f",
        "sdp",
        "-i",
        sdpPath,
      ]),
      "-filter_complex",
      buildMosaicFilter(inputs.length),
      "-map",
      "[vout]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "baseline",
      "-level",
      "3.1",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "15",
      "-keyint_min",
      "15",
      "-sc_threshold",
      "0",
      "-an",
      "-f",
      "hls",
      "-hls_time",
      "1",
      "-hls_list_size",
      "6",
      "-hls_flags",
      "delete_segments+independent_segments",
      "-hls_start_number_source",
      "datetime",
      "-hls_allow_cache",
      "0",
      "-start_number",
      "0",
      "-y",
      outputPath,
    ];

    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);
    const session: StreamingSession = {
      producerIds,
      inputs,
      ffmpegProcess,
      stopping: false,
    };
    currentSession = session;

    ffmpegProcess.stderr.on("data", (data: Buffer) => {
      const output = data.toString();
      if (output.includes("error") || output.includes("Error")) {
        console.error(`FFmpeg Error: ${output.trim()}`);
      }
    });

    ffmpegProcess.on("error", (error: Error) => {
      console.error("FFmpeg process error:", error);
      if (currentSession === session) {
        currentSession = null;
      }
    });

    ffmpegProcess.on("exit", (code: number) => {
      console.log(`FFmpeg exited with code ${code}`);
      if (currentSession === session) {
        currentSession = null;
      }

      if (!session.stopping) {
        session.inputs.forEach(({ consumer, transport }) => {
          if (!consumer.closed) {
            consumer.close();
          }
          if (!transport.closed) {
            transport.close();
          }
        });
      }
    });
  } catch (error) {
    inputs.forEach(({ consumer, transport }) => {
      if (!consumer.closed) {
        consumer.close();
      }
      if (!transport.closed) {
        transport.close();
      }
    });
    throw error;
  }
}

export function startFFmpeg(
  router: mediasoup.types.Router,
  producers: Map<string, any[]>,
): Promise<void> {
  updateQueue = updateQueue
    .catch(() => undefined)
    .then(() => startFFmpegNow(router, producers));

  return updateQueue;
}

export function stopFFmpeg(): Promise<void> {
  updateQueue = updateQueue.catch(() => undefined).then(stopCurrentSession);
  return updateQueue;
}
