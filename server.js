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

// ✅ Improved CORS setup (allow explicit origins, methods, and headers incl. x-api-key)
const allowedOrigins = CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
const corsOptionsDelegate = function (req, callback) {
  const origin = req.headers && req.headers.origin;
  const isAllowed = !origin || allowedOrigins.includes(origin);
  const opts = {
    origin: isAllowed,
    methods: ['GET','POST','OPTIONS'],
    allowedHeaders: ['Content-Type','x-api-key'],
    optionsSuccessStatus: 204
  };
  if (!isAllowed && origin) {
    console.warn('[WARN] Blocked CORS request from:', origin);
  }
  callback(null, opts);
};
app.use(cors(corsOptionsDelegate));
// Preflight for all routes
app.options('*', cors(corsOptionsDelegate));

app.use(express.json({ limit: '1mb' }));

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

// === Replays API ===
// Get replays for a course (public GET)
app.get('/replays', async (req, res) => {
  try {
    const course = String(req.query.course || 'c1');
    const device = req.query.device ? String(req.query.device) : undefined; // 'desktop' | 'mobile-p' | 'mobile-l'
    const snap = await db.ref(`/replays/${course}`).get();
    const val = snap.exists() ? snap.val() : {};
    // flatten to array
    let list = Object.values(val);
    if (device) {
      list = list.filter(x => x && x.device === device);
    }
    res.json({ replays: Array.isArray(list) ? list : [] });
  } catch (e) {
    console.error('[ERR] get replays', e);
    res.status(500).json({ error: 'Failed to load replays' });
  }
});

// Submit a replay (requires API key)
app.post('/replays/submit', requireApiKey, async (req, res) => {
  try {
    const { course, duration, samples, device } = req.body || {};
    const c = String(course || 'c1');
    if (!Array.isArray(samples) || samples.length === 0) {
      return res.status(400).json({ error: 'Invalid samples' });
    }
    const item = {
      duration: Number(duration) || 0,
      samples: samples.map(s => ({ t: Number(s.t)||0, rudder: Number(s.rudder)||0, sail: Number(s.sail)||0 })),
      device: ['desktop','mobile-p','mobile-l'].includes(String(device)) ? String(device) : 'desktop',
      savedAt: Date.now()
    };
    const ref = db.ref(`/replays/${c}`);
    const pushed = await ref.push(item);
    // trim to last 25
    const snap = await ref.get();
    if (snap.exists()){
      const entries = Object.entries(snap.val());
      if(entries.length > 25){
        const sorted = entries.sort((a,b)=> (a[1].savedAt||0)-(b[1].savedAt||0));
        const toDelete = sorted.slice(0, entries.length-25);
        await Promise.all(toDelete.map(([k])=> ref.child(k).remove()));
      }
    }
    res.json({ ok: true, id: pushed.key });
  } catch (e) {
    console.error('[ERR] submit replay', e);
    res.status(500).json({ error: 'Failed to submit replay' });
  }
});

// Admin: migrate existing replays to set device where missing
app.post('/replays/migrate-device', requireApiKey, async (req, res) => {
  try {
    const targetDevice = ['desktop','mobile-p','mobile-l'].includes(String(req.body?.device)) ? String(req.body.device) : 'desktop';
    const course = req.body?.course; // optional: 'c1'..'c5'; if omitted, migrate all
    const courses = course ? [String(course)] : ['c1','c2','c3','c4','c5'];
    let updated = 0, scanned = 0;
    for (const c of courses) {
      const ref = db.ref(`/replays/${c}`);
      const snap = await ref.get();
      if (!snap.exists()) continue;
      const entries = snap.val();
      const updates = {};
      for (const [k, v] of Object.entries(entries)) {
        scanned++;
        if (!v || v.device) continue;
        updates[`${k}/device`] = targetDevice;
        updated++;
      }
      if (Object.keys(updates).length) {
        await ref.update(updates);
      }
    }
    res.json({ ok: true, updated, scanned, device: targetDevice, courses });
  } catch (e) {
    console.error('[ERR] migrate-device', e);
    res.status(500).json({ error: 'Migration failed' });
  }
});

// Fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => console.log('⚓ Scoreboard server listening on :' + PORT));
