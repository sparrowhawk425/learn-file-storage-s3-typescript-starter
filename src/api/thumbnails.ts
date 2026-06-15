import path from "node:path";
import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { randomBytes } from "node:crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const MAX_UPLOAD_SIZE = 10 << 20;

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(`Thumbnail file exceeds max size of ${MAX_UPLOAD_SIZE >> 20}MB`);
  }
  const mediaType = file.type;
  const mediaParts = mediaType.split("/");
  if (mediaParts.length < 2 && mediaParts[0] !== "image") {
    throw new BadRequestError(`Invalid thumbnail file format ${mediaType}`);
  }
  const fileExt = mediaParts[1];
  if (!(fileExt === "png" || fileExt === "jpeg")) {
    throw new BadRequestError(`Invalid thumbnail file format ${mediaType}`);
  }
  const buffer = randomBytes(32);
  const randName = buffer.toString("base64");
  const fileName = `${randName}.${fileExt}`;
  const filePath = path.join(cfg.assetsRoot, fileName);

  const data = await file.arrayBuffer();
  await Bun.write(filePath, data);
  
  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Requested video not found");
  }
  if (userID !== video.userID) {
    throw new UserForbiddenError("User does not have permission to update this video");
  }

  const thumbnailUrl = `http://localhost:${cfg.port}/assets/${fileName}`;
  video.thumbnailURL = thumbnailUrl;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
