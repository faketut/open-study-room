// Pure exponential back-off with jitter for LiveKit reconnect attempts.
//
// attempt 1 -> ~1s
// attempt 2 -> ~2s
// attempt 3 -> ~4s
// ...
// attempts >= 6 -> capped at MAX_MS (30s).
//
// Jitter is ±JITTER_RATIO * base so two clients that drop at the same
// instant don't thunder back into the server in lockstep.

export const BASE_MS = 1_000;
export const MAX_MS = 30_000;
export const MAX_ATTEMPTS = 10;
export const JITTER_RATIO = 0.25;

/**
 * Returns the delay (in milliseconds) before reconnect `attempt` should fire.
 * `attempt` is 1-based: the first retry is attempt=1.
 *
 * `random` is in `[0, 1)`; pass an explicit value for deterministic tests.
 */
export function delayMsForAttempt(
  attempt: number,
  random: number = Math.random(),
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be an integer >= 1, got ${attempt}`);
  }
  const capped = Math.min(attempt, 6); // 2^6 = 64s but we clamp via MAX_MS
  const base = BASE_MS << (capped - 1); // 1s, 2s, 4s, 8s, 16s, 32s
  const clamped = Math.min(base, MAX_MS); // -> 30s ceiling
  // Symmetric jitter in [-1, +1) * JITTER_RATIO * clamped.
  const jitter = (random * 2 - 1) * JITTER_RATIO * clamped;
  return Math.max(0, Math.trunc(clamped + jitter));
}

export function shouldGiveUp(attempt: number): boolean {
  return attempt > MAX_ATTEMPTS;
}
