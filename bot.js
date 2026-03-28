const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const dns = require('dns').promises;
const config = require('./settings.json');
const loggers = require('./logging.js');
const logger = loggers.logger;

const botStatus = {
    connected: false,
    connectingSince: null,
    lastConnectAt: null,
    lastDisconnectAt: null,
    lastDisconnectReason: null,
    reconnectCount: 0,
    kickedCount: 0,
    errorCount: 0,
    lastError: null,
    chatMessagesSeen: 0,
    chatMessagesSent: 0,
    spawnCount: 0,
    pingMs: null,
    health: null,
    food: null,
    position: null,
    uptimeMs: 0
};

let activeBot = null;
const AUTH_SUCCESS_PATTERNS = [
    'successfully logged in',
    'you are now logged in',
    'logged in successfully',
    'login successful'
];
const AUTH_LOGIN_PROMPT_PATTERNS = [
    '/login',
    'please login',
    'please log in',
    'log in with',
    'authenticate with'
];
const AUTH_REGISTER_PROMPT_PATTERNS = [
    '/register',
    'please register',
    'register with'
];

function isoNow() {
    return new Date().toISOString();
}

async function logResolvedServerAddress() {
    try {
        const addresses = await dns.lookup(config.server.ip, { all: true });
        if (Array.isArray(addresses) && addresses.length > 0) {
            logger.info(`Resolved ${config.server.ip} to ${addresses.map(entry => entry.address).join(', ')}`);
        }
    } catch (err) {
        logger.warn(`DNS lookup failed for ${config.server.ip}: ${err.message}`);
    }
}

function isNetworkErrorCode(code) {
    return ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'].includes(code);
}

function getReconnectDelay(lastErrorCode) {
    const isNetworkError = isNetworkErrorCode(lastErrorCode);
    const baseDelay = isNetworkError
        ? (config.utils['network-reconnect-delay'] || config.utils['auto-reconnect-delay'])
        : config.utils['auto-reconnect-delay'];
    const jitter = isNetworkError
        ? (config.utils['network-reconnect-jitter'] || 0)
        : (config.utils['auto-reconnect-jitter'] || 0);

    return {
        isNetworkError,
        delayMs: baseDelay + Math.floor(Math.random() * (jitter + 1))
    };
}

function stringifyMessage(message) {
    if (typeof message === 'string') return message;
    if (message?.toString) return message.toString();
    return '';
}

function createAutoAuthController(bot) {
    const authConfig = config.utils['auto-auth'];
    if (!authConfig?.enabled) return null;

    const password = process.env.BOT_PASSWORD || authConfig.password;
    const authMode = authConfig.mode || 'login';
    if (!password) {
        logger.warn('Auto-auth is enabled but no password is configured.');
        return null;
    }

    let stopped = false;
    let authenticated = false;
    const timers = new Set();
    const authenticatedCallbacks = new Set();

    const clearTimers = () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
    };

    const sendCommand = (command, reason) => {
        if (stopped || authenticated || !bot?.chat || !bot.player) return;
        bot.chat(command);
        logger.info(`Sent auth command (${reason}): ${command.split(' ')[0]}`);
    };

    const sendLogin = (reason) => sendCommand(`/login ${password}`, reason);
    const sendRegister = (reason) => sendCommand(`/register ${password} ${password}`, reason);

    const scheduleCommand = (command, delayMs, reason) => {
        const timer = setTimeout(() => {
            timers.delete(timer);
            sendCommand(command, reason);
        }, delayMs);
        timers.add(timer);
    };

    const markAuthenticated = () => {
        if (authenticated) return;
        authenticated = true;
        clearTimers();
        for (const callback of authenticatedCallbacks) callback();
        authenticatedCallbacks.clear();
    };

    const handleMessage = (rawMessage) => {
        const normalized = stringifyMessage(rawMessage).toLowerCase();
        if (!normalized) return;

        if (AUTH_SUCCESS_PATTERNS.some(pattern => normalized.includes(pattern))) {
            markAuthenticated();
            logger.info('Auth plugin confirmed the bot is logged in.');
            return;
        }

        if (AUTH_REGISTER_PROMPT_PATTERNS.some(pattern => normalized.includes(pattern))) {
            sendRegister('register prompt');
            scheduleCommand(`/login ${password}`, 1200, 'post-register login');
            return;
        }

        if (AUTH_LOGIN_PROMPT_PATTERNS.some(pattern => normalized.includes(pattern))) {
            sendLogin('login prompt');
        }
    };

    if (authMode === 'register-first') {
        scheduleCommand(`/register ${password} ${password}`, 250, 'initial register');
        scheduleCommand(`/login ${password}`, 1800, 'post-register login');
        scheduleCommand(`/login ${password}`, 6000, 'login retry');
        scheduleCommand(`/login ${password}`, 12000, 'final login retry');
    } else if (authMode === 'register-only') {
        scheduleCommand(`/register ${password} ${password}`, 250, 'initial register');
        scheduleCommand(`/register ${password} ${password}`, 5000, 'register retry');
        scheduleCommand(`/register ${password} ${password}`, 12000, 'final register retry');
    } else if (authMode === 'both') {
        scheduleCommand(`/register ${password} ${password}`, 250, 'initial register');
        scheduleCommand(`/login ${password}`, 1200, 'initial login');
        scheduleCommand(`/register ${password} ${password}`, 5000, 'register retry');
        scheduleCommand(`/login ${password}`, 7000, 'login retry');
        scheduleCommand(`/login ${password}`, 12000, 'final login retry');
    } else {
        scheduleCommand(`/login ${password}`, 250, 'initial login');
        scheduleCommand(`/login ${password}`, 5000, 'login retry');
        scheduleCommand(`/login ${password}`, 12000, 'final login retry');
    }

    return {
        handleMessage,
        onAuthenticated(callback) {
            if (authenticated) {
                callback();
                return;
            }
            authenticatedCallbacks.add(callback);
        },
        stop() {
            stopped = true;
            clearTimers();
            authenticatedCallbacks.clear();
        },
        markAuthenticated
    };
}

