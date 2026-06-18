# Last Meadow Online

A browser-based multiplayer boss battler born in Discord — retro MS Paint aesthetic, real-time co-op chaos, and one big angry boss to take down together.

## What is it?

Last Meadow Online is a **persistent multiplayer browser game** where a community gathers to gather resources, craft gear, and whittle down a massive boss HP pool in real time. Think old-school Runescape simplicity meets MS Paint charm, playable from any browser — no install, no signup.

Players choose a class (Ranger / Paladin / Priest) and a profession (Fletcher / Smithy / Scholar), then work together across gathering, crafting, and battle phases to defeat the boss. Every hit counts. Every craft matters.

Built for a Discord community that wanted a shared persistent world without leaving the browser.

## How it Plays

1. Gather — Collect logs, scrap, and hide in the Adventure tab
2. Craft — Complete the arrow minigame to turn materials into class gear
3. Fight — Feed gear into Battle to deal damage to the boss
4. Repeat — Boss phases cycle every 30s between shielded (75% reduced damage) and vulnerable

## Quick Start

```bash
# Run your own server for the community
docker run -d -p 3000:3000 --name last-meadow \
  ghcr.io/YOUR_GITHUB_USERNAME/last-meadow-online:latest
```

Open `http://localhost:3000` and share the link with your Discord. Everyone connects instantly — no accounts, no downloads.

## Pterodactyl Setup

1. Import `egg-last-meadow.json` into your Pterodactyl Panel (Nests → Import Egg).
2. Create a new server using the **Last Meadow Online** egg.
3. Replace `GHCR_OWNER` in the Docker image field with your GitHub username.
4. Set **Server Listen Port** and **Server Name** as desired.
5. Start the server and share your domain in Discord.

## Environment Variables

| Variable      | Default        | Description                      |
|---------------|----------------|----------------------------------|
| `PORT`        | `3000`         | Server listen port               |
| `SERVER_NAME` | `Last Meadow`  | Display name shown to players    |

## Local Dev

```bash
npm install
node server.js
# Opens at http://localhost:3000
```

Open multiple browser tabs to simulate a multiplayer session — or rope in friends on the same LAN.

## Tech

- **Server:** Node.js + `ws` (raw WebSocket server)
- **Client:** Vanilla HTML/CSS/JS, no frameworks
- **Auth:** None — share a link, anyone joins
- **State:** In-memory, one boss shared by all connections
- **Packaging:** Docker → GHCR → Pterodactyl

## Contributing

PRs welcome. Keep changes focused, test with multiple concurrent clients, and don't break the boss fight.
