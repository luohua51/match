const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors'); // 👈 【新增这一行：引入跨域模块】
const app = express();
const PORT = process.env.PORT || 3000;

/* ============ 数据目录（Railway Volume 持久化） ============ */
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}
const DATA_FILE = path.join(DATA_DIR, 'data.json');

app.use(cors()); // 👈 【新增这一行：允许所有域名跨域访问】
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ============ 资源扫描 ============ */
function getAssetFiles(dir) {
  const fullPath = path.join(__dirname, 'public', dir);
  try {
    if (!fs.existsSync(fullPath)) return [];
    return fs.readdirSync(fullPath)
      .filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
      .sort();
  } catch (e) { return []; }
}

/* ============ 数据结构 ============ */
const MAX_PLAYERS = 16;
const DISPLAY_MODES = ['hero-wall', 'focus', 'carousel', 'scoreboard', 'hidden'];

function defaultPlayer(i) {
  return {
    id: `选手${i}`,
    avatar: '',
    tier: '',
    damage: '',
    heroes: new Array(5).fill(''),
    kills: new Array(5).fill(0),
    ranks: new Array(5).fill(null)
  };
}

function defaultData() {
  const players = [];
  for (let i = 1; i <= 12; i++) players.push(defaultPlayer(i));
  return {
    players,
    currentGame: 0,
    threshold: 39,  // 修改：默认赛点 39
    maxGames: 5,
    visible: true,
    scoreboardCollapsed: false,
    champion: null,
    cardPlayerId: null,
    displayMode: 'hero-wall',
    focusPlayerId: null,
    carouselRunning: false
  };
}

/* ============ 数据清洗 ============ */
function normalizeState(s) {
  if (!Array.isArray(s.players)) s.players = [];
  s.players.forEach(p => {
    p.id = p.id || '未命名';
    p.avatar = p.avatar || '';
    p.tier = p.tier || '';
    p.damage = p.damage || '';
    p.heroes = Array.isArray(p.heroes) ? p.heroes : [];
    p.kills  = Array.isArray(p.kills)  ? p.kills  : [];
    p.ranks  = Array.isArray(p.ranks)  ? p.ranks  : [];
    while (p.heroes.length < s.maxGames) p.heroes.push('');
    while (p.kills.length  < s.maxGames) p.kills.push(0);
    while (p.ranks.length  < s.maxGames) p.ranks.push(null);
    p.heroes = p.heroes.slice(0, s.maxGames);
    p.kills  = p.kills.slice(0, s.maxGames);
    p.ranks  = p.ranks.slice(0, s.maxGames);
  });
  if (typeof s.currentGame !== 'number') s.currentGame = 0;
  if (typeof s.threshold !== 'number' || s.threshold === 19) s.threshold = 39; // 兼容旧数据：自动升级为 39
  if (typeof s.maxGames !== 'number') s.maxGames = 5;
  if (typeof s.visible !== 'boolean') s.visible = true;
  if (typeof s.scoreboardCollapsed !== 'boolean') s.scoreboardCollapsed = false;
  if (s.cardPlayerId === undefined) s.cardPlayerId = null;
  if (!DISPLAY_MODES.includes(s.displayMode)) s.displayMode = 'hero-wall';
  if (s.focusPlayerId === undefined) s.focusPlayerId = null;
  if (typeof s.carouselRunning !== 'boolean') s.carouselRunning = false;
  return s;
}

/* ============ 加载 ============ */
let state = defaultData();

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state = normalizeState(Object.assign(defaultData(), saved));
    while (state.players.length < 12) {
      state.players.push(defaultPlayer(state.players.length + 1));
    }
    console.log('✅ 已加载数据:', DATA_FILE);
  } catch (e) {
    console.error('❌ 读取数据失败，使用默认数据', e);
  }
} else {
  normalizeState(state);
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    console.log('📝 首次启动，已创建:', DATA_FILE);
  } catch (e) {
    console.error('❌ 创建数据文件失败（可能目录只读）:', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('❌ 保存数据失败:', e.message);
  }
}

