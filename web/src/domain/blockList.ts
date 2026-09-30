// Local block list (M2 T5 — client-only moderation).
//
// Contract: docs/contracts.md "Moderation (M2: stranger safety)" §5.
// Blocking is purely local: the blocked user is never notified, and the
// server knows nothing about it.
//
// Storage key: `syncle.blocked.<room>` (legacy `syncle` prefix per the
// naming freeze). Value: JSON array of blocked userId strings. Unblocking
// removes the id; the change takes effect immediately at every filter
// point (audio, chat, reactions), which read the list fresh.
//
// The functions take an explicit `storage` so they stay pure and testable;
// the module-level helpers below default to the real localStorage.

/** Key prefix verbatim per contract. */
export const BLOCK_STORAGE_KEY_PREFIX = "syncle.blocked." as const;

export function blockStorageKey(room: string): string {
  return `${BLOCK_STORAGE_KEY_PREFIX}${room}`;
}

/** Minimal storage surface (mirrors localStorage). Injected for tests. */
export interface BlockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function realStorage(): BlockStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Read the blocked identity set for a room. Corrupt payloads degrade to
 *  an empty set (a bad entry must never break the client). */
export function readBlockedIdentities(
  room: string,
  storage: BlockStorage | null = realStorage(),
): Set<string> {
  if (!storage || room.length === 0) return new Set();
  let raw: string | null = null;
  try {
    raw = storage.getItem(blockStorageKey(room));
  } catch {
    return new Set();
  }
  if (raw == null || raw.length === 0) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const out = new Set<string>();
    for (const v of parsed) {
      if (typeof v === "string" && v.length > 0) out.add(v);
    }
    return out;
  } catch {
    return new Set();
  }
}

function writeBlockedIdentities(
  room: string,
  ids: Set<string>,
  storage: BlockStorage | null = realStorage(),
): void {
  if (!storage || room.length === 0) return;
  try {
    storage.setItem(blockStorageKey(room), JSON.stringify(Array.from(ids)));
  } catch {
    /* storage unavailable; ignore */
  }
}

/** True when `identity` is on the room's local block list. */
export function isBlockedIdentity(
  room: string,
  identity: string,
  storage: BlockStorage | null = realStorage(),
): boolean {
  return readBlockedIdentities(room, storage).has(identity);
}

/** Add `identity` to the room's block list. Idempotent. */
export function blockIdentity(
  room: string,
  identity: string,
  storage: BlockStorage | null = realStorage(),
): void {
  if (identity.length === 0) return;
  const ids = readBlockedIdentities(room, storage);
  if (ids.has(identity)) return;
  ids.add(identity);
  writeBlockedIdentities(room, ids, storage);
}

/** Remove `identity` from the room's block list. Idempotent. */
export function unblockIdentity(
  room: string,
  identity: string,
  storage: BlockStorage | null = realStorage(),
): void {
  const ids = readBlockedIdentities(room, storage);
  if (!ids.delete(identity)) return;
  writeBlockedIdentities(room, ids, storage);
}
