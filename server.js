// Minimal Scoreboard Server (Express + Firebase RTDB)
// Env vars required on Render:
// - SCOREBOARD_API_KEY  (client must send in header x-api-key)
// - FIREBASE_PROJECT_ID
// - FIREBASE_DATABASE_URL (e.g. https://<project>-default-rtdb.firebaseio.com)
// Optional if using Application Default Credentials on Render: FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SCOREBOARD_API_KEY || '';
const FB_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FB_DB_URL = process.env.FIREBASE_DATABASE_URL;
const FB_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FB_PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Firebase Admin init: prefer service account if provided; otherwise try ADC
if(!admin.apps.length){
  try{
    if(FB_CLIENT_EMAIL && FB_PRIVATE_KEY){
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: FB_PROJECT_ID,
          clientEmail: FB_CLIENT_EMAIL,
          privateKey: FB_PRIVATE_KEY,
        }),
        databaseURL: FB_DB_URL,
      });
    } else {
      admin.initializeApp({ databaseURL: FB_DB_URL });
    }
  }catch(e){
    console.error('Firebase init failed:', e.message);
  }
}
const db = admin.database();

const app = express();
app.use(cors());
app.use(express.json());

function requireApiKey(req,res,next){
  if(!API_KEY){ return res.status(500).json({ error: 'Server not configured' }); }
  const got = req.get('x-api-key') || '';
  if(got !== API_KEY){ return res.status(401).json({ error: 'Unauthorized' }); }
  next();
}

// Health
app.get('/health', (req,res)=> res.json({ ok:true, time: Date.now() }));

// List scores (flat array)
app.get('/scores', async (req,res)=>{
  try{
    const snap = await db.ref('/scores').get();
    const data = snap.exists() ? snap.val() : {};
    res.json({ scores: Object.values(data) });
  }catch(e){ res.status(500).json({ error: 'Failed to load scores' }); }
});

// Submit or update best times
// Body: { name, device, c1?, c2?, c3?, c4?, c5? }
app.post('/scores/submit', requireApiKey, async (req,res)=>{
  try{
    const { name, device } = req.body || {};
    if(!name || !String(name).trim()) return res.status(400).json({ error: 'Missing name' });
    const key = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g,'-');

    const ref = db.ref(`/scores/${key}`);
    const snap = await ref.get();
    const existing = snap.exists() ? snap.val() : {};

    const next = {
      name: String(name).trim().slice(0, 40),
      device: device === 'mobile' ? 'mobile' : 'desktop',
      updatedAt: Date.now(),
    };
    for(const c of ['c1','c2','c3','c4','c5']){
      if(req.body[c] != null){
        const nv = Number(req.body[c]);
        if(Number.isFinite(nv)){
          const ov = Number(existing[c]);
          next[c] = Number.isFinite(ov) ? Math.min(ov, nv) : nv; // keep best (lowest)
        }
      } else if(existing[c] != null){
        next[c] = existing[c];
      }
    }

    await ref.set(next);
    res.json({ ok:true, saved: next });
  }catch(e){
    console.error('Submit error:', e);
    res.status(500).json({ error: 'Failed to submit' });
  }
});

// Fallback
app.use((req,res)=> res.status(404).json({ error: 'Not found' }));

app.listen(PORT, ()=> console.log('Scoreboard server on :' + PORT));
