# Deploying a public demo

The stack has three pieces. Vercel only hosts the **static web client** —
the Node server (native SQLite, long-lived process) needs a container host,
and WebRTC needs a LiveKit server.

| Piece | Where | Cost |
|---|---|---|
| Web client (static) | Vercel | free |
| Server (`server/Dockerfile`) | Fly.io / Railway / Render | free tier |
| LiveKit SFU | [LiveKit Cloud](https://cloud.livekit.io) | free tier |

The server only **signs JWTs** — it never connects to LiveKit itself —
so LiveKit Cloud is a clean drop-in.

## 1. LiveKit Cloud (5 min)

1. Sign up at https://cloud.livekit.io, create a project.
2. Copy: **WebSocket URL** (`wss://your-project.livekit.cloud`),
   **API key**, **API secret**.

## 2. Server → Fly.io / Railway / Render (10 min)

Deploy `server/` with `server/Dockerfile`. Environment variables:

| Var | Value |
|---|---|
| `LIVEKIT_URL` | `wss://your-project.livekit.cloud` (from step 1) |
| `LIVEKIT_API_KEY` | from step 1 |
| `LIVEKIT_API_SECRET` | from step 1 |
| `PORT` | platform default (usually pre-set) |
| `WEB_BASE_URL` | your Vercel URL, e.g. `https://open-study-room.vercel.app` — only needed if you enable GitHub/email login (P1-B) |
| `BASE_URL` | same as `WEB_BASE_URL` when login is on |

Optional (P1-B login): `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
/ `SMTP_*` — see [docs/auth-setup.md](auth-setup.md).

Note: SQLite lives inside the container, so demo data resets on
redeploy. Attach a volume and set `DB_PATH` for persistence.

Verify: `https://<your-server>/healthz` returns 200.

## 3. Web → Vercel (5 min)

1. Import this repo in Vercel. **Root directory = repo root**
   (`vercel.json` already sets build/install/output paths —
   the web `prebuild` step syncs assets from `../assets` and
   `../server`, which is why the root must stay at repo level).
2. Add environment variable (build-time — Vite inlines it):
   `VITE_BACKEND_URL=https://<your-server-from-step-2>`
3. Deploy. Done — open the URL.

Order matters: deploy the server first, then the web build,
because the backend URL is baked into the JS bundle.

## Local full-stack (unchanged)

```bash
docker compose up --build -d   # web :8080 · server :8787 · livekit :7880
```
