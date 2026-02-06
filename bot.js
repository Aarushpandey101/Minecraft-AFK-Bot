const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const GoalBlock = goals.GoalBlock;
const config = require('./settings.json');
const loggers = require('./logging.js');
const logger = loggers.logger;

// --- RENDER KEEP-ALIVE START ---
const http = require('http');
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bot is running!');
});
server.listen(port, () => {
    console.log(`Keep-alive server running on port ${port}`);
});
// --- RENDER KEEP-ALIVE END ---

function createBot() {
    const bot = mineflayer.createBot({
        username: config['bot-account']['username'],
        password: process.env.BOT_PASSWORD || config['bot-account']['password'],
        auth: config['bot-account']['type'],
        host: config.server.ip,
        port: config.server.port,
        version: config.server.version,
    });

    bot.loadPlugin(pathfinder);

    bot.once('inject_allowed', () => {
        const mcData = require('minecraft-data')(bot.version);
        const defaultMove = new Movements(bot, mcData);
        bot.settings.colorsEnabled = false;
        bot.pathfinder.setMovements(defaultMove);
    });

    bot.once('spawn', () => {
        logger.info("Bot joined the server.");

        // --- AUTHENTICATION ---
        if (config.utils['auto-auth'].enabled) {
            let password = process.env.BOT_PASSWORD || config.utils['auto-auth'].password;
            // Wait a random time between 2s and 5s before logging in (looks more human)
            const loginDelay = Math.floor(Math.random() * 3000) + 2000;
            
            setTimeout(() => {
                // Only sending login. Spamming register + login is a bot red flag.
                // Ensure you have registered 'Pookie' manually or via console first!
                bot.chat(`/login ${password}`);
                logger.info(`Sent login command.`);
            }, loginDelay);
        }

        // --- STEALTH BEHAVIOR ---
        if (config.utils.behavior && config.utils.behavior.enabled) {
            logger.info("Starting stealth behavior loop...");
            startBehaviorLoop(bot);
        }

        // --- CHAT SYSTEM ---
        if (config.utils['chat-messages'].enabled) {
            startChatLoop(bot);
        }

        // --- GO TO POSITION (OPTIONAL) ---
        if (config.position && config.position.enabled) {
            bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
        }
    });

    bot.on('chat', (username, message) => {
        if (config.utils['chat-log'] && username !== bot.username) {
            logger.info(`<${username}> ${message}`);
        }
    });

    bot.on('death', () => {
        logger.warn(`Bot died. Waiting for respawn...`);
    });

    bot.on('kicked', (reason) => {
        let reasonText = reason;
        try {
            const r = JSON.parse(reason);
            reasonText = r.text || (r.extra && r.extra[0] ? r.extra[0].text : reason);
        } catch (e) {
            // use raw reason
        }
        logger.warn(`Bot was kicked: ${reasonText}`);
    });

    bot.on('end', () => {
        if (config.utils['auto-reconnect']) {
            const delay = config.utils['auto-reconnect-delay'] || 30000;
            logger.info(`Disconnected. Reconnecting in ${delay / 1000} seconds...`);
            setTimeout(createBot, delay);
        }
    });

    bot.on('error', (err) => logger.error(`Error: ${err.message}`));
}

// --- HUMANIZED BEHAVIOR LOGIC ---

function startBehaviorLoop(bot) {
    // Randomly decide what to do next:
    // 0 = look around, 1 = jump/sneak, 2 = walk slightly, 3 = swing arm, 4 = do nothing
    
    const nextActionDelay = Math.floor(Math.random() * 15000) + 5000; // Act every 5-20 seconds

    setTimeout(() => {
        if (!bot || !bot.entity) return;

        const action = Math.floor(Math.random() * 10); 

        if (action < 3) { 
            // 30% chance: Look at a random nearby block
            bot.look(bot.entity.yaw + (Math.random() - 0.5), bot.entity.pitch + (Math.random() - 0.5) * 0.5);
        } 
        else if (action === 3) {
            // 10% chance: Swing arm
            bot.swingArm('right');
        }
        else if (action === 4) {
             // 10% chance: Quick sneak
             bot.setControlState('sneak', true);
             setTimeout(() => bot.setControlState('sneak', false), 500);
        }
        else if (action === 5) {
            // 10% chance: Small Random Walk (Stealth Movement)
            const r = config.utils.behavior['move-radius'] || 3;
            const pos = bot.entity.position;
            // Pick a random spot nearby
            const tx = pos.x + (Math.random() * r * 2) - r;
            const tz = pos.z + (Math.random() * r * 2) - r;
            
            // Only move if we aren't already moving
            if (!bot.pathfinder.isMoving()) {
                bot.pathfinder.setGoal(new goals.GoalXZ(tx, tz));
            }
        }
        // 40% chance: Do nothing (Idling is human!)

        // Restart loop
        startBehaviorLoop(bot);
    }, nextActionDelay);
}

function startChatLoop(bot) {
    const min = config.utils['chat-messages']['random-delay-min'] || 300;
    const max = config.utils['chat-messages']['random-delay-max'] || 900;
    
    // Calculate random delay in seconds, convert to ms
    const delay = (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;

    setTimeout(() => {
        if (!bot || !bot.entity) return;
        
        const msgs = config.utils['chat-messages'].messages;
        const msg = msgs[Math.floor(Math.random() * msgs.length)];
        
        bot.chat(msg);
        
        // Restart loop
        startChatLoop(bot);
    }, delay);
}

createBot();
