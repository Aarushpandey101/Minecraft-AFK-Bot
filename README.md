# Minecraft AFK Bot

Minecraft AFK bot focused on long-running cracked/AuthMe-friendly sessions, reconnect recovery, and simple remote status monitoring.

## Highlights

- Auto-auth with configurable modes: `login`, `register-first`, `register-only`, or `both`
- Separate reconnect tuning for network errors like `ETIMEDOUT` and `ECONNRESET`
- Live status page and JSON API for Render or local monitoring
- Optional anti-idle behavior, confinement, sleep support, combat, and chat features
- Offline and Microsoft/Mojang account support through Mineflayer auth settings

## Setup

1. Install Node.js.
2. Run `npm install`.
3. Edit `settings.json`.
4. Start the bot with `npm start`.

## Important Settings

### Account

- `bot-account.username`: bot username
- `bot-account.password`: account password when required
- `bot-account.type`: Mineflayer auth mode such as `offline` or `microsoft`

### Server

- `server.ip`
- `server.port`
- `server.version`
- `server.check-timeout-interval`: how long to tolerate delayed keepalives before timing out

### Auto Auth

Under `utils.auto-auth`:

- `enabled`
- `password`
- `mode`

Recommended modes:

- `login`: for already-registered cracked accounts
- `register-first`: for new cracked accounts on AuthMe servers
- `both`: if the server behavior is inconsistent and you want to try both paths

### Reconnect Tuning

Under `utils`:

- `auto-reconnect-delay`
- `auto-reconnect-jitter`
- `network-reconnect-delay`
- `network-reconnect-jitter`

Use the `network-*` settings for faster retries after raw socket issues like `ETIMEDOUT`.

## Status Dashboard

- Open `http://localhost:3000/status` locally, or your deployed `PORT` URL remotely
- JSON status is available at `/api/status`

The status API includes:

- connection state
- ping
- health and food
- position
- reconnects, kicks, and error counters
- last connect and disconnect timestamps

## Stability Tips

- Keep the bot in a safe enclosed area if the server has mobs or awkward spawn points.
- Disable `utils.behavior.enabled` and `utils.chat-messages.enabled` while stabilizing a new deployment.
- Increase `server.check-timeout-interval` if your host has lag spikes or unstable routing.
- Keep `move-radius` small when the bot is inside a tiny AFK room.
- Use confinement if you want the bot to stay near one fixed location.

## Notes For Render

- The bot exposes an HTTP status page, which makes it easy to observe on Render.
- Render region quality can vary over time for Aternos routes.
- Always use the server hostname instead of a hardcoded backend IP.

## License

MIT

