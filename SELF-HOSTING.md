# Self-Hosting Excalidraw

Self-host Excalidraw with **real-time collaboration** and **link sharing** using Docker Compose. No Firebase or third-party services required.

## Architecture

```
                          ┌─────────────────────────────────────┐
                          │           Docker Compose             │
                          │                                     │
  Browser ──────────────► │  frontend    (nginx, port 80)       │
  http://localhost:3333   │      Excalidraw SPA                 │
                          │                                     │
  Browser (WebSocket) ──► │  room        (node, port 80)        │
  http://localhost:3002   │      Real-time collaboration relay  │
                          │                                     │
  Browser (HTTP) ───────► │  storage     (node, port 8080)      │
  http://localhost:8080   │      REST API for scenes/rooms/files│
                          │          │                          │
                          │          ▼                          │
                          │  redis       (port 6379)            │
                          │      Persistent key-value store     │
                          └─────────────────────────────────────┘
```

| Service | Image | Purpose |
|---------|-------|---------|
| **frontend** | Built from source | Excalidraw SPA served via nginx |
| **room** | `excalidraw/excalidraw-room` | WebSocket relay for real-time collaboration (stateless, E2E encrypted) |
| **storage** | `alswl/excalidraw-storage-backend` | REST API for persisting shared drawings, room state, and files |
| **redis** | `redis:7-alpine` | Persistent storage with AOF (append-only file) durability |

## Quick Start

```bash
git clone https://github.com/guneet-xyz/excalidraw.git
cd excalidraw
docker compose up --build -d
```

Open **http://localhost:3333** and start drawing.

> **Note:** The first build takes 2-3 minutes (downloading dependencies and building the frontend). Subsequent builds are cached and much faster.

## What Works

- **Drawing** — full Excalidraw editor with all tools
- **Real-time collaboration** — click the share icon, start a live session, share the link
- **Link sharing** — export a drawing as a shareable link, persisted in Redis
- **File uploads** — images embedded in drawings are stored in the storage backend
- **E2E encryption** — collaboration data is encrypted client-side, the server only relays opaque blobs
- **Local-first** — drawings auto-save to browser IndexedDB

## Configuration

### Dev (localhost)

The default `docker compose up` uses [`docker-compose.override.yml`](docker-compose.override.yml) which:
- Exposes ports: frontend on `3333`, room on `3002`, storage on `8080`
- Builds with `VITE_MODE=development` → uses [`.env.development`](.env.development) (localhost URLs)
- Sets CORS to allow `http://localhost:3333`

### Production

For production behind a reverse proxy (e.g., Caddy):

1. **Edit [`.env.production`](.env.production)** — update URLs to your domain:
   ```env
   VITE_APP_BACKEND_V2_GET_URL=https://draw.yourdomain.com/api/v2/scenes/
   VITE_APP_BACKEND_V2_POST_URL=https://draw.yourdomain.com/api/v2/scenes/
   VITE_APP_WS_SERVER_URL=https://draw.yourdomain.com
   VITE_APP_HTTP_STORAGE_BACKEND_URL=https://draw.yourdomain.com/api/v2
   ```

2. **Edit [`docker-compose.prod.yml`](docker-compose.prod.yml)** — update `CORS_ORIGIN`:
   ```yaml
   room:
     environment:
       - CORS_ORIGIN=https://draw.yourdomain.com
   ```

3. **Set up your reverse proxy** — see [`Caddyfile.example`](Caddyfile.example) for a working Caddy config with path-based routing:
   - `/socket.io/*` → room service (WebSocket)
   - `/api/v2/*` → storage service
   - Everything else → frontend

4. **Build and start:**
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
   ```

### Environment Variables

These are baked into the frontend JavaScript bundle at build time via Vite:

| Variable | Dev Default | Description |
|----------|-------------|-------------|
| `VITE_APP_BACKEND_V2_GET_URL` | `http://localhost:8080/api/v2/scenes/` | GET endpoint for shared scene links |
| `VITE_APP_BACKEND_V2_POST_URL` | `http://localhost:8080/api/v2/scenes/` | POST endpoint for creating share links |
| `VITE_APP_WS_SERVER_URL` | `http://localhost:3002` | WebSocket server for collaboration |
| `VITE_APP_HTTP_STORAGE_BACKEND_URL` | `http://localhost:8080/api/v2` | Storage backend for rooms and files |
| `VITE_APP_FIREBASE_CONFIG` | `{}` | Set to `{}` to disable Firebase |

> **Important:** Since these are build-time variables, changing them requires rebuilding the frontend image (`docker compose up --build`).

## How It Differs from Upstream

This fork replaces Firebase (used by excalidraw.com) with a self-hosted HTTP storage backend. The changes are minimal and contained to a few files:

| File | Change |
|------|--------|
| `Dockerfile` | Updated to Node 20, added `VITE_MODE` build arg |
| `.env.development` | Self-hosted localhost URLs |
| `.env.production` | Self-hosted production URLs |
| `excalidraw-app/data/firebase.ts` | Rewrote Firebase calls → HTTP `PUT`/`GET` against storage backend |
| `excalidraw-app/components/ExportToExcalidrawPlus.tsx` | Firebase Storage → HTTP upload |
| `excalidraw-app/vite-env.d.ts` | Added `VITE_APP_HTTP_STORAGE_BACKEND_URL` type |

Everything else (the editor, rendering, tools, etc.) is unchanged from upstream.

## Syncing with Upstream

To pull in upstream updates:

```bash
git remote add upstream https://github.com/excalidraw/excalidraw.git  # only needed once
git fetch upstream
git merge upstream/master
# Resolve conflicts in the ~4 modified files if any
git push origin self-hosted
```

## Troubleshooting

### Port already in use

Edit [`docker-compose.override.yml`](docker-compose.override.yml) to change the exposed ports. Remember to also update the corresponding URLs in [`.env.development`](.env.development) and rebuild.

### HTTPS required for collaboration

The Web Crypto API (used for E2E encryption) requires a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). This means:
- `http://localhost` — works (browsers treat localhost as secure)
- `http://127.0.0.1` — works
- `http://192.168.x.x` — **will not work** (use HTTPS or access via localhost)

### Storage backend errors

Check logs: `docker compose logs storage`

The storage backend uses Redis via Keyv. If Redis is unreachable, the storage service will fail to persist data. Verify Redis is healthy: `docker compose ps`.

### Rebuilding after config changes

Since env vars are baked in at build time:
```bash
docker compose up --build -d
```

To force a clean rebuild (no cache):
```bash
docker compose build --no-cache frontend
docker compose up -d
```
