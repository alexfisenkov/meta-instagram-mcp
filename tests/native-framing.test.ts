import { describe, expect, it } from "vitest";
import { NativeFrameDecoder, encodeNativeFrame } from "../src/companion/native-framing.js";

describe("Native Messaging framing", () => {
  it("round-trips UTF-8 JSON and accepts partial frames", () => {
    const frame = encodeNativeFrame({ text: "Привет 👋" });
    const decoder = new NativeFrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([{ text: "Привет 👋" }]);
  });

  it("decodes consecutive frames", () => {
    const decoder = new NativeFrameDecoder();
    expect(decoder.push(Buffer.concat([encodeNativeFrame({ n: 1 }), encodeNativeFrame({ n: 2 })])))
      .toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("rejects oversized, invalid UTF-8, and invalid JSON frames", () => {
    const decoder = new NativeFrameDecoder({ maxFrameBytes: 4 });
    expect(() => decoder.push(Buffer.from([5, 0, 0, 0, 0]))).toThrow(/size limit/);
    expect(() => new NativeFrameDecoder().push(Buffer.from([1, 0, 0, 0, 0xff]))).toThrow(/UTF-8/);
    expect(() => new NativeFrameDecoder().push(Buffer.from([1, 0, 0, 0, 0x7b]))).toThrow(/JSON/);
  });

  it("only encodes JSON values within the configured limit", () => {
    expect(encodeNativeFrame({ ok: true })).toEqual(Buffer.from([11, 0, 0, 0, ...Buffer.from('{"ok":true}') ]));
    expect(() => encodeNativeFrame({ text: "large" }, 3)).toThrow(/size limit/);
    expect(() => encodeNativeFrame(undefined)).toThrow(/JSON/);
  });
});