/* ============ 积分 & 冠军 ============ */
function computeStandings(s) {
  const { maxGames, threshold } = s;

  const players = s.players.map((p, idx) => {
    let total = 0;
    const games = [];
    for (let g = 0; g < maxGames; g++) {
      const kills = p.kills[g] || 0;
      const rank = p.ranks[g];
      const hero = p.heroes ? (p.heroes[g] || '') : '';
      const killPoints = kills * 1.5;
      
      // 修改：排名分 10 8 7 6 5 4 3 2 1
      const rankPoints = rank
        ? rank === 1 ? 10
        : rank === 2 ? 8
        : rank === 3 ? 7
        : rank === 4 ? 6
        : rank === 5 ? 5
        : rank === 6 ? 4
        : rank === 7 ? 3
        : rank === 8 ? 2
        : rank === 9 ? 1
        : 0
        : 0;

      const gameTotal = killPoints + rankPoints;
      total += gameTotal;
      games.push({ kills, rank, hero, killPoints, rankPoints, gameTotal, totalBefore: total - gameTotal });
    }
    return {
      id: p.id,
      avatar: p.avatar || '',
      tier: p.tier || '',
      damage: p.damage || '',
      total, games, index: idx
    };
  });

  let championId = null;
  let championGame = -1;
  const running = players.map(() => 0);

  for (let g = 0; g < maxGames; g++) {
    players.forEach((p, i) => {
      if (running[i] >= threshold && p.games[g].rank === 1) {
        if (championId === null || g < championGame) {
          championId = p.id;
          championGame = g;
        }
      }
    });
    players.forEach((p, i) => { running[i] += p.games[g].gameTotal; });
  }

  const allDone = s.players.every(p =>
    p.ranks[maxGames - 1] !== null && p.ranks[maxGames - 1] !== undefined
  );
  if (championId === null && allDone && players.length > 0) {
    const best = [...players].sort((a, b) => b.total - a.total)[0];
    if (best) championId = best.id;
  }

  players.forEach(p => { p.isChampion = (p.id === championId); });
  players.sort((a, b) => {
    if (a.isChampion && !b.isChampion) return -1;
    if (!a.isChampion && b.isChampion) return 1;
    return b.total - a.total;
  });
  players.forEach((p, i) => p.place = i + 1);

  return players.map(({ index, ...rest }) => rest);
}

/* ============ SSE ============ */
let clients = [];
function broadcast() {
  const standings = computeStandings(state);
  const payload = JSON.stringify({ ...state, standings });
  clients.forEach(client => {
    try { client.res.write(`data: ${payload}\n\n`); } catch (e) {}
  });
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // 关键：禁用反向代理缓冲
  res.flushHeaders();

  const client = { id: Date.now() + Math.random(), res };
  clients.push(client);

  const standings = computeStandings(state);
  res.write(`data: ${JSON.stringify({ ...state, standings })}\n\n`);

  // 每 25 秒发一次心跳，防止 Railway / 代理断开
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients = clients.filter(c => c.id !== client.id);
  });
});

/* ============ 管理员 API ============ */
app.get('/api/state', (req, res) => {
  res.json({
    ...state,
    standings: computeStandings(state),
    assets: {
      heroes: getAssetFiles('heroes'),
      avatars: getAssetFiles('avatars')
    }
  });
});

app.post('/api/update', (req, res) => {
  const ns = req.body;
  if (!ns.players || !Array.isArray(ns.players)) {
    return res.status(400).json({ error: '无效数据' });
  }
  if (ns.players.length < 2 || ns.players.length > MAX_PLAYERS) {
    return res.status(400).json({ error: `选手数量必须在 2-${MAX_PLAYERS} 之间` });
  }
  const merged = ns.players.map((p, i) => {
    const old = state.players.find(op => op.id === p.id) || state.players[i] || {};
    return {
      ...old,
      ...p,
      tier:   p.tier   !== undefined ? p.tier   : (old.tier   || ''),
      damage: p.damage !== undefined ? p.damage : (old.damage || ''),
      heroes: p.heroes || old.heroes || new Array(state.maxGames).fill('')
    };
  });
  state.players = merged;

  if (ns.currentGame !== undefined) state.currentGame = ns.currentGame;
  if (ns.threshold !== undefined) state.threshold = ns.threshold;
  if (ns.maxGames !== undefined) state.maxGames = ns.maxGames;
  if (ns.visible !== undefined) state.visible = ns.visible;
  if (ns.scoreboardCollapsed !== undefined) state.scoreboardCollapsed = ns.scoreboardCollapsed;
  if (ns.cardPlayerId !== undefined) state.cardPlayerId = ns.cardPlayerId;

  normalizeState(state);
  saveData();
  broadcast();
  res.json({ ok: true, standings: computeStandings(state) });
});

