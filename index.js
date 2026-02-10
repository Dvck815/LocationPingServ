const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Access Controls
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// DATA STRUCTURES
// ---------------------------------------------------------

// 1. Users Table (In-Memory)
// Map<username, { role: 'USER'|'ADMIN', token: string, lastSeen: number }>
const users = new Map();

// 2. Blacklist (Persistent/JSON)
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');
let blacklist = []; // Array of strings (usernames)

// Load blacklist on startup
try {
    if (fs.existsSync(BLACKLIST_FILE)) {
        const data = fs.readFileSync(BLACKLIST_FILE, 'utf8');
        blacklist = JSON.parse(data);
        console.log(`Loaded ${blacklist.length} blacklisted users.`);
    } else {
        // Initialize file if not exists
        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([], null, 2));
    }
} catch (err) {
    console.error('Failed to load blacklist:', err);
}

// 3. Pings List (In-Memory based on prompt implying standard but transient storage for switch)
// Array w/ objects: { id, x, y, z, label, dimension, expiresAt, type, author }
let pings = [];

// ---------------------------------------------------------
// CONFIGURATION / CREDENTIALS
// ---------------------------------------------------------
const PASSWORD_USER = process.env.PASSWORD_USER || 'Espan@1500$$';
const PASSWORD_ADMIN = process.env.PASSWORD_ADMIN || 'Adm1nEsp@na#@';

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------

function saveBlacklist() {
    try {
        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(blacklist, null, 2));
    } catch (err) {
        console.error('Failed to save blacklist:', err);
    }
}

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
    if (blacklist.includes(user.username)) {
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
        // Technically not specified, but good practice
        return res.status(400).json({ error: 'Missing credentials' });
    }

    // Blacklist check
    if (blacklist.includes(username)) {
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
    // Already validated by middleware
    // Return list of active pings
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
        // Search existing pings where author == username AND type == LOCATION
        // Delete them (Enforce "only one location ping per user")
        pings = pings.filter(p => !(p.author === user.username && p.type === 'LOCATION'));
    } else {
        // Unknown type - maybe reject or default? 
        // Prompt implies these are the types. Let's start by defaulting to nothing or rejecting.
        // I'll reject for safety.
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

// 3. Blacklist Management (Admin Only)
app.post('/api/blacklist', authenticate, (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin required' });
    }

    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    if (!blacklist.includes(username)) {
        blacklist.push(username);
        saveBlacklist();
        
        // Revoke any active sessions
        if (users.has(username)) {
            users.delete(username);
        }
        console.log(`User blacklisted: ${username}`);
    }

    res.status(200).json({ success: true, blacklist });
});

app.delete('/api/blacklist', authenticate, (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin required' });
    }

    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    const index = blacklist.indexOf(username);
    if (index !== -1) {
        blacklist.splice(index, 1);
        saveBlacklist();
        console.log(`User un-blacklisted: ${username}`);
    }

    res.status(200).json({ success: true, blacklist });
});

app.get('/api/blacklist', authenticate, (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin required' });
    }
    res.json(blacklist);
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

    // Logic:
    // If Admin: Can delete any ping.
    // If User: Can only delete pings where ping.author == user.username.
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
// Background task to remove pings where now > expiresAt
setInterval(() => {
    const now = Date.now();
    const initialCount = pings.length;
    pings = pings.filter(p => p.expiresAt > now);
    const diff = initialCount - pings.length;
    if (diff > 0) {
        console.log(`Auto-removed ${diff} expired pings.`);
    }
}, 10000); // Check every 10 seconds

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin Password: ${PASSWORD_ADMIN}`);
    console.log(`User Password: ${PASSWORD_USER}`);
});
