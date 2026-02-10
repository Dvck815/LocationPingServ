const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Access Controls
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// CONFIGURATION / CREDENTIALS
// ---------------------------------------------------------
const PASSWORD_USER = process.env.PASSWORD_USER || 'Espan@1500$$';
const PASSWORD_ADMIN = process.env.PASSWORD_ADMIN || 'Adm1nEsp@na#@';
const MONGODB_URI = process.env.MONGODB_URI;

// ---------------------------------------------------------
// DATA STRUCTURES
// ---------------------------------------------------------

// 1. Users Table (In-Memory)
// Map<username, { role: 'USER'|'ADMIN', token: string, lastSeen: number }>
const users = new Map();

// 2. Blacklist (Persistent/MongoDB)
// Schema Definition
const blacklistSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true }
});
const BlacklistUser = mongoose.model('BlacklistUser', blacklistSchema);

let blacklistCache = []; // Cached Array of strings (usernames)

async function loadBlacklist() {
    if (!mongoose.connection.readyState) return;
    try {
        const docs = await BlacklistUser.find({});
        blacklistCache = docs.map(doc => doc.username);
        console.log(`Loaded ${blacklistCache.length} blacklisted users from DB.`);
    } catch (err) {
        console.error('Failed to load blacklist:', err);
    }
}

// 3. Pings List (In-Memory)
// Array w/ objects: { id, x, y, z, label, dimension, expiresAt, type, author }
let pings = [];


// ---------------------------------------------------------
// DB CONNECTION
// ---------------------------------------------------------
if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
        .then(() => {
            console.log('Connected to MongoDB');
            loadBlacklist();
        })
        .catch(err => console.error('MongoDB connection error:', err));
} else {
    console.warn('WARNING: MONGODB_URI not set. Blacklist will be in-memory only (ephemeral).');
}

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------

function parseDuration(durationStr) {
    if (!durationStr) return 5 * 60 * 1000; // Default 5m
    const match = durationStr.match(/^(\d+)([smhdw])$/);
    if (!match) return 5 * 60 * 1000; // Fallback
    const val = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
        case 's': return val * 1000;
        case 'm': return val * 60 * 1000;
        case 'h': return val * 60 * 60 * 1000;
        case 'd': return val * 24 * 60 * 60 * 1000;
        case 'w': return val * 7 * 24 * 60 * 60 * 1000;
        default: return 5 * 60 * 1000;
    }
}

function getUserByToken(token) {
    for (const [username, session] of users.entries()) {
        if (session.token === token) {
            return { username, ...session };
        }
    }
    return null;
}

// Middleware: Authenticate Request
function authenticate(req, res, next) {
    const token = req.header('X-Auth-Token');
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const user = getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    // Late ban check
    if (blacklistCache.includes(user.username)) {
        return res.status(403).json({ error: 'User is blacklisted' });
    }

    // Update last seen
    const session = users.get(user.username);
    if (session) session.lastSeen = Date.now();

    req.user = user;
    next();
}

// ---------------------------------------------------------
// API ENDPOINTS
// ---------------------------------------------------------

// 1. Authentication
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Missing credentials' });
    }

    // Check Cache
    if (blacklistCache.includes(username)) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    let role = null;
    if (password === PASSWORD_ADMIN) {
        role = 'ADMIN';
    } else if (password === PASSWORD_USER) {
        role = 'USER';
    } else {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = uuidv4();
    users.set(username, {
        role,
        token,
        lastSeen: Date.now()
    });

    console.log(`User logged in: ${username} as ${role}`);
    return res.status(200).json({ token, role });
});

// 2. Pings (The "Switching" Logic)
app.get('/api/pings', authenticate, (req, res) => {
    res.json(pings);
});

app.post('/api/pings', authenticate, (req, res) => {
    const { x, y, z, label, dimension, duration, type } = req.body;
    const user = req.user;

    // Type Logic
    if (type === 'COORD') {
        if (user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Only admins can post COORD pings' });
        }
    } else if (type === 'LOCATION') {
        // Enforce "only one location ping per user"
        pings = pings.filter(p => !(p.author === user.username && p.type === 'LOCATION'));
    } else {
        return res.status(400).json({ error: 'Invalid ping type. Must be LOCATION or COORD' });
    }

    const durationMs = parseDuration(duration);
    const expiresAt = Date.now() + durationMs;

    const newPing = {
        id: uuidv4(),
        x, y, z,
        label,
        dimension,
        type,
        author: user.username,
        expiresAt
    };

    pings.push(newPing);
    console.log(`New Ping: ${type} by ${user.username} (${label})`);
    res.status(200).json(newPing);
});

// 3. Blacklist Management (Admin Only) --- ASYNC for DB
app.post('/api/blacklist', authenticate, async (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin required' });
    }

    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    if (!blacklistCache.includes(username)) {
        // Update Cache
        blacklistCache.push(username);
        
        // Update DB
        if (mongoose.connection.readyState) {
            try {
                await BlacklistUser.create({ username });
            } catch (err) {
                console.error('Error adding to blacklist DB:', err);
                // Continue anyway to reflect in cache
            }
        }
        
        // Revoke active session
        if (users.has(username)) {
            users.delete(username);
        }
        console.log(`User blacklisted: ${username}`);
    }

    res.status(200).json({ success: true, blacklist: blacklistCache });
});

app.delete('/api/blacklist', authenticate, async (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin required' });
    }

    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    const index = blacklistCache.indexOf(username);
    if (index !== -1) {
        // Update Cache
        blacklistCache.splice(index, 1);

        // Update DB
        if (mongoose.connection.readyState) {
            try {
                await BlacklistUser.findOneAndDelete({ username });
            } catch (err) {
                console.error('Error removing from blacklist DB:', err);
            }
        }
        
        console.log(`User un-blacklisted: ${username}`);
    }

    res.status(200).json({ success: true, blacklist: blacklistCache });
});

app.get('/api/blacklist', authenticate, (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin required' });
    }
    res.json(blacklistCache);
});

// 4. Deletion
app.delete('/api/pings/:id', authenticate, (req, res) => {
    const { id } = req.params;
    const user = req.user;

    const pingIndex = pings.findIndex(p => p.id === id);
    if (pingIndex === -1) {
        return res.status(404).json({ error: 'Ping not found' });
    }

    const ping = pings[pingIndex];

    if (user.role === 'ADMIN') {
        pings.splice(pingIndex, 1);
        return res.status(200).json({ success: true, message: 'Ping deleted by admin' });
    } else {
        if (ping.author === user.username) {
            pings.splice(pingIndex, 1);
            return res.status(200).json({ success: true, message: 'Ping deleted by author' });
        } else {
            return res.status(403).json({ error: 'You can only delete your own pings' });
        }
    }
});

// ---------------------------------------------------------
// AUTO-EXPIRATION
// ---------------------------------------------------------
setInterval(() => {
    const now = Date.now();
    const initialCount = pings.length;
    pings = pings.filter(p => p.expiresAt > now);
    const diff = initialCount - pings.length;
    // Log occasionally if cleaning up
    if (diff > 0) console.log(`Auto-removed ${diff} expired pings.`);
}, 10000);

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    if (!MONGODB_URI) console.log('Notice: Running in memory-only mode (No DB Connection).');
});
