import type { PerfTier } from "../domain/perfPrefs";

/**
 * Performance-tier picker (touch-controls-spec §6): three tiers —
 * 流畅 (high) / 均衡 (balanced) / 省电 (battery).
 *
 * Controlled component: `tier` is the current value (from
 * `readPerfTier(localStorage)`), `onChange` persists via
 * `writePerfTier(localStorage, tier)` and applies the tier to the app.
 *
 * There is currently no gear/settings menu in SyncleScreen; drop this
 * component into a HUD dropdown/panel (see W4 report for mount suggestion).
 */
export interface PerfSettingsProps {
  tier: PerfTier;
  onChange: (tier: PerfTier) => void;
}

const OPTIONS: { value: PerfTier; label: string; hint: string }[] = [
  {
    value: "high",
    label: "流畅",
    hint: "60 fps · full DPR · all effects",
  },
  {
    value: "balanced",
    label: "均衡",
    hint: "60 fps · DPR ≤ 2 · reduced effects",
  },
  {
    value: "battery",
    label: "省电",
    hint: "30 fps · DPR ≤ 1.5 · no float/shadow FX",
  },
];

export function PerfSettings({ tier, onChange }: PerfSettingsProps) {
  return (
    <fieldset className="perf-settings" style={{ border: "none", margin: 0, padding: 0 }}>
      <legend
        style={{ fontSize: 12, fontWeight: 600, opacity: 0.75, marginBottom: 6 }}
      >
        性能 Performance
      </legend>
      <div role="radiogroup" aria-label="Performance tier">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              borderRadius: 8,
              cursor: "pointer",
              background:
                tier === opt.value ? "rgba(255,255,255,0.08)" : "transparent",
            }}
          >
            <input
              type="radio"
              name="syncle-perf-tier"
              value={opt.value}
              checked={tier === opt.value}
              onChange={() => onChange(opt.value)}
            />
            <span style={{ fontSize: 14 }}>
              <strong>{opt.label}</strong>
              <span style={{ opacity: 0.6, marginLeft: 8, fontSize: 12 }}>
                {opt.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
