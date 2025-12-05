/**
 * Cursor Usage Web - 使用量监控平台
 * 
 * 无需登录模式：用户通过绑定客户端自动生成的 API Key 来查看使用数据
 * 
 * 支持两种运行模式：
 * 1. 独立运行（开发模式）：直接运行此文件
 *    cd tool-cursor-usage-web && npm start
 *    访问 http://localhost:3000/
 * 
 * 2. 集成运行（生产模式）：由主服务器启动并代理
 *    设置环境变量 BASE_PATH=/cursor-usage-web
 *    访问 http://localhost:3000/cursor-usage-web
 * 
 * 环境变量：
 *   - PORT          服务器端口（默认 3000）
 *   - BASE_PATH     应用基础路径（独立运行时为空，集成时为 /cursor-usage-web）
 *   - STANDALONE    是否独立运行（默认 true）
 */

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// 独立运行模式下 BASE_PATH 为空，集成模式下由主服务器设置
const STANDALONE = process.env.STANDALONE !== 'false';
const BASE_PATH = STANDALONE ? '' : (process.env.BASE_PATH || '/cursor-usage-web');
const dbPath = path.join(__dirname, 'db.sqlite');
const db = new sqlite3.Database(dbPath);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({ 
  secret: 'vibe_usage_secret', 
  resave: false, 
  saveUninitialized: false,
  cookie: { maxAge: 365 * 24 * 60 * 60 * 1000 } // 1年有效期
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/static/logo', express.static(path.join(__dirname, 'logo')));

// 添加 basePath 到所有视图
app.use((req, res, next) => {
  res.locals.basePath = BASE_PATH;
  next();
});

// 中间件：从请求中获取绑定的 API Keys（通过 cookie 传递）
app.use(async (req, res, next) => {
  try {
    // 从 cookie 获取绑定的 API Keys（前端存储在 localStorage，同步到 cookie）
    const boundKeysStr = req.cookies && req.cookies.boundApiKeys;
    const boundApiKeys = boundKeysStr ? JSON.parse(decodeURIComponent(boundKeysStr)) : [];
    res.locals.hasBoundKeys = boundApiKeys.length > 0;
    res.locals.boundApiKeys = boundApiKeys;
    res.locals.boundApiKeysCount = boundApiKeys.length;
  } catch {
    res.locals.hasBoundKeys = false;
    res.locals.boundApiKeys = [];
    res.locals.boundApiKeysCount = 0;
  }
  next();
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

async function init() {
  // API Keys 表 - 存储所有客户端自动生成的 API Keys
  await run(`CREATE TABLE IF NOT EXISTS vibe_usage_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key VARCHAR(64) UNIQUE NOT NULL,
    email VARCHAR(255),
    platform VARCHAR(64),
    app_name VARCHAR(64),
    created_at BIGINT NOT NULL,
    last_ping_at BIGINT DEFAULT NULL,
    online TINYINT DEFAULT 0,
    is_public TINYINT DEFAULT 0
  )`);

  // 使用量报告表 - 按 API Key 存储
  await run(`CREATE TABLE IF NOT EXISTS vibe_usage_usage_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key VARCHAR(64) NOT NULL,
    email VARCHAR(255),
    expire_time BIGINT,
    membership_type VARCHAR(32),
    total_usage BIGINT,
    used_usage BIGINT,
    bonus_usage BIGINT DEFAULT 0,
    remaining_usage BIGINT,
    host VARCHAR(255),
    platform VARCHAR(64),
    created_at BIGINT NOT NULL,
    FOREIGN KEY(api_key) REFERENCES vibe_usage_api_keys(api_key)
  )`);

  // 迁移：创建索引以提高查询性能
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_usage_reports_api_key ON vibe_usage_usage_reports(api_key)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_usage_reports_created_at ON vibe_usage_usage_reports(created_at)`);
  } catch (e) {
    // 索引可能已存在
  }

  // 加载测试账户
  try {
    const testAccountsPath = path.join(__dirname, 'test_accounts.json');
    if (fs.existsSync(testAccountsPath)) {
      const testAccounts = JSON.parse(fs.readFileSync(testAccountsPath, 'utf8'));
      for (const acc of testAccounts) {
        // 检查是否已存在
        const existing = await get(`SELECT id FROM vibe_usage_api_keys WHERE api_key = ?`, [acc.api_key]);
        if (!existing) {
          await run(`INSERT INTO vibe_usage_api_keys (api_key, email, platform, app_name, created_at, is_public) VALUES (?, ?, ?, ?, ?, 1)`, 
            [acc.api_key, acc.email || '', acc.platform || 'test', acc.app_name || '', Date.now()]);

          // 加载使用报告
          if (acc.usage_reports && Array.isArray(acc.usage_reports)) {
            for (const r of acc.usage_reports) {
              await run(`INSERT INTO vibe_usage_usage_reports (
                api_key, email, expire_time, membership_type, 
                total_usage, used_usage, bonus_usage, remaining_usage, host, platform, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                acc.api_key, r.email, r.expire_time, r.membership_type,
                r.total_usage, r.used_usage, r.bonus_usage || 0, r.remaining_usage, r.host, r.platform, r.created_at
              ]);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Failed to load test accounts:', e);
  }
}

// 根据 API Key 获取或创建记录，并更新 email 和 app_name
async function getOrCreateApiKeyRecord(apiKey, email, platform, appName) {
  let record = await get(`SELECT * FROM vibe_usage_api_keys WHERE api_key = ?`, [apiKey]);
  if (!record) {
    await run(`INSERT INTO vibe_usage_api_keys (api_key, email, platform, app_name, created_at) VALUES (?, ?, ?, ?, ?)`, 
      [apiKey, email || '', platform || '', appName || '', Date.now()]);
    record = await get(`SELECT * FROM vibe_usage_api_keys WHERE api_key = ?`, [apiKey]);
  } else {
    // 更新 email 和 app_name（如果有变化）
    const updates = [];
    const params = [];
    if (email && email !== record.email) {
      updates.push('email = ?');
      params.push(email);
    }
    if (appName && appName !== record.app_name) {
      updates.push('app_name = ?');
      params.push(appName);
    }
    if (updates.length > 0) {
      params.push(apiKey);
      await run(`UPDATE vibe_usage_api_keys SET ${updates.join(', ')} WHERE api_key = ?`, params);
    }
  }
  return record;
}

// 根据 app_name 获取 logo 路径
function getAppLogo(appName) {
  if (!appName) return null;
  const name = appName.toLowerCase();
  if (name.includes('cursor')) return '/static/logo/cursor.png';
  if (name.includes('trae')) return '/static/logo/trae.png';
  return null;
}

// 判断是否为 Trae（使用次数而非美元）
function isTrae(appName) {
  if (!appName) return false;
  return appName.toLowerCase().includes('trae');
}

// ==================== 页面路由 ====================

// 广场页面 - 显示公开的使用数据（按 email 账号维度聚合展示）
app.get('/', async (req, res) => {
  const sortBy = req.query.sortBy || 'activity';
  const order = req.query.order || 'desc';
  
  // 获取所有公开的 API Keys 及其最新使用数据，按 email 账号维度聚合
  const apiKeys = await all(`SELECT * FROM vibe_usage_api_keys WHERE is_public = 1`);
  
  // 按 email 分组
  const emailGroups = new Map();
  
  for (const k of apiKeys) {
    const r = await get(`SELECT * FROM vibe_usage_usage_reports WHERE api_key = ? ORDER BY created_at DESC LIMIT 1`, [k.api_key]);
    // 获取 email，优先从 API Key 记录获取，其次从使用报告获取
    const email = k.email || (r ? r.email : '') || '';
    
    if (!email) {
      // 没有 email 的记录单独显示（使用 api_key 作为分组键）
      const groupKey = `__apikey__${k.api_key}`;
      emailGroups.set(groupKey, {
        email: 'Unknown',
        api_keys: [k.api_key],
        app_name: k.app_name || '',
        online: !!k.online,
        membership_type: r ? r.membership_type : '',
        expire_time: r ? r.expire_time : null,
        total_usage: r ? r.total_usage : 0,
        used_usage: r ? r.used_usage : 0,
        bonus_usage: r ? r.bonus_usage : 0,
        remaining_usage: r ? r.remaining_usage : 0,
        last_activity: r ? r.created_at : 0,
        is_trae: isTrae(k.app_name)
      });
    } else {
      // 按 email 聚合
      if (!emailGroups.has(email)) {
        emailGroups.set(email, {
          email: email,
          api_keys: [],
          app_name: '',
          online: false,
          membership_type: '',
          expire_time: null,
          total_usage: 0,
          used_usage: 0,
          bonus_usage: 0,
          remaining_usage: 0,
          last_activity: 0,
          is_trae: false
        });
      }
      
      const group = emailGroups.get(email);
      group.api_keys.push(k.api_key);
      
      // 合并在线状态（任一设备在线则显示在线）
      if (k.online) group.online = true;
      
      // 使用最新的使用报告数据
      if (r && r.created_at > group.last_activity) {
        group.membership_type = r.membership_type || group.membership_type;
        group.expire_time = r.expire_time || group.expire_time;
        group.total_usage = r.total_usage || group.total_usage;
        group.used_usage = r.used_usage || group.used_usage;
        group.bonus_usage = r.bonus_usage || group.bonus_usage;
        group.remaining_usage = r.remaining_usage || group.remaining_usage;
        group.last_activity = r.created_at;
      }
      
      // 更新 app_name（优先显示有值的）
      if (k.app_name && !group.app_name) {
        group.app_name = k.app_name;
        group.is_trae = isTrae(k.app_name);
      }
    }
  }
  
  // 转换为卡片数组
  const cards = [];
  for (const [key, group] of emailGroups) {
    cards.push({
      email: group.email,
      api_key_short: group.api_keys.length > 1 
        ? `${group.api_keys.length} devices` 
        : group.api_keys[0].substring(0, 8) + '...',
      app_name: group.app_name,
      app_logo: getAppLogo(group.app_name),
      is_trae: group.is_trae,
      online: group.online,
      membership_type: group.membership_type,
      expire_time: group.expire_time,
      total_usage: group.total_usage,
      used_usage: group.used_usage,
      bonus_usage: group.bonus_usage,
      remaining_usage: group.remaining_usage,
      last_activity: group.last_activity,
      device_count: group.api_keys.length
    });
  }
  
  // 排序
  cards.sort((a, b) => {
    let valA, valB;
    if (sortBy === 'usage') {
      valA = a.used_usage || 0;
      valB = b.used_usage || 0;
    } else {
      valA = a.last_activity || 0;
      valB = b.last_activity || 0;
    }
    return order === 'asc' ? valA - valB : valB - valA;
  });
  
  res.render('plaza', { cards, sortBy, order });
});

// 个人统计页面
app.get('/me', async (req, res) => {
  // 从 cookie 获取绑定的 API Keys
  let boundApiKeys = [];
  try {
    const boundKeysStr = req.cookies && req.cookies.boundApiKeys;
    boundApiKeys = boundKeysStr ? JSON.parse(decodeURIComponent(boundKeysStr)) : [];
  } catch {
    boundApiKeys = [];
  }
  
  if (boundApiKeys.length === 0) {
    return res.render('me', { 
      hasBoundKeys: false, 
      keys: [], 
      host: req.get('host'),
      basePath: BASE_PATH
    });
  }

  // 获取所有绑定的 API Keys 的信息
  const placeholders = boundApiKeys.map(() => '?').join(',');
  const keysRaw = await all(`SELECT * FROM vibe_usage_api_keys WHERE api_key IN (${placeholders})`, boundApiKeys);
  
  // 补充 email 并为每个 key 获取独立的使用统计和趋势
  const keys = [];
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
  const startTs = start.getTime();
  
  for (const k of keysRaw) {
    let email = k.email;
    if (!email) {
      const latest = await get(`SELECT email FROM vibe_usage_usage_reports WHERE api_key = ? AND email IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [k.api_key]);
      email = latest ? latest.email : '';
    }
    
    // 获取此 key 的最新使用数据
    const latestReport = await get(`SELECT * FROM vibe_usage_usage_reports WHERE api_key = ? ORDER BY created_at DESC LIMIT 1`, [k.api_key]);
    
    // 获取此 key 的趋势数据（过去30天，基于使用量 used_usage）
    const reports = await all(`SELECT created_at, used_usage FROM vibe_usage_usage_reports WHERE api_key = ? ORDER BY created_at ASC`, [k.api_key]);
    const byDay = new Map();
    for (const r of reports) {
      const d = new Date(r.created_at);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      // 取当天最后一次记录的值
      byDay.set(dayKey, r.used_usage || 0);
    }
    
    const prevRow = await get(`SELECT used_usage FROM vibe_usage_usage_reports WHERE api_key = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`, [k.api_key, startTs]);
    let lastKnown = prevRow ? prevRow.used_usage || 0 : 0;
    
    const trend = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (byDay.has(key)) {
        lastKnown = byDay.get(key);
      }
      const label = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      trend.push({ label, value: lastKnown });
    }
    const maxVal = trend.reduce((m, p) => Math.max(m, p.value || 0), 0);
    
    keys.push({ 
      ...k, 
      email: email,
      app_logo: getAppLogo(k.app_name),
      is_trae: isTrae(k.app_name),
      api_key_short: k.api_key.substring(0, 8) + '...',
      usage: latestReport ? {
        membership_type: latestReport.membership_type,
        expire_time: latestReport.expire_time,
        total_usage: latestReport.total_usage,
        used_usage: latestReport.used_usage,
        bonus_usage: latestReport.bonus_usage,
        remaining_usage: latestReport.remaining_usage
      } : null,
      trend: trend,
      maxVal: maxVal
    });
  }

  res.render('me', { 
    hasBoundKeys: true, 
    keys,
    host: req.get('host'),
    basePath: BASE_PATH
  });
});

// 验证 API Key（检查是否存在）
app.post('/validate-key', async (req, res) => {
  const { api_key } = req.body;
  
  // API Key 格式: ck_ + 32位 md5 = 35位
  if (!api_key || !api_key.startsWith('ck_') || api_key.length !== 35) {
    return res.status(400).json({ error: 'Invalid API Key format. Must start with "ck_" and be 35 characters.' });
  }

  // 检查 API Key 是否存在
  const keyRecord = await get(`SELECT * FROM vibe_usage_api_keys WHERE api_key = ?`, [api_key]);
  if (!keyRecord) {
    return res.status(404).json({ error: 'API Key not found. Please make sure the extension has reported data first.' });
  }

  res.json({ ok: true, message: 'API Key is valid' });
});

// 切换公开状态
app.post('/toggle-public', async (req, res) => {
  const { api_key, bound_keys } = req.body;
  const boundApiKeys = bound_keys || [];
  
  if (!boundApiKeys.includes(api_key)) {
    return res.status(403).json({ error: 'You can only modify your bound API Keys' });
  }

  const current = await get(`SELECT is_public FROM vibe_usage_api_keys WHERE api_key = ?`, [api_key]);
  if (!current) {
    return res.status(404).json({ error: 'API Key not found' });
  }
  
  const newValue = current.is_public ? 0 : 1;
  await run(`UPDATE vibe_usage_api_keys SET is_public = ? WHERE api_key = ?`, [newValue, api_key]);
  
  res.json({ ok: true, is_public: newValue === 1 });
});

// ==================== API 路由 ====================

// 提交使用数据
app.post('/api/usage', async (req, res) => {
  const b = req.body;
  // 优先从请求体获取 client_token，兼容从 header 获取
  const apiKey = b.client_token || req.header('X-Api-Key');
  if (!apiKey) return res.status(401).json({ error: 'client_token required' });

  // 确保 API Key 记录存在，并更新 email 和 app_name
  await getOrCreateApiKeyRecord(apiKey, b.email, b.platform, b.app_name);
  
  await run(`INSERT INTO vibe_usage_usage_reports (api_key, email, expire_time, membership_type, total_usage, used_usage, bonus_usage, remaining_usage, host, platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    apiKey, b.email || null, b.expire_time || null, b.membership_type || '', b.total_usage || 0, b.used_usage || 0, b.bonus_usage || 0, b.remaining_usage || 0, b.host || '', b.platform || '', Date.now()
  ]);
  res.json({ ok: true });
});

// Ping - 更新在线状态
app.post('/api/ping', async (req, res) => {
  const b = req.body || {};
  // 优先从请求体获取 client_token，兼容从 header 获取
  const apiKey = b.client_token || req.header('X-Api-Key');
  if (!apiKey) return res.status(401).json({ error: 'client_token required' });

  const active = typeof b.active !== 'undefined' ? !!b.active : true;
  
  // 确保记录存在
  await getOrCreateApiKeyRecord(apiKey, null, null);
  
  await run(`UPDATE vibe_usage_api_keys SET last_ping_at = ?, online = ? WHERE api_key = ?`, [Date.now(), active ? 1 : 0, apiKey]);
  res.json({ ok: true });
});

// 定期更新离线状态
setInterval(async () => {
  const threshold = Date.now() - 120000;
  await run(`UPDATE vibe_usage_api_keys SET online = 0 WHERE last_ping_at IS NULL OR last_ping_at < ?`, [threshold]);
}, 120000);

// 健康检查 API - 用于识别这是一个 Coding Usage 服务
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'coding-usage',
    version: '1.0.0',
    timestamp: Date.now()
  });
});

// 导出配置（用于客户端导入）
app.get('/api/config', (req, res) => {
  const protocol = req.protocol;
  const host = req.get('host');
  res.json({
    host: `${protocol}://${host}`
  });
});

// 初始化
app.get('/api/init', async (req, res) => {
  try {
    await init();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

init().then(() => {
  app.listen(PORT, () => {
    console.log(`[cursor-usage-web] ========================================`);
    console.log(`[cursor-usage-web] Cursor Usage Web 已启动`);
    console.log(`[cursor-usage-web] ========================================`);
    console.log(`[cursor-usage-web] 运行模式: ${STANDALONE ? '独立开发模式' : '集成模式'}`);
    console.log(`[cursor-usage-web] 端口: ${PORT}`);
    console.log(`[cursor-usage-web] 访问地址: http://localhost:${PORT}${BASE_PATH || '/'}`);
    console.log(`[cursor-usage-web] ========================================`);
  });
});
