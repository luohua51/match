const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 扫描资源文件夹（英雄和头像）
function getAssetFiles(dir) {
  const fullPath = path.join(__dirname, 'public', dir);
  try {
    if (!fs.existsSync(fullPath)) return [];
    return fs.readdirSync(fullPath)
      .filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
      .sort();
  } catch (e) { return []; }
}

// 默认数据结构
function defaultData() {
  const players = [];
  for (let i = 1; i <= 8; i++) {
    players.push({
      id: `选手${i}`,
      avatar: '',          // 头像文件名
      kills: [0, 0, 0, 0, 0],
      ranks: [null, null, null, null, null],
      heroes: ['', '', '', '', '']  // 每局使用的英雄文件名
    });
  }
  return {
    players,
    currentGame: 0,
    threshold: 19,
    maxGames: 5,
    visible: true,
    scoreboardCollapsed: false,   // 主记分牌折叠状态
    champion: null,
    cardPlayerId: null            // 当前展示卡片的选手ID
  };
}

let state = defaultData();

// 加载已有数据（兼容旧版本数据结构）
if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state = Object.assign(defaultData(), saved);
    
    // 数据清洗与补齐（确保旧数据不报错）
    state.players.forEach(p => {
      p.avatar = p.avatar || '';
      p.kills = p.kills || [];
      p.ranks = p.ranks || [];
      p.heroes = p.heroes || [];
      while (p.kills.length < state.maxGames) p.kills.push(0);
      while (p.ranks.length < state.maxGames) p.ranks.push(null);
      while (p.heroes.length < state.maxGames) p.heroes.push('');
      p.kills = p.kills.slice(0, state.maxGames);
      p.ranks = p.ranks.slice(0, state.maxGames);
      p.heroes = p.heroes.slice(0, state.maxGames);
    });
    
    // 确保新增字段存在
    if (state.scoreboardCollapsed === undefined) state.scoreboardCollapsed = false;
    if (state.cardPlayerId === undefined) state.cardPlayerId = null;
  } catch (e) {
    console.error('读取数据失败，使用默认数据', e);
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

// 核心计算逻辑（积分、赛点、冠军判定）
function computeStandings(s) {
  const maxGames = s.maxGames;
  const threshold = s.threshold;

  const players = s.players.map((p, idx) => {
    let total = 0;
    const games = [];
    for (let g = 0; g < maxGames; g++) {
      const kills = p.kills[g] || 0;
      const rank = p.ranks[g];
      const hero = p.heroes ? (p.heroes[g] || '') : '';
      const killPoints = kills * 1.5;
      const rankPoints = rank
        ? rank === 1 ? 8 : rank === 2 ? 6 : rank === 3 ? 5
        : rank === 4 ? 4 : rank === 5 ? 3 : rank === 6 ? 2 : rank === 7 ? 1 : 0
        : 0;
      const gameTotal = killPoints + rankPoints;
      total += gameTotal;
      games.push({
        kills, rank, hero,
        killPoints, rankPoints, gameTotal,
        totalBefore: total - gameTotal
      });
    }
    return { id: p.id, avatar: p.avatar || '', total, games, index: idx };
  });

  // 冠军判定：按局顺序，赛前总分 >= 19 且该局 rank === 1
  let championId = null;
  let championGame = -1;
  const runningTotals = players.map(() => 0);

  for (let g = 0; g < maxGames; g++) {
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const game = p.games[g];
      const before = runningTotals[i];
      if (before >= threshold && game.rank === 1) {
        if (championId === null || g < championGame) {
          championId = p.id;
          championGame = g;
        }
      }
    }
    for (let i = 0; i < players.length; i++) {
      runningTotals[i] += players[i].games[g].gameTotal;
    }
  }

  players.forEach(p => { p.isChampion = (p.id === championId); });

  // 排序：冠军优先，然后按总分降序
  players.sort((a, b) => {
    if (a.isChampion && !b.isChampion) return -1;
    if (!a.isChampion && b.isChampion) return 1;
    return b.total - a.total;
  });
  players.forEach((p, i) => p.place = i + 1);

  return players.map(({ index, ...rest }) => rest);
}

