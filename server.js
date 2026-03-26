const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'scores.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_NICK_LEN = 18;
const MAX_SCORE = 100000000;
const MAX_ROWS = 100;

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ games: {} }, null, 2), 'utf8');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(text);
}

function readDb() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { games: {} };
    if (!parsed.games || typeof parsed.games !== 'object') parsed.games = {};
    return parsed;
  } catch (err) {
    return { games: {} };
  }
}

function writeDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function normalizeNick(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NICK_LEN);
}

function normalizeGame(raw) {
  return String(raw || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '')
    .slice(0, 40) || 'default';
}

function normalizeScore(raw) {
  const n = Math.floor(Number(raw) || 0);
  return Math.max(0, Math.min(MAX_SCORE, n));
}

function getScores(game) {
  const db = readDb();
  const rows = Object.entries(db.games[game] || {})
    .map(([nick, best]) => ({ nick, best: normalizeScore(best) }))
    .filter((row) => row.nick)
    .sort((a, b) => b.best - a.best || a.nick.localeCompare(b.nick, 'tr'))
    .slice(0, MAX_ROWS);
  return rows;
}

function upsertScore(game, nick, best) {
  const db = readDb();
  if (!db.games[game]) db.games[game] = {};
  const currentBest = normalizeScore(db.games[game][nick] || 0);
  const nextBest = Math.max(currentBest, best);
  db.games[game][nick] = nextBest;
  writeDb(db);
  return nextBest;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(reqPath, res) {
  const safePath = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const typeMap = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, {
      'Content-Type': typeMap[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, port: PORT });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/scores') {
    const game = normalizeGame(url.searchParams.get('game'));
    sendJson(res, 200, { game, scores: getScores(game) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/scores') {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const game = normalizeGame(body.game);
      const nick = normalizeNick(body.nick);
      const best = normalizeScore(body.best);

      if (!nick) {
        sendJson(res, 400, { error: 'Nick gerekli.' });
        return;
      }

      const savedBest = upsertScore(game, nick, best);
      sendJson(res, 200, {
        ok: true,
        game,
        nick,
        best: savedBest,
        scores: getScores(game)
      });
      return;
    } catch (err) {
      sendJson(res, 400, { error: 'Gecersiz JSON gonderildi.' });
      return;
    }
  }

  if (req.method === 'GET') {
    serveStatic(url.pathname, res);
    return;
  }

  sendText(res, 405, 'Method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log(`Frozen Tower Rush server running at http://localhost:${PORT}`);
});
