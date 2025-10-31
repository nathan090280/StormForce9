// Minimal Scoreboard Server (Express + Firebase RTDB)
// Env vars required on Render:
// - SCOREBOARD_API_KEY  (client must send in header x-api-key)
// - FIREBASE_DATABASE_URL (e.g. https://<project>-default-rtdb.firebaseio.com)
// - FIREBASE_SERVICE_ACCOUNT (entire JSON from Firebase Admin SDK, one-line string with \\n preserved)

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SCOREBOARD_API_KEY || '';
const FB_DB_URL = process.env.FIREBASE_DATABASE_URL;
const SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!SERVICE_ACCOUNT_JSON) {
  console.error('[ERR] Missing FIREBASE_SERVICE_ACCOUNT env var');
  process.exit(1);
}

// Initialize Firebase Admin using service account with \n fixed
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(
      SERVICE_ACCOUNT_JSON.replace(/\\n/g, '\n')
    );
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FB_DB_URL,
    });
    console.log('[OK] Firebase initialized with service account');
  } catch (e) {
    console.error('[ERR] Firebase init failed:', e.message);
    process.exit(1);
  }
}

const db = admin.database();
const app = express();
app.use(cors());
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
    res.json({ scores: Object.values(data) });
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

app.listen(PORT, () => console.log('Scoreboard server listening on :' + PORT));
