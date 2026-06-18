# Last Meadow Online

Real-time multiplayer browser game server built with Node.js and WebSockets.

## Overview

Last Meadow Online is a lightweight multiplayer game server that serves a static game client via HTTP and manages real-time player interactions over WebSocket connections. Designed to run anywhere Docker does.

## Quick Start

```bash
docker run -d -p 3000:3000 --name last-meadow \
  ghcr.io/YOUR_GITHUB_USERNAME/last-meadow-online:latest
```

Then open `http://localhost:3000` in a browser.

## Pterodactyl Setup

1. Import `egg-last-meadow.json` into your Pterodactyl Panel (Nests → Import Egg).
2. Create a new server using the **Last Meadow Online** egg.
3. Replace `GHCR_OWNER` in the Docker image field with your GitHub username.
4. Adjust **Server Listen Port** (default: 3000) and **Server Name** as needed.
5. Start the server.

## Environment Variables

| Variable      | Default        | Description                      |
|---------------|----------------|----------------------------------|
| `PORT`        | `3000`         | Server listen port               |
| `SERVER_NAME` | `Last Meadow`  | Display name shown to players    |

## Development

```bash
npm install
node server.js
```

Open `http://localhost:3000` and connect with multiple browser tabs to test.

## Contributing

PRs welcome. Keep it small, lint before pushing, and test with at least two concurrent clients.
