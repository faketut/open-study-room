import { useState } from "react";
import { bucketByZone, zoneAllowsAudio, zonesOf, ZONE_KIND_LABELS } from "../domain/zones";
import type { ZoneKind } from "../domain/zones";
import { LOCAL_CHAT_IDENTITY, useSyncle } from "../state/syncleStore";

/** "Who's where" sidebar. Lists every zone in the current map with the
 *  avatars currently inside it. Collapsed state persists in localStorage so
 *  reloads remember the user's preference. Hidden entirely when the map has
 *  no zones. */
const COLLAPSED_KEY = "syncle.whosWhereCollapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function WhosWherePanel() {
  const map = useSyncle((s) => s.map);
  const self = useSyncle((s) => s.self);
  const peerCount = useSyncle((s) => s.peers.size);
  // Re-subscribe to peer positions cheaply: only re-render when the count or
  // the joined position signature changes. (rAF on the canvas drives smooth
  // motion; this panel only needs to update when a bucket changes.)
  const positionSig = useSyncle((s) => {
    let sig = `${self?.x ?? 0},${self?.y ?? 0}|`;
    for (const [k, p] of s.peers) sig += `${k}:${Math.round(p.x / 16)},${Math.round(p.y / 16)};`;
    return sig;
  });
  // Reference positionSig so the linter doesn't strip it; the subscription
  // itself triggers the re-render.
  void positionSig;
  const [collapsed, setCollapsed] = useState(readCollapsed);

  if (!map || !self) return null;
  const zones = zonesOf(map);
  if (zones.length === 0) return null;

  const peers = useSyncle.getState().peers;
  const avatars = [
    {
      identity: LOCAL_CHAT_IDENTITY,
      name: self.nickname,
      color: self.color,
      x: self.x,
      y: self.y,
    },
    ...Array.from(peers.values()).map((p) => ({
      identity: p.identity,
      name: p.name ?? p.identity.slice(0, 6),
      color: p.color ?? "#5AC8FA",
      x: p.x,
      y: p.y,
    })),
  ];
  const buckets = bucketByZone(map, avatars);
  const totalKnown = avatars.length; // self + peers
  const inAnyZone = Array.from(buckets.values()).reduce(
    (s, list) => s + list.length,
    0,
  );
  const unzoned = Math.max(0, totalKnown - inAnyZone);

  // Group zones by acoustic kind (contracts.md "Zones (M1)"). Each group
  // shows its semantic label — e.g. "自习区 · 12 人" — plus the zones and
  // avatars inside it. Only kinds that have authored zones are shown.
  const KIND_ORDER: ZoneKind[] = ["silent", "discussion", "rest"];
  const zoneGroups = KIND_ORDER.map((kind) => {
    const groupZones = zones.filter((z) => z.kind === kind);
    const total = groupZones.reduce(
      (s, z) => s + (buckets.get(z.key) ?? []).length,
      0,
    );
    return { kind, zones: groupZones, total };
  }).filter((g) => g.zones.length > 0);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <aside
      className={`whos-where${collapsed ? " collapsed" : ""}`}
      aria-label="Who's where"
    >
      <button
        type="button"
        className="whos-where-toggle"
        onClick={toggle}
        aria-expanded={!collapsed}
        title={collapsed ? "Show who's where" : "Hide who's where"}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={{
            transform: collapsed ? "rotate(-90deg)" : "none",
            transition: "transform 200ms ease",
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span className="whos-where-title">Who's where</span>
        <span className="whos-where-count">
          {peerCount + 1}
        </span>
      </button>
      {!collapsed && (
        <ul className="whos-where-list" role="list">
          {zoneGroups.map((g) => (
            <li key={g.kind} className={`whos-where-kind whos-where-kind--${g.kind}`}>
              <div
                className="whos-where-kind-header"
                title={zoneAllowsAudio(g.kind) ? "Talking allowed" : "Quiet — mic forced off"}
              >
                <span className="whos-where-kind-name">{ZONE_KIND_LABELS[g.kind]}</span>
                <span className="whos-where-kind-count">{g.total} 人</span>
              </div>
              {g.zones.map((z) => {
                const occupants = buckets.get(z.key) ?? [];
                return (
                  <div key={z.key} className="whos-where-zone">
                    <div className="whos-where-zone-header">
                      <span className="whos-where-zone-name">{z.label}</span>
                      <span className="whos-where-zone-count">{occupants.length}</span>
                    </div>
                    {occupants.length > 0 ? (
                      <div className="whos-where-avatars">
                        {occupants.slice(0, 5).map((o) => (
                          <span
                            key={o.identity}
                            className="whos-where-avatar"
                            style={{ background: o.color }}
                            title={o.name}
                            aria-label={o.name}
                          >
                            {initials(o.name)}
                          </span>
                        ))}
                        {occupants.length > 5 && (
                          <span className="whos-where-overflow">
                            +{occupants.length - 5}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="whos-where-empty">Empty</div>
                    )}
                  </div>
                );
              })}
            </li>
          ))}
          {unzoned > 0 && (
            <li className="whos-where-zone whos-where-zone--ghost">
              <div className="whos-where-zone-header">
                <span className="whos-where-zone-name">Roaming</span>
                <span className="whos-where-zone-count">{unzoned}</span>
              </div>
            </li>
          )}
        </ul>
      )}
    </aside>
  );
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
