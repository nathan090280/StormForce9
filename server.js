// Minimal Scoreboard Server (Express + Firebase RTDB)
// Env vars required on Render:
// - SCOREBOARD_API_KEY  (client must send in header x-api-key)
// - FIREBASE_DATABASE_URL (e.g. https://<project>-default-rtdb.firebaseio.com)
// - FIREBASE_SERVICE_ACCOUNT (entire JSON from Firebase Admin SDK, one-line string with \n preserved)
// - CORS_ORIGINS (comma-separated list of allowed domains, e.g. https://yourgame.itch.io,https://yourgame.netlify.app)

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SCOREBOARD_API_KEY || '';
const FB_DB_URL = process.env.FIREBASE_DATABASE_URL;
const SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const CORS_ORIGINS = process.env.CORS_ORIGINS || '';

if (!SERVICE_ACCOUNT_JSON) {
  console.error('[ERR] Missing FIREBASE_SERVICE_ACCOUNT env var');
  process.exit(1);
}

// Initialize Firebase Admin using service account
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(SERVICE_ACCOUNT_JSON);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FB_DB_URL,
    });

    console.log('[OK] Firebase initialized with service account');
  } catch (e) {
    console.error('[ERR] Firebase init failed:', e.message);
    console.error('[ERR] Did you paste the SERVICE_ACCOUNT JSON as a single line with proper \\n escapes?');
    process.exit(1);
  }
}

const db = admin.database();
const app = express();

// ✅ Improved CORS setup
const allowedOrigins = CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn('[WARN] Blocked CORS request from:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use(express.json());

// Middleware: require API key
function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: 'Server not configured' });
  const got = req.get('x-api-key') || '';
  if (got !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Health endpoint
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// List all scores
app.get('/scores', async (req, res) => {
  try {
    const snap = await db.ref('/scores').get();
    const data = snap.exists() ? snap.val() : {};
    const scores = Object.values(data);
    
    // Sort by time for current course (default: course 1, fastest first)
    const course = req.query.course || 'c1';
    const sortDir = req.query.dir === 'desc' ? -1 : 1;
    
    scores.sort((a, b) => {
      const aTime = a[course] || Infinity;
      const bTime = b[course] || Infinity;
      return sortDir * (aTime - bTime);
    });
    
    res.json({ scores });
  } catch (e) {
    console.error('[ERR] list scores', e);
    res.status(500).json({ error: 'Failed to load scores' });
  }
});

// Submit or update scores
app.post('/scores/submit', requireApiKey, async (req, res) => {
  try {
    const { name, device } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Missing name' });

    const key = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
    const ref = db.ref(`/scores/${key}`);
    const snap = await ref.get();
    const existing = snap.exists() ? snap.val() : {};

    const next = {
      name: String(name).trim().slice(0, 40),
      device: device === 'mobile' ? 'mobile' : 'desktop',
      updatedAt: Date.now(),
    };

    for (const c of ['c1', 'c2', 'c3', 'c4', 'c5']) {
      if (req.body[c] != null) {
        const nv = Number(req.body[c]);
        if (Number.isFinite(nv)) {
          const ov = Number(existing[c]);
          next[c] = Number.isFinite(ov) ? Math.min(ov, nv) : nv;
        }
      } else if (existing[c] != null) {
        next[c] = existing[c];
      }
    }

    await ref.set(next);
    res.json({ ok: true, saved: next });
  } catch (e) {
    console.error('[ERR] submit', e);
    res.status(500).json({ error: 'Failed to submit' });
  }
});

// Fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => console.log('⚓ Scoreboard server listening on :' + PORT));
