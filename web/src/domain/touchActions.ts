// MW1 触屏上下文按钮的判定逻辑（纯函数，无 React/状态依赖）。
//
// 对应桌面键位（SyncleScreen.tsx 键盘处理分支，本文件只做映射，调用仍由 coordinator 接线）：
//  - F 键：开 board 或 note —— board 优先于 note
//    （`nearbyBoardIndexRef.current != null → setViewingBoardIndex(bIdx)`，
//     否则 `nearbyNoteIndexRef.current → setReadingNoteIndex(idx)`）。
//  - E 键：坐下/起身切换 —— 已坐下（`self.tableId != null`）→ `setSelfTable(null)`；
//    否则 `findNearestTable(x, y, map, TABLE_JOIN_RADIUS)` 找到则 `setSelfTable(id)`。
//
// 本模块只输出"应显示哪种操作"；coordinator 把结果交给 TouchActionBar 的
// onAction，再映射到与 F/E 键相同的处理函数，从而保证桌面与触屏语义完全一致。

/** 触屏上下文按钮可触发的操作，与桌面 F/E 键一一对应。 */
export type TouchAction = "board" | "note" | "sit" | "stand";

export interface InteractProximity {
  /** 与 F 键同源：`nearbyBoardIndex` state（F 分支 board 优先）。 */
  nearbyBoardIndex: number | null;
  /** 与 F 键同源：`nearbyNoteIndex` state。 */
  nearbyNoteIndex: number | null;
  /** 与 E 键同源：`nearbyTable` state（可坐的桌子 id）。 */
  nearbyTable: string | null;
  /** 是否已坐下：SyncleScreen 用 `self.tableId != null` 判定。 */
  seated: boolean;
}

/** 计算当前应显示的上下文操作；无可操作对象时返回 null（按钮隐藏）。
 *
 * 优先级（必须与 F/E 键分支一致）：
 *  1. 已坐下时只返回 "stand"（与 E 键 toggle 语义一致：坐下时 E 只起身，
 *     不显示 board/note）；
 *  2. 未坐下时 board 优先于 note（与 F 键一致）；
 *  3. 未坐下、无 board/note、附近有桌子时返回 "sit"；
 *  4. 其它情况返回 null。
 */
export function interactActionFor({
  nearbyNoteIndex,
  nearbyBoardIndex,
  nearbyTable,
  seated,
}: InteractProximity): TouchAction | null {
  if (seated) return "stand";
  if (nearbyBoardIndex != null) return "board";
  if (nearbyNoteIndex != null) return "note";
  if (nearbyTable != null) return "sit";
  return null;
}
