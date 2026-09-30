/** M3 T10 — formatting helpers for the focus stats panel.
 *
 * Kept next to `FocusStatsPanel.tsx` on purpose: the timer worker owns
 * `web/src/domain/pomodoro.ts`, so UI formatting lives here to avoid
 * cross-worker file conflicts. Pure functions — covered by unit tests in
 * `./__tests__/focusStatsFormat.test.ts`. */

/** Seconds → Chinese duration: 3661 → "1小时1分", 1500 → "25分",
 *  3600 → "1小时", 0/negative → "0分". Rounds down to whole minutes. */
export function formatDurationZh(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`;
  return `${m}分`;
}

/** Server day string "YYYY-MM-DD" → short axis label "9/29". Returns the
 *  input unchanged when it doesn't match the expected shape. */
export function formatBarDayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
}

/** Bar heights as percentages of the tallest bar. Zero-max input yields
 *  all-zero; non-zero days get at least 2% so they stay visible. */
export function barHeights(seconds: number[]): number[] {
  const max = seconds.length > 0 ? Math.max(...seconds) : 0;
  if (max <= 0) return seconds.map(() => 0);
  return seconds.map((s) => Math.max(2, Math.round((s / max) * 100)));
}