function updateLiveBotStats() {
    if (!activeBot || !activeBot.player) return;

    botStatus.pingMs = Number.isFinite(activeBot.player.ping) ? activeBot.player.ping : null;
    botStatus.health = Number.isFinite(activeBot.health) ? activeBot.health : null;
    botStatus.food = Number.isFinite(activeBot.food) ? activeBot.food : null;

    if (activeBot.entity?.position) {
        const { x, y, z } = activeBot.entity.position;
        botStatus.position = {
            x: Number(x.toFixed(2)),
            y: Number(y.toFixed(2)),
            z: Number(z.toFixed(2))
        };
    }

    if (botStatus.connected && botStatus.lastConnectAt) {
        botStatus.uptimeMs = Date.now() - Date.parse(botStatus.lastConnectAt);
    }
}

function getStatusSnapshot() {
    updateLiveBotStats();

    return {
        ...botStatus,
        generatedAt: isoNow(),
        server: {
            host: config.server.ip,
            port: config.server.port,
            version: config.server.version
        },
        account: {
            username: config['bot-account']['username'],
            type: config['bot-account']['type']
        }
    };
}

// --- RENDER KEEP-ALIVE + STATUS DASHBOARD ---
const http = require('http');
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    if (req.url === '/api/status') {
        const payload = getStatusSnapshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
    }

    if (req.url === '/' || req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Minecraft AFK Bot Status</title>
  <style>
    body { font-family: Inter, system-ui, Arial, sans-serif; background:#0f172a; color:#e2e8f0; margin:0; padding:24px; }
    .card { max-width:760px; margin:0 auto; background:#111827; border:1px solid #334155; border-radius:12px; padding:20px; }
    h1 { margin-top:0; font-size:1.4rem; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; margin-top:12px; }
    .item { background:#1f2937; border-radius:8px; padding:10px; }
    .label { color:#94a3b8; font-size:.85rem; }
    .value { font-size:1.05rem; margin-top:4px; font-weight:600; }
    .ok { color:#22c55e; }
    .warn { color:#f59e0b; }
    .mono { font-family: ui-monospace, Menlo, monospace; }
  </style>
</head>
<body>
  <div class="card">
    <h1>AFK Bot Live Status</h1>
    <div class="grid" id="stats"></div>
  </div>
<script>
function fmtMs(ms){
  if(!ms || ms < 0) return '0s';
  const s = Math.floor(ms/1000);
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const sec = s%60;
  return h ? (h + 'h ' + m + 'm ' + sec + 's') : (m + 'm ' + sec + 's');
}
function row(label, value, cls=''){
  return '<div class="item"><div class="label">' + label + '</div><div class="value ' + cls + '">' + value + '</div></div>';
}
async function refresh(){
  try{
    const r = await fetch('/api/status', {cache:'no-store'});
    const d = await r.json();
    const pos = d.position ? (d.position.x + ', ' + d.position.y + ', ' + d.position.z) : 'N/A';
    const connected = d.connected ? '<span class="ok">Connected</span>' : '<span class="warn">Disconnected</span>' ;
    document.getElementById('stats').innerHTML = [
      row('Connection', connected),
      row('Ping', d.pingMs ?? 'N/A'),
      row('Health', d.health ?? 'N/A'),
      row('Food', d.food ?? 'N/A'),
      row('Uptime', fmtMs(d.uptimeMs)),
      row('Position', '<span class="mono">' + pos + '</span>'),
      row('Reconnects', d.reconnectCount),
      row('Spawns', d.spawnCount),
      row('Chat Seen', d.chatMessagesSeen),
      row('Chat Sent', d.chatMessagesSent),
      row('Kicks', d.kickedCount),
      row('Errors', d.errorCount),
      row('Server', '<span class="mono">' + d.server.host + ':' + d.server.port + '</span>'),
      row('Last Connect', d.lastConnectAt ?? 'Never'),
      row('Last Disconnect', d.lastDisconnectAt ?? 'Never')
    ].join('');
  } catch (e) {
    document.getElementById('stats').innerHTML = row('Status', 'Failed to load API', 'warn');
  }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`);
        return;
    }

    res.statusCode = 404;
    res.end('Not found');
});
server.listen(port, () => console.log(`Keep-alive server running on port ${port}`));

function createBot() {
    botStatus.connectingSince = isoNow();
    botStatus.lastDisconnectReason = null;
    logResolvedServerAddress();

    const bot = mineflayer.createBot({
        username: config['bot-account']['username'],
        password: process.env.BOT_PASSWORD || config['bot-account']['password'],
        auth: config['bot-account']['type'],
        host: config.server.ip,
        port: config.server.port,
        version: config.server.version,
        keepAlive: true,
        checkTimeoutInterval: config.server['check-timeout-interval'] || 60000,
    });

    bot.loadPlugin(pathfinder);
    activeBot = bot;

    let sleepTaskRunning = false;
    let sleepInterval = null;
    let hungerInterval = null;
    let antiIdleController = null;
    let autoAuthController = null;
    let lastErrorCode = null;
    let runtimeStarted = false;

    bot.on('login', () => {
        botStatus.connected = true;
        botStatus.state = 'connected';
        botStatus.lastConnectAt = isoNow();
    });

    bot.once('spawn', () => {
        botStatus.connected = true;
        botStatus.connectingSince = null;
        botStatus.lastConnectAt = isoNow();
        botStatus.spawnCount += 1;
        botStatus.lastDisconnectReason = null;
        updateLiveBotStats();

        logger.info("Bot joined the server.");

        // Safer movement profile (prevents breaking blocks/fences while pathing)
        const movement = new Movements(bot);
        movement.canDig = false;
        movement.allowParkour = false;
        movement.allowSprinting = false;
        movement.canOpenDoors = false;
        bot.pathfinder.setMovements(movement);

        const startRuntime = () => {
            if (runtimeStarted) return;
            runtimeStarted = true;

            logger.info("Starting Survival Brain...");
            startBrainLoop(bot);

            const sleepRetryMs = config.utils['auto-sleep']['retry-interval-ms'] || 2500;
            sleepInterval = setInterval(() => {
                attemptAutoSleep(bot, () => sleepTaskRunning = true, () => sleepTaskRunning = false, () => sleepTaskRunning);
            }, sleepRetryMs);

            if (config.utils.behavior.enabled) startHumanActivityLoop(bot);
            if (config.utils.behavior.enabled) antiIdleController = startAntiIdleHeartbeatLoop(bot);
            if (config.utils['chat-messages'].enabled) startChatLoop(bot);
            hungerInterval = setInterval(() => checkHunger(bot), 10000);
        };

        // --- AUTH ---
        autoAuthController = createAutoAuthController(bot);
        if (autoAuthController) {
            autoAuthController.onAuthenticated(startRuntime);
            setTimeout(startRuntime, 15000);
        } else {
            startRuntime();
        }
    });

    bot.on('time', () => {
        // Trigger immediate sleep attempt right when night starts.
        if (bot.time.isNight) {
            attemptAutoSleep(bot, () => sleepTaskRunning = true, () => sleepTaskRunning = false, () => sleepTaskRunning);
        }
    });

    bot.on('sleep', () => {
        logger.info('Bot is now sleeping.');
    });

    bot.on('wake', () => {
        logger.info('Woke up.');
    });

    bot.on('chat', (username, message) => {
        if (username !== bot.username) botStatus.chatMessagesSeen += 1;

        if (config.utils['chat-log'] && username !== bot.username) {
            logger.info(`<${username}> ${message}`);
        }
    });

    bot.on('messagestr', (message) => {
        autoAuthController?.handleMessage(message);
    });

    bot.on('message', (message) => {
        autoAuthController?.handleMessage(message);
    });

    bot.on('kicked', (reason) => {
        botStatus.kickedCount += 1;
        botStatus.lastDisconnectReason = `kicked: ${reason}`;
        autoAuthController?.stop();
        logger.warn(`Kicked: ${reason}`);
    });

    bot.on('error', (err) => {
        botStatus.errorCount += 1;
        botStatus.lastError = err.message;
        lastErrorCode = err.code || null;
        if (isNetworkErrorCode(lastErrorCode)) {
            botStatus.lastDisconnectReason = `network error: ${lastErrorCode}`;
        }
        logger.error(`Error: ${err.message}`);
    });
    
    bot.on('end', () => {
        botStatus.connected = false;
        botStatus.lastDisconnectAt = isoNow();
        botStatus.uptimeMs = 0;
        if (!botStatus.lastDisconnectReason) botStatus.lastDisconnectReason = 'connection ended';
        if (activeBot === bot) activeBot = null;
        if (sleepInterval) clearInterval(sleepInterval);
        if (hungerInterval) clearInterval(hungerInterval);
        if (antiIdleController) antiIdleController.stop();
        if (autoAuthController) autoAuthController.stop();

        if (config.utils['auto-reconnect']) {
            botStatus.reconnectCount += 1;
            const reconnect = getReconnectDelay(lastErrorCode);
            const reasonLabel = reconnect.isNetworkError ? ` after ${lastErrorCode}` : '';
            logger.info(`Reconnecting in ${Math.round(reconnect.delayMs / 1000)}s${reasonLabel}...`);
            setTimeout(createBot, reconnect.delayMs);
        }
    });
}

let lastSleepNoBedLogAt = 0;

async function attemptAutoSleep(bot, setBusy, clearBusy, isBusy) {
    if (!config.utils['auto-sleep']?.enabled) return;
    if (!bot?.entity || bot.isSleeping || !bot.time?.isNight) return;
    if (isBusy()) return;

    setBusy();

    try {
        const bedSearchRadius = config.utils['auto-sleep']['bed-search-radius'] || 20;
        const approachDistance = config.utils['auto-sleep']['approach-distance'] || 2;
        const noBedLogCooldownMs = config.utils['auto-sleep']['no-bed-log-cooldown-ms'] || 30000;
        const bed = bot.findBlock({ matching: block => bot.isABed(block), maxDistance: bedSearchRadius });

        if (!bed) {
            const now = Date.now();
            if (now - lastSleepNoBedLogAt >= noBedLogCooldownMs) {
                logger.info('Night detected but no reachable bed found nearby.');
                lastSleepNoBedLogAt = now;
            }
            return;
        }

        // Move close to bed first to reduce sleep failures.
        const nearBed = new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, approachDistance);
        if (!bot.pathfinder.isMoving()) {
            bot.pathfinder.setGoal(nearBed);
        }

        const tooFar = bot.entity.position.distanceTo(bed.position) > approachDistance + 0.5;
        if (tooFar) return;

        bot.deactivateItem();
        await bot.sleep(bed);
        logger.info('Sleeping in bed for the night.');
    } catch (err) {
        // Common reasons: bed occupied, not close enough yet, monsters nearby.
        logger.info(`Sleep attempt failed: ${err.message}`);
    } finally {
        clearBusy();
    }
}


function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pulseControl(bot, control, holdMin = 100, holdMax = 350) {
    const holdMs = randomBetween(holdMin, holdMax);
    bot.setControlState(control, true);
    setTimeout(() => bot.setControlState(control, false), holdMs);
}

function pickRandom(arr, fallback) {
    if (!Array.isArray(arr) || arr.length === 0) return fallback;
    return arr[Math.floor(Math.random() * arr.length)];
}

function doAntiIdlePulse(bot) {
    if (!bot?.entity || bot.isSleeping || bot.pathfinder.isMoving()) return;

    const cfg = config.utils.behavior['anti-idle-heartbeat'] || {};
    const action = pickRandom(cfg.actions, 'look');

    if (action === 'jump') {
        pulseControl(bot, 'jump', 120, 260);
        return;
    }

    if (action === 'sneak') {
        pulseControl(bot, 'sneak', 400, 1200);
        return;
    }

    if (action === 'swing') {
        bot.swingArm();
        return;
    }

    if (action === 'step') {
        const r = Math.max(1, config.utils.behavior['move-radius'] || 2);
        const pos = bot.entity.position;
        const tx = pos.x + (Math.random() * r * 2) - r;
        const tz = pos.z + (Math.random() * r * 2) - r;
        bot.pathfinder.setGoal(new goals.GoalXZ(tx, tz));
        return;
    }

    const yawOffset = (Math.random() - 0.5) * 1.2;
    const pitchOffset = (Math.random() - 0.5) * 0.35;
    bot.look(bot.entity.yaw + yawOffset, bot.entity.pitch + pitchOffset, true);
}

function startAntiIdleHeartbeatLoop(bot) {
    const cfg = config.utils.behavior['anti-idle-heartbeat'] || {};
    if (!cfg.enabled) return null;

    const minS = Math.max(3, cfg['interval-min'] || 8);
    const maxS = Math.max(minS, cfg['interval-max'] || 14);

    let stopped = false;
    let timer = null;

    const scheduleNext = () => {
        if (stopped) return;
        const delayMs = randomBetween(minS, maxS) * 1000;
        timer = setTimeout(() => {
            if (stopped) return;
            doAntiIdlePulse(bot);
            scheduleNext();
        }, delayMs);
    };

    scheduleNext();

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        }
    };
}

function startHumanActivityLoop(bot) {
    const humanCfg = config.utils.behavior['humanizer'] || {};
    const minS = humanCfg['interval-min'] || 18;
    const maxS = humanCfg['interval-max'] || 45;
    const delay = randomBetween(minS, maxS) * 1000;

    setTimeout(() => {
        if (!bot || !bot.entity) {
            startHumanActivityLoop(bot);
            return;
        }

        // Skip if bot is pathing/fighting/sleeping
        const busy = bot.pathfinder.isMoving() || bot.isSleeping;
        if (!busy) {
            const roll = Math.random();

            // Most common: just subtle view changes
            if (roll < 0.5) {
                const yawOffset = (Math.random() - 0.5) * 0.7;
                const pitchOffset = (Math.random() - 0.5) * 0.25;
                bot.look(bot.entity.yaw + yawOffset, bot.entity.pitch + pitchOffset, true);
            }
            // Occasional short crouch pulse
            else if (roll < 0.72) {
                pulseControl(bot, 'sneak', 300, 1300);
            }
            // Occasional jump (anti-afk friendly, still natural)
            else if (roll < 0.88) {
                pulseControl(bot, 'jump', 120, 260);
            }
            // Rarely swing hand like a player adjusting
            else {
                bot.swingArm();
            }
        }

        startHumanActivityLoop(bot);
    }, delay);
}

// --- MAIN BRAIN LOOP ---
function startBrainLoop(bot) {
    // Randomize reaction time (Human-like)
    const nextActionDelay = Math.floor(Math.random() * 3000) + 1000;

    setTimeout(() => {
        if (!bot || !bot.entity) {
            startBrainLoop(bot); 
            return;
        }

        // 1. COMBAT LOGIC
        if (config.utils.combat.enabled) {
            const enemy = bot.nearestEntity(e => 
                (e.type === 'hostile' || e.type === 'mob') && 
                e.position.distanceTo(bot.entity.position) < config.utils.combat['kill-radius']
            );

            if (enemy) {
                // A. EQUIP WEAPON (If we have one)
                const weapons = config.utils.combat['preferred-weapons'];
                const weapon = bot.inventory.items().find(item => weapons.includes(item.name));
                if (weapon) bot.equip(weapon, 'hand');

                // B. EQUIP SHIELD (If we have one in inventory but not in hand)
                const shieldInInv = bot.inventory.items().find(item => item.name === 'shield');
                const shieldInHand = bot.entity.equipment[1] && bot.entity.equipment[1].name === 'shield';
                
                if (shieldInInv && !shieldInHand) {
                    bot.equip(shieldInInv, 'off-hand');
                }

                // C. ATTACK LOGIC
                bot.lookAt(enemy.position.offset(0, enemy.height, 0));
                
                // Only try to block if we ACTUALLY have a shield equipped right now
                if (shieldInHand && enemy.position.distanceTo(bot.entity.position) < 2.5) {
                    bot.activateItem(true); // Raise Shield
                } else {
                    bot.deactivateItem();   // Lower Shield (or do nothing if no shield)
                    bot.attack(enemy);      // Attack
                }

                // If fighting, check again very quickly (0.4s)
                setTimeout(() => startBrainLoop(bot), 400); 
                return;
            } else {
                 // No enemy nearby? Lower shield just in case.
                 bot.deactivateItem();
            }
        }

        // 2. SLEEPING LOGIC (handled by dedicated sleep enforcer loop)
        if (bot.isSleeping) {
            setTimeout(() => startBrainLoop(bot), 5000);
            return;
        }

        // 3. STEALTH IDLE (Only happens if safe)
        doStealthAction(bot);
        startBrainLoop(bot);

    }, nextActionDelay);
}

// --- EATING LOGIC ---
async function checkHunger(bot) {
    if (bot.food < 16 || bot.health < 15) {
        const food = bot.inventory.items().find(item => item.name.includes('cooked') || item.name.includes('bread') || item.name.includes('steak'));
        if (food) {
            logger.info("Eating food...");
            try {
                // Determine which hand to use (avoid swapping weapon if possible)
                await bot.equip(food, 'hand');
                await bot.consume();
            } catch(e) {
                // Ignore errors (sometimes happens if item runs out mid-eat)
            }
        }
    }
}

function doStealthAction(bot) {
    if (!config.utils.behavior.enabled) return;

    const confinement = config.utils.behavior.confinement;
    if (confinement?.enabled && bot.entity) {
        const center = new Vec3(confinement.x, confinement.y, confinement.z);
        const radius = confinement.radius || 1.5;
        if (bot.entity.position.distanceTo(center) > radius) {
            bot.pathfinder.setGoal(new goals.GoalNear(center.x, center.y, center.z, Math.max(radius - 0.25, 0.5)));
            return;
        }
    }

    const action = Math.floor(Math.random() * 10); 
    
    // Look around
    if (action < 3) { 
        bot.look(bot.entity.yaw + (Math.random() - 0.5), bot.entity.pitch + (Math.random() - 0.5) * 0.5);
    } 
    // Small step (Wander inside fence)
    else if (action === 5) {
        const r = config.utils.behavior['move-radius'] || 2;
        const pos = bot.entity.position;
        const tx = pos.x + (Math.random() * r * 2) - r;
        const tz = pos.z + (Math.random() * r * 2) - r;

        if (!bot.pathfinder.isMoving()) {
            bot.pathfinder.setGoal(new goals.GoalXZ(tx, tz));
        }
    }
}

function startChatLoop(bot) {
    const min = config.utils['chat-messages']['random-delay-min'] || 300;
    const max = config.utils['chat-messages']['random-delay-max'] || 900;
    const delay = (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
    setTimeout(() => {
        const msgs = config.utils['chat-messages'].messages;
        if (Array.isArray(msgs) && msgs.length > 0) {
            bot.chat(msgs[Math.floor(Math.random() * msgs.length)]);
            botStatus.chatMessagesSent += 1;
        }
        startChatLoop(bot);
    }, delay);
}

createBot();
