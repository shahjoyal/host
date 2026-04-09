require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Serve gift photo from player folder too (for host to upload, player to see)
const playerPublic = path.join(__dirname, '../player');
app.use('/player-static', express.static(playerPublic));

// Multer for gift photo upload — saves to player folder as photo.png
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, playerPublic),
    filename: (req, file, cb) => cb(null, 'photo.png')
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  }
});

// ─── MODELS ───────────────────────────────────────────────────────────────────
const GameStateSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  phase: { type: String, default: 'lobby' },
  currentRound: { type: Number, default: 1 },
  totalRounds: { type: Number, default: 5 },
  questions: [{ text: String, round: Number, mediaUrl: String, mediaType: String }],
  buzzerWinnerId: { type: String, default: null },
  buzzerWinnerName: { type: String, default: null },
  buzzerLockedAt: { type: Date, default: null },
  giftImageUrl: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now }
});

const PlayerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  sessionId: { type: String, required: true, unique: true },
  score: { type: Number, default: 0 },
  buzzerPressedRound: { type: Number, default: null },
  buzzerPressedAt: { type: Date, default: null },
  hasScratched: { type: Boolean, default: false },
  scratchedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const GameState = mongoose.model('GameState', GameStateSchema);
const Player = mongoose.model('Player', PlayerSchema);

// ─── DB CONNECT ───────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB connected (host)');
    await GameState.findOneAndUpdate(
      { key: 'main' },
      { $setOnInsert: { key: 'main' } },
      { upsert: true, new: true }
    );
  })
  .catch(err => console.error('MongoDB error:', err));

async function getState() { return GameState.findOne({ key: 'main' }); }
async function getPlayers() { return Player.find().sort({ score: -1, createdAt: 1 }); }

// ─── HOST API ROUTES ──────────────────────────────────────────────────────────

// GET /api/state — full state
app.get('/api/state', async (req, res) => {
  try {
    const state = await getState();
    const players = await getPlayers();
    res.json({ state, players });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/host/start — start/restart the game (lobby phase)
app.post('/api/host/start', async (req, res) => {
  try {
    const { totalRounds, questions } = req.body;
    await GameState.updateOne({ key: 'main' }, {
      phase: 'lobby',
      currentRound: 1,
      totalRounds: totalRounds || 5,
      questions: questions || [],
      buzzerWinnerId: null,
      buzzerWinnerName: null,
      buzzerLockedAt: null,
      giftImageUrl: null,
      updatedAt: new Date()
    });
    // Clear player buzzer/scratch state but keep names & scores
    await Player.updateMany({}, {
      buzzerPressedRound: null,
      buzzerPressedAt: null,
      hasScratched: false,
      scratchedAt: null
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/host/phase — change phase
app.post('/api/host/phase', async (req, res) => {
  try {
    const { phase } = req.body;
    await GameState.updateOne({ key: 'main' }, { phase, updatedAt: new Date() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/host/score — update score for a player
app.post('/api/host/score', async (req, res) => {
  try {
    const { playerId, delta } = req.body; // delta = +10 or -10
    const player = await Player.findByIdAndUpdate(
      playerId,
      { $inc: { score: delta } },
      { new: true }
    );
    res.json({ success: true, player });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/host/next-round — go to next round, clear buzzer
// app.post('/api/host/next-round', async (req, res) => {
//   try {
//     const state = await getState();
//     const nextRound = (state.currentRound || 1) + 1;

//     await GameState.updateOne({ key: 'main' }, {
//       currentRound: nextRound,
//       phase: 'buzzer',
//       buzzerWinnerId: null,
//       buzzerWinnerName: null,
//       buzzerLockedAt: null,
//       updatedAt: new Date()
//     });
//     res.json({ success: true, nextRound });
//   } catch (e) { res.status(500).json({ error: e.message }); }
// });

app.post('/api/host/next-round', async (req, res) => {
  try {
    const state = await getState();
    const nextRound = (state.currentRound || 1) + 1;

    await GameState.updateOne({ key: 'main' }, {
      currentRound: nextRound,
      phase: 'buzzer',
      buzzerWinnerId: null,
      buzzerWinnerName: null,
      buzzerLockedAt: null,
      updatedAt: new Date()
    });

    // clear buzzer lock for every player so they can buzz again next round
    await Player.updateMany({}, {
      buzzerPressedRound: null,
      buzzerPressedAt: null
    });

    res.json({ success: true, nextRound });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/host/scratch — start scratch round
app.post('/api/host/scratch', async (req, res) => {
  try {
    await GameState.updateOne({ key: 'main' }, {
      phase: 'scratch',
      buzzerWinnerId: null,
      buzzerWinnerName: null,
      updatedAt: new Date()
    });
    await Player.updateMany({}, { hasScratched: false, scratchedAt: null });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/host/reveal-gift — trigger gift reveal for all
app.post('/api/host/reveal-gift', async (req, res) => {
  try {
    await GameState.updateOne({ key: 'main' }, {
      phase: 'gift_reveal',
      giftImageUrl: '/photo.png',
      updatedAt: new Date()
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/host/end — end the game, reset everything
app.post('/api/host/end', async (req, res) => {
  try {
    await GameState.updateOne({ key: 'main' }, {
      phase: 'ended', updatedAt: new Date()
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/host/full-reset — full reset including scores and players
app.post('/api/host/full-reset', async (req, res) => {
  try {
    await Player.deleteMany({});
    await GameState.updateOne({ key: 'main' }, {
      phase: 'lobby', currentRound: 1, totalRounds: 5,
      buzzerWinnerId: null, buzzerWinnerName: null, buzzerLockedAt: null,
      giftImageUrl: null, questions: [], updatedAt: new Date()
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/host/questions — update questions
app.post('/api/host/questions', async (req, res) => {
  try {
    const { questions } = req.body;
    await GameState.updateOne({ key: 'main' }, { questions, updatedAt: new Date() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/host/upload-gift — upload gift photo
app.post('/api/host/upload-gift', upload.single('photo'), async (req, res) => {
  try {
    res.json({ success: true, url: '/photo.png' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Multer for per-question media (images + audio)
const qMediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'public', 'q-media');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `q${req.body.idx}_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Images or audio only'));
  }
});

app.use('/q-media', express.static(path.join(__dirname, 'public', 'q-media')));

// POST /api/host/upload-question-media
app.post('/api/host/upload-question-media', qMediaUpload.single('media'), async (req, res) => {
  try {
    const url = `/q-media/${req.file.filename}`;
    res.json({ success: true, url, type: req.body.type });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// const PORT = process.env.PORT_HOST || 3002;
// app.listen(PORT, () => console.log(`🎬 Host app running on port ${PORT}`));


module.exports = app;