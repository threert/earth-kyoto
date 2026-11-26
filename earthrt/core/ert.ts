// ERT tile files (SPEC § 4): a JSON header and typed chunks. Reading takes no copies: a chunk is a view of the file.
// Runs in QuickJS (the client's script), V8 (the web, the Worker) and Bun (tools): no TextDecoder required.

export type ChunkType = "u8" | "i8" | "u16" | "i16" | "u32" | "f32" | "f64";
export type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Float32Array | Float64Array;

export interface ErtHeader {
  v: 1;
  layer: "terrain" | "buildings" | "mesh";
  key: string;
  enc: "compact" | "expanded";
  center: [number, number, number];
  radius: number;
  minH?: number;
  maxH?: number;
  n?: number;
  skirt?: number;
  count?: number;
  chunks: Record<string, { type: ChunkType; offset: number; count: number }>;
  src?: string[];
  [extra: string]: unknown;
}

export interface Ert {
  header: ErtHeader;
  chunks: Record<string, TypedArray>;
}

const CTOR = { u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, f32: Float32Array, f64: Float64Array } as const;
const typeOf = (a: TypedArray): ChunkType =>
  a instanceof Uint8Array ? "u8" : a instanceof Int8Array ? "i8" : a instanceof Uint16Array ? "u16" : a instanceof Int16Array ? "i16" : a instanceof Uint32Array ? "u32" : a instanceof Float32Array ? "f32" : "f64";

const MAGIC = [0x45, 0x52, 0x54, 0x31]; // "ERT1"
const pad8 = (n: number) => (n + 7) & ~7;

function ascii(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 4096)));
  return s;
}

/** JSON with every non-ASCII character escaped. */
function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Writes an ERT file. `header.chunks` is filled in from `chunks`. */
export function encodeErt(header: Omit<ErtHeader, "chunks">, chunks: Record<string, TypedArray>): Uint8Array {
  const table: ErtHeader["chunks"] = {};
  let body = 0;
  for (const [name, a] of Object.entries(chunks)) {
    table[name] = { type: typeOf(a), offset: body, count: a.length };
    body = pad8(body + a.byteLength);
  }
  const json = asciiJson({ ...header, chunks: table });
  const L = pad8(json.length);
  const out = new Uint8Array(8 + L + body);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, L, true);
  for (let i = 0; i < L; i++) out[8 + i] = i < json.length ? json.charCodeAt(i) : 0x20;
  for (const [name, a] of Object.entries(chunks)) out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), 8 + L + table[name].offset);
  return out;
}

/** Reads the header alone (from the first bytes of a file: 8 + L). */
export function readErtHeader(buf: ArrayBuffer | Uint8Array): { header: ErtHeader; bodyAt: number } {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] !== MAGIC[0] || u8[1] !== MAGIC[1] || u8[2] !== MAGIC[2] || u8[3] !== MAGIC[3]) throw new Error("not an ERT1 file");
  const L = new DataView(u8.buffer, u8.byteOffset, 8).getUint32(4, true);
  const header = JSON.parse(ascii(u8.subarray(8, 8 + L))) as ErtHeader;
  if (header.v !== 1) throw new Error(`ERT version ${header.v} is newer than this reader`);
  return { header, bodyAt: 8 + L };
}

/** Reads an ERT file; chunks are views of `buf` (aligned: the body starts at a multiple of 8 when `buf` does). */
export function decodeErt(buf: ArrayBuffer | Uint8Array): Ert {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const { header, bodyAt } = readErtHeader(u8);
  let base = u8.byteOffset + bodyAt;
  let ab: ArrayBuffer = u8.buffer as ArrayBuffer;
  if (base % 8) {
    // (unaligned in the buffer it came in: copy once)
    const copy = new Uint8Array(u8.byteLength - bodyAt);
    copy.set(u8.subarray(bodyAt));
    ab = copy.buffer;
    base = 0;
  }
  const chunks: Record<string, TypedArray> = {};
  for (const [name, c] of Object.entries(header.chunks)) {
    const C = CTOR[c.type];
    chunks[name] = new C(ab, base + c.offset, c.count);
  }
  return { header, chunks };
}

/** Packs ERT files (SPEC § 4, "Packs"). */
export function encodeErp(files: Uint8Array[]): Uint8Array {
  let size = 8;
  for (const f of files) size += 4 + 4 + pad8(f.byteLength);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set([0x45, 0x52, 0x50, 0x31], 0);
  dv.setUint32(4, files.length, true);
  let at = 8;
  for (const f of files) {
    dv.setUint32(at, f.byteLength, true);
    // (a u32 of padding keeps each file's start at a multiple of 8)
    at += 8;
    out.set(f, at);
    at += pad8(f.byteLength);
  }
  return out;
}

export function decodeErp(buf: ArrayBuffer | Uint8Array): Uint8Array[] {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] !== 0x45 || u8[1] !== 0x52 || u8[2] !== 0x50 || u8[3] !== 0x31) throw new Error("not an ERP1 pack");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(4, true);
  const out: Uint8Array[] = [];
  let at = 8;
  for (let i = 0; i < n; i++) {
    const len = dv.getUint32(at, true);
    at += 8;
    out.push(u8.subarray(at, at + len));
    at += pad8(len);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ normals, octahedral

/** A unit vector as two signed bytes (octahedral). */
export function octEncode(x: number, y: number, z: number, out: Int8Array, at: number) {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / l1, v = y / l1;
  if (z < 0) {
    const ou = u;
    u = (1 - Math.abs(v)) * (ou >= 0 ? 1 : -1);
    v = (1 - Math.abs(ou)) * (v >= 0 ? 1 : -1);
  }
  out[at] = Math.round(Math.max(-1, Math.min(1, u)) * 127);
  out[at + 1] = Math.round(Math.max(-1, Math.min(1, v)) * 127);
}

export function octDecode(a: number, b: number, out: Float32Array, at: number) {
  let x = a / 127, y = b / 127;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  const l = Math.hypot(x, y, z) || 1;
  out[at] = x / l; out[at + 1] = y / l; out[at + 2] = z / l;
}

/** sRGB byte → linear. */
const SRGB = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export const srgbToLinear = (b: number) => SRGB[b];
