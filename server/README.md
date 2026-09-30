# Open Study Room backend

Node 20 + Fastify + LiveKit Server SDK + SQLite. Signs LiveKit JWTs bound to a
persistent `userId` (derived from a client `deviceId`), and tracks per-room
position / table snapshots so late joiners get correct world state.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/sessions` | Upsert user by `deviceId`, return `{ userId, serverUrl, token, expiresAt }` |
| GET  | `/v1/rooms/:room/snapshot` | List peers with state in last 60s |
| POST | `/v1/rooms/:room/state` | Bearer-protected; upsert `(tableId, x, y)` for caller |
| GET  | `/healthz` | Liveness probe |

The state endpoint verifies the bearer token was issued by this server
(HS256 with `LIVEKIT_API_SECRET`) and that token identity + room match the
request.

## Local run

```bash
cd server
cp .env.example .env   # adjust if needed
npm install
npm run dev            # tsx watch on :8787
```

Or, with LiveKit + server together:

```bash
docker compose up --build
curl http://localhost:8787/healthz
```

## Tests

```bash
npm test
```

Covers token signing, deviceId idempotency, snapshot freshness window, bearer
validation, and identity/room mismatch rejection.
