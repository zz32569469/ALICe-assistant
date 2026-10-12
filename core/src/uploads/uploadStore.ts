// §83 截圖：Studio 貼上或拖進來的圖片存在本機 data/uploads（不進 git），訊息只記檔名；ALICe 回覆時用 Read 工具看這個資料夾。

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 一則訊息最多附幾張。 */
export const MAX_MESSAGE_IMAGES = 6;

const TYPES: Record<string, { ext: string; magic: (bytes: Buffer) => boolean }> = {
  "image/png": { ext: "png", magic: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: "jpg", magic: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  "image/webp": { ext: "webp", magic: (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP" },
  "image/gif": { ext: "gif", magic: (bytes) => bytes.subarray(0, 4).toString("latin1") === "GIF8" },
};
const CONTENT_TYPE: Record<string, string> = Object.fromEntries(Object.entries(TYPES).map(([type, { ext }]) => [ext, type]));
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/u;

export class UploadError extends Error {}

export const uploadsDir = (dataDir: string): string => resolve(dataDir, "uploads");
export const isUploadName = (name: string): boolean => NAME.test(name);

/** 存一張圖，回傳檔名。只收 png、jpeg、webp、gif，而且檔頭要對得上宣告的格式。 */
export function saveUpload(dir: string, bytes: Buffer, contentType: string): string {
  const type = TYPES[contentType.split(";")[0]!.trim().toLowerCase()];
  if (type === undefined) throw new UploadError("只收 PNG、JPEG、WebP、GIF 圖片");
  if (bytes.length === 0) throw new UploadError("圖片是空的");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadError(`圖片最大 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  if (!type.magic(bytes)) throw new UploadError("檔案內容不是宣告的圖片格式");
  mkdirSync(dir, { recursive: true });
  const name = `${randomUUID()}.${type.ext}`;
  writeFileSync(resolve(dir, name), bytes);
  return name;
}

export function readUpload(dir: string, name: string): { bytes: Buffer; contentType: string } | undefined {
  if (!isUploadName(name)) return undefined;
  const path = resolve(dir, name);
  if (!existsSync(path)) return undefined;
  return { bytes: readFileSync(path), contentType: CONTENT_TYPE[name.split(".").pop()!]! };
}

export const uploadExists = (dir: string, name: string): boolean => isUploadName(name) && existsSync(resolve(dir, name));
