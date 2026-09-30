// M3 T10 — focus stats panel.
//
// Fetches the frozen stats shape from GET /v1/users/:userId/focus/stats
// (contract §4) via the timer worker's `getFocusStats` and renders:
// today's focused time, this week's focused time, the current streak,
// total completed sessions, and a 7-day mini bar chart.
//
// The panel renders as a centered modal card on desktop (fine pointer).
// On touch layouts SyncleScreen wraps it in MobileDrawer, so the card
// collapses to drawer content via the (pointer: coarse) CSS override —
// same pattern as the other mobile panels (MW1-2).

import { useCallback, useEffect, useState } from "react";
import { getFocusStats } from "../data/focusApi";
import {
  barHeights,
  formatBarDayLabel,
  formatDurationZh,
} from "./focusStatsFormat";

export interface FocusStatsPanelProps {
  backendUrl: string;
  /** Must equal the JWT subject (contract §4: stats are private in M3). */
  userId: string;
  getToken: () => string;
  onClose: () => void;
}

/** Frozen stats shape (contract §4). Breaks are recorded server-side but
 *  excluded from every aggregate here. */
export interface FocusStats {
  todaySec: number;
  weekSec: number;
  streakDays: number;
  totalCompletedSessions: number;
  last7Days: { day: string; seconds: number }[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; stats: FocusStats };

export function FocusStatsPanel({
  backendUrl,
  userId,
  getToken,
  onClose,
}: FocusStatsPanelProps) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });

  const refresh = useCallback(async () => {
    if (!backendUrl || !userId) {
      setLoad({ kind: "error", message: "未连接到服务器，无法加载统计。" });
      return;
    }
    setLoad({ kind: "loading" });
    try {
      // Client timezone: tzOffsetMin is minutes east of UTC, so negate
      // Date.getTimezoneOffset() (contract §4).
      const tzOffsetMin = -new Date().getTimezoneOffset();
      const stats: FocusStats = await getFocusStats(
        backendUrl,
        userId,
        getToken(),
        tzOffsetMin,
      );
      setLoad({ kind: "ready", stats });
    } catch (err) {
      setLoad({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [backendUrl, userId, getToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="focus-stats" aria-label="专注统计">
      <div className="focus-stats-header">
        <span className="focus-stats-title">专注统计</span>
        <button
          type="button"
          className="focus-stats-close"
          onClick={onClose}
          aria-label="关闭专注统计"
        >
          ✕
        </button>
      </div>

      {load.kind === "loading" && (
        <div className="focus-stats-body">
          <div className="focus-stats-loading" role="status">
            加载中…
          </div>
        </div>
      )}

      {load.kind === "error" && (
        <div className="focus-stats-body">
          <div className="focus-stats-error" role="alert">
            {load.message}
          </div>
          <button
            type="button"
            className="focus-stats-retry"
            onClick={() => void refresh()}
          >
            重试
          </button>
        </div>
      )}

      {load.kind === "ready" && (
        <FocusStatsBody stats={load.stats} />
      )}
    </section>
  );
}

function FocusStatsBody({ stats }: { stats: FocusStats }) {
  const heights = barHeights(stats.last7Days.map((x) => x.seconds));
  return (
    <div className="focus-stats-body">
      <div className="focus-stats-tiles">
        <div className="focus-stats-tile">
          <div className="focus-stats-tile-value">
            {formatDurationZh(stats.todaySec)}
          </div>
          <div className="focus-stats-tile-label">今日专注</div>
        </div>
        <div className="focus-stats-tile">
          <div className="focus-stats-tile-value">
            {formatDurationZh(stats.weekSec)}
          </div>
          <div className="focus-stats-tile-label">本周专注</div>
        </div>
        <div className="focus-stats-tile">
          <div className="focus-stats-tile-value">
            {stats.streakDays}
            <span className="focus-stats-tile-unit">天</span>
          </div>
          <div className="focus-stats-tile-label">连续专注</div>
        </div>
      </div>

      <div className="focus-stats-total">
        累计完成 {stats.totalCompletedSessions} 次专注
      </div>

      <div className="focus-stats-chart-title">近 7 天</div>
      <div className="focus-stats-chart" role="img" aria-label="近7天每日专注时长">
        {stats.last7Days.map((d, i) => (
          <FocusBar
            key={d.day}
            label={formatBarDayLabel(d.day)}
            value={formatDurationZh(d.seconds)}
            heightPct={heights[i]}
            today={i === stats.last7Days.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function FocusBar({
  label,
  value,
  heightPct,
  today,
}: {
  label: string;
  value: string;
  heightPct: number;
  today: boolean;
}) {
  return (
    <div className={`focus-stats-bar${today ? " today" : ""}`} title={value}>
      <div className="focus-stats-bar-track">
        <div
          className="focus-stats-bar-fill"
          style={{ height: `${heightPct}%` }}
        />
      </div>
      <div className="focus-stats-bar-label">{label}</div>
    </div>
  );
}
