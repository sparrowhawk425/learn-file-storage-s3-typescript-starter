import path from "node:path";

import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { rm } from "fs/promises";

const MAX_UPLOAD_SIZE = 1 << 30; //30GB

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Requested video not found");
  }
  if (userID !== video.userID) {
    throw new UserForbiddenError("User does not have permission to update this video");
  }
  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof Blob)) {
    throw new BadRequestError("Video file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(`Video file exceeds max size of ${MAX_UPLOAD_SIZE >> 30}GB`);
  }

  const mediaType = file.type;
  if (mediaType !== "video/mp4") {
    throw new BadRequestError("Video must be mp4");
  }
  
  const fileName = "temp.mp4";
  const filePath = path.join(cfg.assetsRoot, fileName);

  // Write temp files to disk (delete after s3 upload)
  await Bun.write(filePath, file);
  const aspectRatio = await getVideoAspectRatio(filePath);
  const processedFilePath = await processVideoForFastStart(filePath);

  const fileKey = `${aspectRatio}/${videoId}.mp4`;
  const s3File = cfg.s3Client.file(fileKey);
  await s3File.write(Bun.file(processedFilePath), { type: mediaType });
  video.videoURL = `https://${cfg.s3CfDistribution}/${fileKey}`;
  updateVideo(cfg.db, video);

  // Delete the temp files
  await rm(filePath, { force: true });
  await rm(processedFilePath, { force: true });

  return respondWithJSON(200, video);
}

type FileMetadata = {
  streams: [
    {
      width: number;
      height: number;
    }
  ]
}

async function getVideoAspectRatio(filePath: string): Promise<string> {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const exitCode = await proc.exited;
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new BadRequestError(stderrText);
  }
  const data = JSON.parse(stdoutText) as FileMetadata;
  const width = data.streams[0].width;
  const height = data.streams[0].height;
  
  if (width < height) {
    return "portrait";
  } else if (width > height) {
    return "landscape";
  }
  return "other";
}

async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const outputPath = `${inputFilePath}.processed`;
  const proc = Bun.spawn(["ffmpeg", "-i", inputFilePath, "-movflags", "faststart", "-map_metadata", "0",
    "-codec", "copy", "-f", "mp4", outputPath], {
      stderr: "pipe"
    });
  const exitCode = await proc.exited;
  const stderrText = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new BadRequestError(stderrText);
  }
  return outputPath;
}
