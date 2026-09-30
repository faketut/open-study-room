/** Performance tier preferences persisted to localStorage.
 *
 *  Three tiers (`high | balanced | battery`) gate frame-rate, device pixel
 *  ratio, and cosmetic effects on the touch/mobile path (see
 *  `web/docs/touch-controls-spec.md` §6). Kept in `domain/` so it can be
 *  unit-tested with a mocked storage, mirroring `viewPrefs.ts`.
 */

export type PerfTier = "high" | "balanced" | "battery";

export const PERF_KEY = "syncle.perf";

export function parsePerfTier(raw: string | null): PerfTier {
  return raw === "high" || raw === "balanced" || raw === "battery"
    ? raw
    : "balanced";
}

/** Navigator bits relevant to auto tier selection. Injected so tests can
 *  drive the branches without a real browser. */
export interface PerfEnvironment {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  saveData?: boolean;
}

/** Pick the default tier from device capability. Spec (§6):
 *  - hardwareConcurrency >= 6 && (deviceMemory ?? 4) >= 4 → high
 *  - Save-Data on → battery
 *  SSR-safe: no environment (undefined) → balanced. */
export function autoTier(env?: PerfEnvironment): PerfTier {
  if (!env) return "balanced";
  if (env.saveData) return "battery";
  const cores = env.hardwareConcurrency ?? 0;
  const mem = env.deviceMemory ?? 4;
  return cores >= 6 && mem >= 4 ? "high" : "balanced";
}

/** Live-environment adapter: build the PerfEnvironment from the global
 *  navigator. Kept separate from autoTier so pure logic stays testable.
 *  Safe when navigator is missing (SSR) → returns undefined → balanced. */
export function environmentFromNavigator(
  nav?: Navigator,
): PerfEnvironment | undefined {
  if (!nav) return undefined;
  const connection = (
    nav as Navigator & {
      connection?: { saveData?: boolean };
    }
  ).connection;
  return {
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: (nav as Navigator & { deviceMemory?: number }).deviceMemory,
    saveData: connection?.saveData ?? false,
  };
}

/** Storage shim. Browser code uses `localStorage`; tests pass a fake. */
export interface PerfStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Read the tier. A saved explicit value wins; otherwise fall back to the
 *  auto-selected tier (optionally informed by the real navigator). */
export function readPerfTier(
  storage: PerfStorage,
  env?: PerfEnvironment,
): PerfTier {
  try {
    const raw = storage.getItem(PERF_KEY);
    return raw === null ? autoTier(env) : parsePerfTier(raw);
  } catch {
    return autoTier(env);
  }
}

export function writePerfTier(storage: PerfStorage, tier: PerfTier): void {
  try {
    storage.setItem(PERF_KEY, tier);
  } catch {
    /* ignore quota/private-mode errors */
  }
}
