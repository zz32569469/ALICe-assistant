import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { imageNote } from "../src/prompt/promptBuilder.js";
import { MessageStore } from "../src/store/messageStore.js";
import { UploadError, isUploadName, readUpload, saveUpload, uploadExists } from "../src/uploads/uploadStore.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("§83 存截圖：只收圖片、檔頭要對；檔名只認 uuid＋副檔名", () => {
  const dir = mkdtempSync(join(tmpdir(), "alice-upload-"));
  try {
    const name = saveUpload(dir, PNG, "image/png");
    assert.equal(isUploadName(name), true);
    assert.deepEqual(readUpload(dir, name), { bytes: PNG, contentType: "image/png" });
    assert.equal(uploadExists(dir, name), true);
    assert.throws(() => saveUpload(dir, PNG, "image/jpeg"), UploadError);
    assert.throws(() => saveUpload(dir, Buffer.from("hello"), "text/plain"), /只收/u);
    assert.throws(() => saveUpload(dir, Buffer.alloc(0), "image/png"), /空的/u);
    assert.equal(readUpload(dir, "../alice.db"), undefined);
    assert.equal(uploadExists(dir, "00000000-0000-0000-0000-000000000000.png"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§83 訊息記住附圖；提示裡給 ALICe 圖片路徑", () => {
  const dir = mkdtempSync(join(tmpdir(), "alice-upload-"));
  const store = new MessageStore(join(dir, "alice.db"));
  try {
    const message = store.append({ role: "user", text: "看這張", images: ["a.png"], thread: "chat" });
    assert.deepEqual(message.images, ["a.png"]);
    assert.deepEqual(store.list({ thread: "chat" })[0]!.images, ["a.png"]);
    assert.equal(store.append({ role: "user", text: "沒圖" }).images, undefined);
    assert.match(imageNote(["a.png", "b.png"], "C:\\data\\uploads", true), /主人附了 2 張截圖，請先用 Read 工具逐張看過再回答：C:\/data\/uploads\/a.png、C:\/data\/uploads\/b.png/u);
    assert.equal(imageNote(["a.png"], "C:/data/uploads"), "（附圖：C:/data/uploads/a.png）");
    assert.equal(imageNote(undefined, "C:/x"), "");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