app.post('/api/reset', (req, res) => {
  state = defaultData();
  saveData();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/add-player', (req, res) => {
  if (state.players.length >= MAX_PLAYERS) {
    return res.status(400).json({ error: `最多 ${MAX_PLAYERS} 名选手` });
  }
  state.players.push(defaultPlayer(state.players.length + 1));
  saveData();
  broadcast();
  res.json({ ok: true, state });
});

/* ============ 切换当前局 ============ */
app.post('/api/game/current', (req, res) => {
  const g = parseInt((req.body || {}).game);
  if (isNaN(g) || g < 0 || g >= state.maxGames) {
    return res.status(400).json({ error: '无效局数' });
  }
  state.currentGame = g;
  saveData();
  broadcast();
  res.json({ ok: true });
});

/* ============ 展示模式控制 ============ */
app.post('/api/display/mode', (req, res) => {
  const { mode, focusPlayerId, carouselRunning } = req.body || {};
  if (mode && DISPLAY_MODES.includes(mode)) {
    state.displayMode = mode;
  }
  if (focusPlayerId !== undefined) state.focusPlayerId = focusPlayerId;
  if (typeof carouselRunning === 'boolean') state.carouselRunning = carouselRunning;
  saveData();
  broadcast();
  res.json({ ok: true });
});

/* ============ 选手 API ============ */
app.post('/api/player/login', (req, res) => {
  const input = String((req.body || {}).id || '').trim();
  if (!input) return res.status(400).json({ error: '请输入选手ID' });
  const idx = state.players.findIndex(p => p.id === input);
  if (idx < 0) return res.status(404).json({ error: '未找到该选手，请联系管理员' });
  res.json({ ok: true, playerId: state.players[idx].id });
});

app.get('/api/player/state', (req, res) => {
  const id = String(req.query.id || '').trim();
  const idx = state.players.findIndex(p => p.id === id);
  if (idx < 0) return res.status(404).json({ error: '未找到该选手' });
  const p = state.players[idx];

  res.json({
    player: {
      id: p.id,
      avatar: p.avatar || '',
      tier: p.tier || '',
      damage: p.damage || '',
      heroes: p.heroes,
      kills: p.kills,
      ranks: p.ranks
    },
    currentGame: state.currentGame,
    maxGames: state.maxGames,
    threshold: state.threshold,
    assets: { heroes: getAssetFiles('heroes') }
  });
});

app.post('/api/player/hero', (req, res) => {
  const { id, game, hero } = req.body || {};
  const idx = state.players.findIndex(p => p.id === id);
  if (idx < 0) return res.status(404).json({ error: '未找到该选手' });
  const g = parseInt(game);
  if (isNaN(g) || g < 0 || g >= state.maxGames) {
    return res.status(400).json({ error: '无效局数' });
  }
  const p = state.players[idx];
  const newHero = hero ? String(hero) : '';

  if (newHero) {
    for (let i = 0; i < state.maxGames; i++) {
      if (i !== g && p.heroes[i] === newHero) {
        return res.status(400).json({ error: '该英雄你已使用过，不能重复选择' });
      }
    }
  }

  p.heroes[g] = newHero;
  saveData();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/player/profile', (req, res) => {
  const { id, tier, damage } = req.body || {};
  const idx = state.players.findIndex(p => p.id === id);
  if (idx < 0) return res.status(404).json({ error: '未找到该选手' });
  const p = state.players[idx];
  if (typeof tier === 'string') p.tier = tier;
  if (damage !== undefined) p.damage = String(damage);
  saveData();
  broadcast();
  res.json({ ok: true });
});

/* ============ 启动 ============ */
app.listen(PORT, () => {
  console.log(`✅ 服务已启动: http://localhost:${PORT}`);
  console.log(`📂 数据文件: ${DATA_FILE}`);
  console.log(`📋 控制台:   /admin.html`);
  console.log(`📺 展示页:   /display.html`);
  console.log(`🎴 选手卡片: /player-card.html`);
  console.log(`🎮 选手中心: /player.html`);
});