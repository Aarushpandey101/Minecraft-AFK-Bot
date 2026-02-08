const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const config = require('./settings.json');
const loggers = require('./logging.js');
const logger = loggers.logger;

// --- RENDER KEEP-ALIVE ---
const http = require('http');
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.end('Bot is running!');
});
server.listen(port, () => console.log(`Keep-alive server running on port ${port}`));

function createBot() {
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

    bot.once('spawn', () => {
        logger.info("Bot joined the server.");

        // Safer movement profile (prevents breaking blocks/fences while pathing)
        const movement = new Movements(bot);
        movement.canDig = false;
        movement.allowParkour = false;
        movement.allowSprinting = false;
        movement.canOpenDoors = false;
        bot.pathfinder.setMovements(movement);

        // --- AUTH ---
        if (config.utils['auto-auth'].enabled) {
            let password = process.env.BOT_PASSWORD || config.utils['auto-auth'].password;
            setTimeout(() => {
                bot.chat(`/login ${password}`);
                logger.info(`Logged in.`);
            }, 3000);
        }

        // --- START BRAIN ---
        logger.info("Starting Survival Brain...");
        startBrainLoop(bot);

        // --- HUMAN ACTIVITY LOOP ---
        if (config.utils.behavior.enabled) startHumanActivityLoop(bot);

        // --- CHAT ---
        if (config.utils['chat-messages'].enabled) startChatLoop(bot);
        
        // --- AUTO EAT (Check every 10 seconds) ---
        setInterval(() => checkHunger(bot), 10000);
    });

    bot.on('chat', (username, message) => {
        if (config.utils['chat-log'] && username !== bot.username) {
            logger.info(`<${username}> ${message}`);
        }
    });

    bot.on('kicked', (reason) => logger.warn(`Kicked: ${reason}`));
    bot.on('error', (err) => logger.error(`Error: ${err.message}`));
    
    bot.on('end', () => {
        if (config.utils['auto-reconnect']) {
            const baseDelay = config.utils['auto-reconnect-delay'];
            const jitter = config.utils['auto-reconnect-jitter'] || 0;
            const randomizedDelay = baseDelay + Math.floor(Math.random() * (jitter + 1));
            logger.info(`Reconnecting in ${Math.round(randomizedDelay / 1000)}s...`);
            setTimeout(createBot, randomizedDelay);
        }
    });
}


function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pulseControl(bot, control, holdMin = 100, holdMax = 350) {
    const holdMs = randomBetween(holdMin, holdMax);
    bot.setControlState(control, true);
    setTimeout(() => bot.setControlState(control, false), holdMs);
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

        // 2. SLEEPING LOGIC
        if (config.utils['auto-sleep'].enabled && (bot.time.isNight || bot.isRaining)) {
            const bedSearchRadius = config.utils['auto-sleep']['bed-search-radius'] || 20;
            const bed = bot.findBlock({ matching: block => bot.isABed(block), maxDistance: bedSearchRadius });
            if (bed && !bot.isSleeping) {
                bot.sleep(bed).catch(() => {});
                setTimeout(() => startBrainLoop(bot), 10000);
                return;
            }
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
        bot.chat(msgs[Math.floor(Math.random() * msgs.length)]);
        startChatLoop(bot);
    }, delay);
}

createBot();
