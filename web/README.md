# Syncle Web

React + Vite + TypeScript client. Joins the **same LiveKit room** and talks to the
**same Syncle backend** as the Android app, so a browser user and an Android user
appear as ordinary peers in the same spatial world.

## Scope (current)

- Login → `POST /v1/sessions` → LiveKit JWT (same flow as Android)
- Connect to LiveKit room; 20 Hz binary position broadcast over LiveKit data channel
- Render the map (`room1.jpg` + `map_config.json` shared with Android); WASD / arrows move, AABB walkable clamping
- Camera/microphone, table meetings (sit-to-join video grid), reconnect backoff, map editor
- **M1 quiet semantics** (virtual study room): zones carry `kind: silent | discussion | rest`
  (see `docs/contracts.md` "Zones"); silent zones force-mute locally AND server-side
  (server calls LiveKit `mutePublishedTrack` on silent entry); distance-attenuated
  proximity voice in discussion/rest (`maxDistance=300`, linear — replaces the old
  same-table binary gate); Space = push-to-talk in silent zones; clients join
  publishing no audio/video tracks by default; web reports `(x, y, table, zone)`
  to `POST /v1/rooms/:room/state` on zone crossings + 30s heartbeat

**Not yet:** mobile touch controls.

## Quick start

```bash
# 1. Start backend + LiveKit (from repo root)
docker compose up --build

# 2. Web dev server
cd web
cp .env.example .env
npm install
npm run dev          # http://localhost:5173
```

The `predev` hook copies `map_config.json` and `room1.jpg` from
`app/src/main/assets/` into `public/`. Re-run `npm run sync-assets` after the
Android assets change.

## Layout

```
web/
├── public/                  (generated; git-ignored)
├── scripts/sync-assets.mjs  copies shared world assets from app/src/main/assets
├── src/
│   ├── data/                sessionApi.ts, liveKitService.ts
│   ├── domain/              positionPacket.ts (binary protocol mirror of
│   │                         PositionSyncEngine.kt), mapConfig.ts, camera.ts
│   ├── state/syncleStore.ts zustand store
│   ├── ui/                  JoinScreen, SyncleScreen, SpatialCanvas
│   ├── types/mapConfig.ts
│   ├── App.tsx, main.tsx, styles.css
└── vite.config.ts
```

## Shared contracts

The wire format must match `app/` and `server/` exactly. See
[../docs/contracts.md](../docs/contracts.md) for room/nickname/color rules and
`/v1/sessions` shape, and [src/domain/positionPacket.ts](src/domain/positionPacket.ts)
for the 17-byte position packet (little-endian: `type=1 | x:f32 | y:f32 | seq:i64`).
