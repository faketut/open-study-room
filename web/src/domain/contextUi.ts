// Contextual UI state machine — contracts.md "Layout & contextual UI" §2.
//
// RPG rule: no buttons by default. The bottom bar shows exactly one "suite"
// picked by the pure function `contextSuiteFor(state)`. PTT (silent zone) is
// orthogonal and may co-render with any suite.
//
// Priority (normative):
//   1. seated              → "meeting"  (mic / cam / share / meeting-view / leave)
//   2. nearbyBoard/Note     → "object"   (F 打开 / touch "打开"; board wins)
//   3. nearbyTable          → "sit"      (E 坐下 / touch "坐下")
//   4. nearbyPerson         → "person"   (peer card + 屏蔽/举报)
//   5. idle                → nothing
// PTT: today's PttButton + Space hint, unchanged, may co-render.

import { interactActionFor, type TouchAction } from "./touchActions";

/** Bottom-bar suite selected by `contextSuiteFor`. */
export type ContextSuite =
  | "meeting"
  | "object"
  | "sit"
  | "person"
  | "idle";

/** Everything `contextSuiteFor` needs; owned by the coordinator
 *  (SyncleScreen) which already tracks each of these. */
export interface ContextState {
  /** `self.tableId != null`. */
  seated: boolean;
  /** Nearest board object index, if any. */
  nearbyBoardIndex: number | null;
  /** Nearest note object index, if any. */
  nearbyNoteIndex: number | null;
  /** Nearest joinable table id, if any. */
  nearbyTable: string | null;
  /** Identity of the nearest peer within `NEARBY_PERSON_RADIUS`, if any.
   *  Only consulted when no suite 1–3 is active. */
  nearbyPersonIdentity: string | null;
  /** `zoneKind === "silent"`. Orthogonal — never changes the suite. */
  silentZone: boolean;
}

/** Pick the bottom-bar suite for the current context. Pure. */
export function contextSuiteFor(state: ContextState): ContextSuite {
  if (state.seated) return "meeting";
  if (state.nearbyBoardIndex != null || state.nearbyNoteIndex != null) {
    return "object";
  }
  if (state.nearbyTable != null) return "sit";
  if (state.nearbyPersonIdentity != null) return "person";
  return "idle";
}

/** Interaction radius (world units) for the person suite: a peer this close
 *  or closer surfaces their card when no suite 1–3 is active. */
export const NEARBY_PERSON_RADIUS = 96;

export interface PeerPoint {
  identity: string;
  x: number;
  y: number;
}

/** Nearest peer within `radius` of (selfX, selfY); null when none in range.
 *  Pure — the coordinator calls it from its proximity scan. */
export function nearestPeerWithinRadius(
  selfX: number,
  selfY: number,
  peers: Iterable<PeerPoint>,
  radius: number = NEARBY_PERSON_RADIUS,
): { identity: string; distance: number } | null {
  let best: { identity: string; distance: number } | null = null;
  for (const p of peers) {
    const distance = Math.hypot(p.x - selfX, p.y - selfY);
    if (distance <= radius && (best == null || distance < best.distance)) {
      best = { identity: p.identity, distance };
    }
  }
  return best;
}

/** Desktop key hint for a suite. Touch uses the TouchActionBar button /
 *  person-card buttons instead, so suites without a key return null. */
export interface SuiteKeyHint {
  key: string;
  label: string;
}

export function desktopHintFor(suite: ContextSuite): SuiteKeyHint | null {
  switch (suite) {
    case "meeting":
      return { key: "E", label: "起身" };
    case "object":
      return { key: "F", label: "打开" };
    case "sit":
      return { key: "E", label: "坐下" };
    case "person":
    case "idle":
      return null;
  }
}

/** Touch/desktop parity (contract requirement): the touch action comes from
 *  the same context state via the existing `interactActionFor` — the F/E-key
 *  equivalent — so both platforms agree on suites 1–3. The person and idle
 *  suites have no touch action (the person suite is driven by card buttons). */
export function touchActionFor(state: ContextState): TouchAction | null {
  return interactActionFor({
    nearbyBoardIndex: state.nearbyBoardIndex,
    nearbyNoteIndex: state.nearbyNoteIndex,
    nearbyTable: state.nearbyTable,
    seated: state.seated,
  });
}
