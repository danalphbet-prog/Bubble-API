# Bubble API MVP v1.2.0

Bedrock-first Bubble shared-state API. This is the deployable continuation of the v1.1 architecture: HTTP polling, in-memory realtime state, authoritative manifest, session authentication, required join, spatial validation and AOI filtering.

## What it does

Two independent Bedrock Dedicated Server instances can connect to the same Bubble. Each Add-On publishes a local player state and receives remote states. The receiving Add-On renders remote users as local proxy entities.

## Local run

```bash
cp .env.example .env
npm install
# load env vars using your preferred method
npm start
```

The server binds to `0.0.0.0:$PORT`.

## Render deploy

1. Upload/push this folder to a Git repository.
2. In Render choose **New > Blueprint** and select the repository containing `render.yaml`, or create a Node Web Service manually.
3. Set `BUBBLE_SERVER_KEYS` as a secret environment variable, for example:

```json
{"bedrock-streamer-a":"LONG_RANDOM_SECRET_A","bedrock-streamer-b":"LONG_RANDOM_SECRET_B"}
```

4. Set `BUBBLE_ADMIN_KEY` to another long random secret.
5. Deploy.
6. Open `/healthz` and confirm `ok: true`.

## BDS flow

```text
POST /v1/sessions/register
GET  /v1/bubbles
GET  /v1/bubbles/n25/manifest
POST /v1/bubbles/n25/join
POST /v1/bubbles/n25/sync   <- repeat around every 200 ms
POST /v1/bubbles/n25/leave
DELETE /v1/sessions/{session_id}
```

After registration use:

```http
Authorization: Bearer SESSION_TOKEN
```

## Important MVP limits

- Memory only: Render restart/redeploy clears sessions and presence.
- No Redis/database.
- No WebSocket.
- No full world/block replication.
- No skin/inventory/equipment replication yet.
- No server-side physics authority yet.
- Bedrock only in this package; Roblox is reserved for a later transport/adapter.

See `docs/ARCHITECTURE.md` and `docs/ROUTES.md`.
