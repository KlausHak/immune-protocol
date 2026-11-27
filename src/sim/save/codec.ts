/**
 * JSON-safe encoding for simulation state. Handles Map, Set, typed arrays, Infinity/NaN/-0 and undefined
 * (inside arrays). Throws — with the path — on class instances and functions, so modules notice
 * unsaveable state in tests instead of silently losing it.
 */
const TYPED: Record<string, new (b: ArrayBufferLike) => ArrayBufferView> = {
  Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray,
};

function bytesToB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export function encode(v: unknown, path = '$'): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v === undefined) return { $t: 'u' };
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return Object.is(v, -0) ? { $t: 'n', v: '-0' } : v;
    return { $t: 'n', v: String(v) };
  }
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') throw new Error(`save codec: unsupported ${typeof v} at ${path}`);
  if (Array.isArray(v)) return v.map((x, i) => encode(x, `${path}[${i}]`));
  if (v instanceof Map) return { $t: 'Map', v: [...v.entries()].map(([k, x], i) => [encode(k, `${path}<key${i}>`), encode(x, `${path}<${String(k)}>`)]) };
  if (v instanceof Set) return { $t: 'Set', v: [...v].map((x, i) => encode(x, `${path}{${i}}`)) };
  if (ArrayBuffer.isView(v)) {
    const name = v.constructor.name;
    if (!TYPED[name]) throw new Error(`save codec: unsupported view ${name} at ${path}`);
    return { $t: 'ta', c: name, v: bytesToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new Error(`save codec: class instance (${(v as object).constructor?.name}) at ${path} — store plain data or ids`);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === undefined) continue; // optional fields: absent == undefined
    out[k] = encode(x, `${path}.${k}`);
  }
  if ('$t' in out) throw new Error(`save codec: reserved key "$t" at ${path}`);
  return out;
}

export function decode(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decode);
  const o = v as Record<string, unknown>;
  switch (o.$t) {
    case 'u': return undefined;
    case 'n': return o.v === '-0' ? -0 : Number(o.v);
    case 'Map': return new Map((o.v as unknown[][]).map(([k, x]) => [decode(k), decode(x)]));
    case 'Set': return new Set((o.v as unknown[]).map(decode));
    case 'ta': {
      const bytes = b64ToBytes(o.v as string);
      const Ctor = TYPED[o.c as string]!;
      return new Ctor(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    default: {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) out[k] = decode(x);
      return out;
    }
  }
}
