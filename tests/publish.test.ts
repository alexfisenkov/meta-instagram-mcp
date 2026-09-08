import { describe, expect, it, vi } from "vitest";
import type { MetaInstagramConfig } from "../src/config.js";
import type { MetaClient } from "../src/meta-client.js";
import { createPublishHandlers } from "../src/publish.js";
import type { PublishRecord } from "../src/publish-journal.js";

/**
 * Шов истории 29а: контейнер и публикация. Проверяем ровно то, что обещано
 * наружу, — что публикует, что отказывает и что попадает в журнал; сеть
 * подменена, потому что настоящий вызов Meta необратим.
 */
function setup(overrides: Partial<MetaInstagramConfig> = {}) {
  const post = vi.fn();
  const get = vi.fn();
  const records: PublishRecord[] = [];
  const config: MetaInstagramConfig = {
    authMode: "instagram",
    graphApiVersion: "v25.0",
    tokenStorePath: "/tmp/token.json",
    publishLogPath: "/tmp/publish-log.jsonl",
    ...overrides
  };
  const handlers = createPublishHandlers({
    config,
    resolveToken: async () => ({ accessToken: "env-token", authMode: "instagram", userId: "ig-user" }),
    makeClient: () => ({ get, post } as unknown as MetaClient),
    resolveUserId: (args, resolved) => args.userId ?? resolved.userId ?? "me",
    journal: async (record) => {
      records.push(record);
    }
  });
  return { handlers, post, get, records };
}

describe("meta_publish_media guards", () => {
  it("refuses without META_INSTAGRAM_WRITE and publishes nothing", async () => {
    const { handlers, post, records } = setup();

    await expect(handlers.publishMedia({ creationId: "c-1", confirm: true }))
      .rejects.toThrow(/META_INSTAGRAM_WRITE/);
    expect(post).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it("refuses without confirm even when the environment allows writes", async () => {
    const { handlers, post, records } = setup({ writeEnabled: true });

    await expect(handlers.publishMedia({ creationId: "c-1" })).rejects.toThrow(/confirm/);
    expect(post).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it("refuses an empty creationId", async () => {
    const { handlers, post } = setup({ writeEnabled: true });

    await expect(handlers.publishMedia({ creationId: "  ", confirm: true })).rejects.toThrow(/creationId/);
    expect(post).not.toHaveBeenCalled();
  });

  it("publishes and journals both the attempt and the result", async () => {
    const { handlers, post, records } = setup({ writeEnabled: true });
    post.mockResolvedValue({ id: "media-9" });

    const result = await handlers.publishMedia({ creationId: "c-1", confirm: true });

    expect(post).toHaveBeenCalledWith("/ig-user/media_publish", { creation_id: "c-1" });
    expect(result).toMatchObject({ published: true, mediaId: "media-9", containerId: "c-1" });
    expect(records.map((record) => record.event)).toEqual(["attempt", "published"]);
  });

  it("journals a failed publish and rethrows", async () => {
    const { handlers, post, records } = setup({ writeEnabled: true });
    post.mockRejectedValue(new Error("Meta Graph API error 400: bad container"));

    await expect(handlers.publishMedia({ creationId: "c-1", confirm: true })).rejects.toThrow(/bad container/);
    expect(records.map((record) => record.event)).toEqual(["attempt", "failed"]);
    expect(records[1].reason).toContain("bad container");
  });
});

describe("meta_create_media_container", () => {
  it("creates an image container, reads its status and publishes nothing", async () => {
    const { handlers, post, get, records } = setup();
    post.mockResolvedValue({ id: "container-1" });
    get.mockResolvedValue({ id: "container-1", status_code: "FINISHED", status: "Finished" });

    const result = await handlers.createMediaContainer({
      imageUrl: "https://example.com/a.jpg",
      caption: "подпись"
    });

    expect(post).toHaveBeenCalledWith("/ig-user/media", {
      image_url: "https://example.com/a.jpg",
      caption: "подпись"
    });
    expect(get).toHaveBeenCalledWith("/container-1", { fields: "id,status_code,status" });
    expect(result).toMatchObject({
      containerId: "container-1",
      mediaType: "IMAGE",
      statusCode: "FINISHED",
      published: false
    });
    expect(records).toEqual([]);
  });

  it("defaults a video container to REELS", async () => {
    const { handlers, post, get } = setup();
    post.mockResolvedValue({ id: "container-2" });
    get.mockResolvedValue({ id: "container-2", status_code: "IN_PROGRESS" });

    const result = await handlers.createMediaContainer({ videoUrl: "https://example.com/a.mp4", checkStatus: true });

    expect(post).toHaveBeenCalledWith("/ig-user/media", {
      video_url: "https://example.com/a.mp4",
      media_type: "REELS"
    });
    expect(result.mediaType).toBe("REELS");
  });

  it("skips the status read when checkStatus is false", async () => {
    const { handlers, post, get } = setup();
    post.mockResolvedValue({ id: "container-3" });

    const result = await handlers.createMediaContainer({
      imageUrl: "https://example.com/a.jpg",
      checkStatus: false
    });

    expect(get).not.toHaveBeenCalled();
    expect(result.statusCode).toBeUndefined();
    expect(result.status).toBeUndefined();
  });

  it.each([
    [{}, /exactly one of imageUrl or videoUrl/],
    [{ imageUrl: "https://a/b.jpg", videoUrl: "https://a/b.mp4" }, /exactly one of imageUrl or videoUrl/],
    [{ imageUrl: "file:///etc/passwd" }, /http\(s\) URL/],
    [{ imageUrl: "not-a-url" }, /absolute public URL/],
    [{ videoUrl: "https://a/b.mp4", mediaType: "IMAGE" as const }, /REELS or STORIES/],
    [{ imageUrl: "https://a/b.jpg", mediaType: "VIDEO" as any }, /mediaType must be one of/]
  ])("rejects bad media arguments %#", async (args, message) => {
    const { handlers, post } = setup();

    await expect(handlers.createMediaContainer(args)).rejects.toThrow(message);
    expect(post).not.toHaveBeenCalled();
  });
});
