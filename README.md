# Afk Bot
<p align="center"> 
    <img src="https://img.shields.io/github/issues/urfate/afk-bot">
    <img src="https://img.shields.io/github/forks/urfate/afk-bot">
    <img src="https://img.shields.io/github/stars/urfate/afk-bot">
    <img src="https://img.shields.io/github/license/urfate/afk-bot">
</p>

<p align="center">
    Functional minecraft AFK bot for servers
</p>

<p align="center">
    Anti-AFK, Auto-Auth, Microsoft/Offline accounts support.
</p>

## Installation

 1. [Download](https://github.com/urFate/Afk-Bot/tags) the latest package.
 2. Download & install [Node.JS](https://nodejs.org/en/download/)
 3. Run `npm install` command in bot directory.
 
 ## Usage
 
 1. Configure bot in `settings.json` file. [Bot configuration is explained in our wiki](https://urfate.gitbook.io/afk-bot/bot-configuration)
 2. Start bot with `node .` command.


## Stability tips (disconnects / escaping)

- Increase `server.check-timeout-interval` in `settings.json` if your host has lag spikes.
- Add reconnect jitter with `utils.auto-reconnect-jitter` to avoid fixed reconnect patterns.
- Use `utils.behavior.confinement` to keep the bot near a fixed center point so it does not wander out of fenced areas.
- Keep `move-radius` small (1-2) when the bot is inside a tiny AFK box with a bed.
- Tune `utils.behavior.humanizer.interval-min/max` for irregular micro-actions (look, sneak, jump) to reduce AFK kicks.


## Sleep reliability tips

- Keep a bed within `utils.auto-sleep.bed-search-radius` blocks of the bot.
- Set `utils.auto-sleep.approach-distance` to `2` (or `1`) so it walks close enough before sleeping.
- `utils.auto-sleep.retry-interval-ms` controls how often the bot retries sleeping at night.
- `utils.auto-sleep.no-bed-log-cooldown-ms` prevents log spam if no bed is found.

## Features

 - Anti-AFK Kick Module
 - Move to target block after join
 - Mojang/Microsoft Account support
 - Chat log
 - Chat messages Module
 - Auto reconnect
 - Supported server versions: `1.8 - 1.19.3`
 
 ### License
 [MIT](https://github.com/urFate/Afk-Bot/blob/main/LICENSE)