// API: 获取状态（含资源列表）
app.get('/api/state', (req, res) => {
  const standings = computeStandings(state);
  res.json({
    ...state,
    standings,
    assets: {
      heroes: getAssetFiles('heroes'),
      avatars: getAssetFiles('avatars')
    }
  });
});

// API: 更新数据
app.post('/api/update', (req, res) => {
  const newState = req.body;
  if (!newState.players || !Array.isArray(newState.players)) {
    return res.status(400).json({ error: '无效数据' });
  }
  if (newState.players.length < 8 || newState.players.length > 12) {
    return res.status(400).json({ error: '选手数量必须在8-12人之间' });
  }
  
  state = {
    players: newState.players,
    currentGame: newState.currentGame ?? state.currentGame,
    threshold: newState.threshold ?? state.threshold,
    maxGames: newState.maxGames ?? state.maxGames,
    visible: newState.visible ?? state.visible,
    scoreboardCollapsed: newState.scoreboardCollapsed ?? state.scoreboardCollapsed,
    champion: newState.champion ?? state.champion,
    cardPlayerId: newState.cardPlayerId !== undefined ? newState.cardPlayerId : state.cardPlayerId
  };

  // 数据清洗
  state.players.forEach(p => {
    p.avatar = p.avatar || '';
    p.kills = p.kills || [];
    p.ranks = p.ranks || [];
    p.heroes = p.heroes || [];
    while (p.kills.length < state.maxGames) p.kills.push(0);
    while (p.ranks.length < state.maxGames) p.ranks.push(null);
    while (p.heroes.length < state.maxGames) p.heroes.push('');
    p.kills = p.kills.slice(0, state.maxGames);
    p.ranks = p.ranks.slice(0, state.maxGames);
    p.heroes = p.heroes.slice(0, state.maxGames);
  });

  saveData();
  broadcast();
  res.json({ ok: true, standings: computeStandings(state) });
});

// SSE 实时推送
let clients = [];
function broadcast() {
  const standings = computeStandings(state);
  const payload = JSON.stringify({ ...state, standings });
  clients.forEach(client => {
    client.res.write(`data: ${payload}\n\n`);
  });
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { id: Date.now(), res };
  clients.push(client);

  const standings = computeStandings(state);
  res.write(`data: ${JSON.stringify({ ...state, standings })}\n\n`);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

// API: 重置比赛
app.post('/api/reset', (req, res) => {
  state = defaultData();
  saveData();
  broadcast();
  res.json({ ok: true });
});

// API: 添加选手
app.post('/api/add-player', (req, res) => {
  if (state.players.length >= 12) {
    return res.status(400).json({ error: '最多12名选手' });
  }
  state.players.push({
    id: `选手${state.players.length + 1}`,
    avatar: '',
    kills: new Array(state.maxGames).fill(0),
    ranks: new Array(state.maxGames).fill(null),
    heroes: new Array(state.maxGames).fill('')
  });
  saveData();
  broadcast();
  res.json({ ok: true, state });
});

// API: 删除选手
app.post('/api/remove-player', (req, res) => {
  const { index } = req.body;
  if (state.players.length <= 8) {
    return res.status(400).json({ error: '最少8名选手' });
  }
  if (index >= 0 && index < state.players.length) {
    state.players.splice(index, 1);
    saveData();
    broadcast();
    res.json({ ok: true, state });
  } else {
    res.status(400).json({ error: '索引无效' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ 服务已启动: http://localhost:${PORT}`);
  console.log(`📋 控制台: http://localhost:${PORT}/admin.html`);
  console.log(`📺 展示页: http://localhost:${PORT}/display.html`);
  console.log(`🎴 选手卡片: http://localhost:${PORT}/player-card.html`);
  console.log(`🎭 英雄目录: public/heroes/`);
  console.log(`📸 头像目录: public/avatars/`);
});