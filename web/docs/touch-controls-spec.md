# MW1 触屏交互规格

版本：v1.0 —— 2026-09-29（MW1 开工前冻结）
目标：一部手机浏览器（Android Chrome / iOS Safari）覆盖移动端；桌面端零回归。

## 1. 触屏 UI 挂载条件

`window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window`
为真才渲染触屏控件；桌面端不渲染、不注册 touch 监听。

## 2. 虚拟摇杆

- 位置：左下 fixed overlay，直径 112px CSS；z-index 高于画布、低于 modal。
- 死区：触点偏移 < 8px 视为零向量。
- 输出：`{ x, y } ∈ [-1,1]²`，`v = clamp(offset / (radius − deadZone))`；y 向下为正（与屏幕坐标一致，tick 中 `dy += v.y`）。
- 接入点（`SyncleScreen` tick）：`keyDx/keyDy`（键盘单位向量）与 `joyX/joyY` 相加后整体归一化；两者实际互斥，相加安全。
- 实现：Pointer Events + `setPointerCapture`；`touch-action: none` 防止滚动。

## 3. 点按移动（tap-to-move）

- 手势判定：`pointerup` 距 `pointerdown` < 300ms 且位移 < 10px，且落点在画布上（非 UI 控件）。
- 语义：**直线移动，不寻路**。落点经 camera 逆变换 → 世界坐标 → `tapTarget`。
- tick 行为：无键盘/摇杆输入时，以 `MOVE_SPEED_PER_SEC` 朝目标移动；以下情况取消目标：
  到达（距离 < 6px）/ 被阻挡（连续 10 帧位移 < 0.5px）/ 任意键盘或摇杆输入 / 坐下 / 切换地图。
- 点到墙内：`applyMove` 自然滑动停止 → 触发"被阻挡"取消，不抖动。

## 4. 按钮映射表

| 桌面 | 触屏 | 显示条件 | 说明 |
|---|---|---|---|
| F（开 note/board） | 上下文按钮"打开" | `nearbyNoteIndex`/`nearbyBoardIndex` 非空 | 复用现有 `setReadingNoteIndex` / `setViewingBoardIndex`；board 优先（与 F 一致） |
| E（坐下/起身） | 上下文按钮"坐下"/"起身" | `nearbyTable` 非空或已坐下 | 复用现有 `setSelfTable` 逻辑 |
| 空格 PTT | 按住按钮"按住发言" | `zoneKind === "silent"` | `pointerdown`→`setPttHeld(true)`；`pointerup`/`pointercancel`/`pointerleave`→`false`；复用 M1 的 `pttHeld` 状态机 |
| M / T / R | HUD 小按钮 | 常驻（触屏 HUD 行） | 复用 `toggleUserMuted` / `setChatOpen` / reaction |
| Esc | modal 自带关闭按钮 | modal 打开时 | 已有，无需新增 |

- PTT 安全：触屏与空格共用 `pttHeldRef`/`setPttHeld`，"打开聊天释放 / 窗口 blur 释放"逻辑自动覆盖触屏。

## 5. 响应式布局

- `viewport-fit=cover` + `env(safe-area-inset-*)`；画布全屏，HUD 避开刘海与手势条。
- `ChatPanel` / `WhosWherePanel` / `VideoTiles` → 抽屉式（底部或右侧），默认收起，FAB 展开；会议中视频抽屉可折叠但保持可达。
- 375×667 验收流程：进入 → 摇杆走动 → 坐下 → 开麦发言 → 打开聊天，全程无横向滚动、无不可点按钮。

## 6. 性能档位

- 三档 `high | balanced | battery`，`localStorage["syncle.perf"]`。
- 默认自动选档：`navigator.hardwareConcurrency >= 6 && (deviceMemory ?? 4) >= 4` → high，否则 balanced；`Save-Data` 或电量低（`getBattery`）→ battery。
- battery 档：tick 目标帧率 30、DPR 上限 1.5、关闭 reaction 上浮动画与重阴影特效。
- 设置入口：HUD 齿轮菜单三档切换。

## 7. PWA（最小可用，不做推送）

- `web/public/manifest.webmanifest`：name / short_name / icons(192+512 PNG) / display standalone / theme_color。
- 手写 `web/public/sw.js`：静态资源 cache-first（版本化缓存名），HTML network-first；`main.tsx` 中仅 production 注册。
- `index.html`：manifest 链接、`theme-color`、`apple-touch-icon`、`viewport-fit=cover`。
