// 17-byte position packet shared with the server contract (docs/contracts.md).
//
// Packet layout (17 bytes, little-endian):
//   byte 0      : type tag (1 = position)
//   bytes 1..4  : x as float32
//   bytes 5..8  : y as float32
//   bytes 9..16 : seq as int64
//
// Any change here MUST be reflected in docs/contracts.md.

export const PACKET_TYPE_POSITION = 1 as const;
export const POSITION_PACKET_SIZE = 17 as const;

export interface PositionPacket {
  x: number;
  y: number;
  seq: bigint;
}

let nextSeqValue: bigint = 0n;

export function nextSeq(): bigint {
  const v = nextSeqValue;
  nextSeqValue = v + 1n;
  return v;
}

export function resetSeq(): void {
  nextSeqValue = 0n;
}

export function encodePosition(x: number, y: number, seq: bigint): Uint8Array {
  const buf = new ArrayBuffer(POSITION_PACKET_SIZE);
  const view = new DataView(buf);
  view.setUint8(0, PACKET_TYPE_POSITION);
  view.setFloat32(1, x, true);
  view.setFloat32(5, y, true);
  view.setBigInt64(9, seq, true);
  return new Uint8Array(buf);
}

export function decodePosition(data: Uint8Array): PositionPacket | null {
  if (data.length < POSITION_PACKET_SIZE) return null;
  if (data[0] !== PACKET_TYPE_POSITION) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    x: view.getFloat32(1, true),
    y: view.getFloat32(5, true),
    seq: view.getBigInt64(9, true),
  };
}
