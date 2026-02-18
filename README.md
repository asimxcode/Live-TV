# LiveTV (Node.js + Advanced Admin)

Modern Live TV streaming website with:
- Public player (`/`)
- Hidden admin panel (custom secret path)
- HLS playback via HLS.js
- Bootstrap 5 minimal UI (CDN-based)
- Channel data persisted in `data/channels.json`

## Features

- HLS `.m3u8` playback on modern browsers
- Server-side HLS proxy (public client never receives raw `streamUrl`)
- HLS proxy token reuse + automatic stale segment cleanup
- Safari native HLS fallback
- Responsive dark UI
- Search + category filtering on player
- Channel grid with thumbnails
- Auto-play selected channel
- Buffering spinner overlay
- Realtime live comments (name + message) with per-channel chat rooms
- Dynamic live viewer count tied to active channel room presence
- Hidden admin URL (not shown on public page)
- Admin login/logout
- Advanced admin tools:
  - Channel CRUD
  - Priority-based ordering
  - Move up/down + direct priority set
  - Table search and category filter
  - Dashboard stats (channels/categories/countries)
  - Export channels JSON

## Project Structure

```text
LiveTV/
|-- server.js
|-- package.json
|-- .env.example
|-- data/
|   `-- channels.json
`-- public/
    |-- index.html
    |-- admin.html
    `-- assets/
        `-- js/
            |-- app.js
            |-- comments.js
            `-- admin.js
```

## Environment Variables

- `PORT` (default: `3000`)
- `ADMIN_USERNAME` (default: `admin`)
- `ADMIN_PASSWORD` (default: `admin123`)
- `ADMIN_PATH` (default: `/control-room`)

The app auto-loads `.env` from the project root at startup.

Example PowerShell:

```powershell
$env:PORT=3000
$env:ADMIN_USERNAME="admin"
$env:ADMIN_PASSWORD="change_me"
$env:ADMIN_PATH="/my-secret-panel"
```

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start server:

```bash
npm start
```

3. Open:
- Player: `http://localhost:3000/`
- Admin: `http://localhost:3000<ADMIN_PATH>`

Example admin URL if `ADMIN_PATH=/my-secret-panel`:
- `http://localhost:3000/my-secret-panel`

Note:
- `/admin` and `/admin.html` intentionally return `404`.

## Channel Data Format

`data/channels.json`:

```json
{
  "id": "unique-id",
  "name": "Channel Name",
  "category": "News",
  "country": "US",
  "thumbnail": "https://example.com/logo.jpg",
  "streamUrl": "https://example.com/live/index.m3u8",
  "priority": 1
}
```

Lower `priority` appears first in both player and admin list.

Public `/api/channels` response exposes `playbackUrl` only.
The original `streamUrl` is returned only in authenticated admin APIs.

## Deployment

## cPanel (Node.js App)

1. Upload project files.
2. Open **Setup Node.js App** in cPanel.
3. Configure app:
- Startup file: `server.js`
- Node version: latest LTS
4. Run `npm install`.
5. Set env vars (`ADMIN_PASSWORD` and `ADMIN_PATH` are important).
6. Restart the app.

## VPS (PM2 + Nginx)

1. Upload project:

```bash
scp -r LiveTV user@server:/var/www/livetv
```

2. Install dependencies:

```bash
cd /var/www/livetv
npm install
npm install -g pm2
```

3. Start with env vars:

```bash
PORT=3000 ADMIN_USERNAME=admin ADMIN_PASSWORD=change_me ADMIN_PATH=/my-secret-panel pm2 start server.js --name livetv
pm2 save
```

4. Configure Nginx reverse proxy to `127.0.0.1:3000`.

## Notes

- Change default admin credentials before production.
- Use a non-guessable `ADMIN_PATH`.
- Some stream providers enforce token/CORS/referer restrictions.
