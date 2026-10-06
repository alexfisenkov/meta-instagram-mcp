const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

export interface NativeFrameDecoderOptions {
  maxFrameBytes?: number;
}

/** Incremental Chrome Native Messaging decoder (little-endian uint32 byte length + UTF-8 JSON). */
export class NativeFrameDecoder {
  private pending = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(options: NativeFrameDecoderOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isInteger(this.maxFrameBytes) || this.maxFrameBytes < 1 || this.maxFrameBytes > DEFAULT_MAX_FRAME_BYTES) {
      throw new Error("invalid native message frame size limit");
    }
  }

  push(chunk: Uint8Array): unknown[] {
    if (!(chunk instanceof Uint8Array)) throw new Error("native message chunk must be bytes");
    if (chunk.byteLength) this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const messages: unknown[] = [];
    try {
      while (this.pending.byteLength >= 4) {
        const length = this.pending.readUInt32LE(0);
        if (length > this.maxFrameBytes) throw new Error("native message exceeds size limit");
        if (this.pending.byteLength < 4 + length) break;
        const bytes = this.pending.subarray(4, 4 + length);
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { throw new Error("native message is not valid UTF-8"); }
        try { messages.push(JSON.parse(text) as unknown); }
        catch { throw new Error("native message is not valid JSON"); }
        this.pending = this.pending.subarray(4 + length);
      }
      return messages;
    } catch (error) {
      this.pending = Buffer.alloc(0);
      throw error;
    }
  }
}

export function encodeNativeFrame(value: unknown, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > DEFAULT_MAX_FRAME_BYTES) {
    throw new Error("invalid native message frame size limit");
  }
  let json: string | undefined;
  try { json = JSON.stringify(value); }
  catch { throw new Error("native message is not JSON serializable"); }
  if (json === undefined) throw new Error("native message is not JSON serializable");
  const payload = Buffer.from(json, "utf8");
  if (payload.byteLength > maxFrameBytes) throw new Error("native message exceeds size limit");
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}
