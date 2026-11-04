'use strict';
// 数据层：工程 / 专业 / 队伍 / 库存条目 / 库存流水 / 四类单据
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.WMS_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'wms.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const now = () => new Date().toLocaleString('sv-SE').replace('T', ' ');
const today = () => new Date().toLocaleDateString('sv-SE');

/* 四类单据 */
const DOC_TYPES = {
  IN: { name: '入库单', prefix: 'RK' },
  REQ: { name: '领料申请单', prefix: 'LL' },
  OUT: { name: '出库单', prefix: 'CK' },
  RET: { name: '退料入库单', prefix: 'TL' },
};

const STATUS = {
  draft: { name: '保存', cls: 'draft' },
  submitted: { name: '已提交', cls: 'ok' },
  part: { name: '部分出库', cls: 'warn' },
  closed: { name: '已出库', cls: 'done' },
  void: { name: '已作废', cls: 'draft' },
};

const INDEXES = `CREATE INDEX IF NOT EXISTS idx_docs_type ON docs(type, doc_date);
CREATE INDEX IF NOT EXISTS idx_docs_project ON docs(project_id);
CREATE INDEX IF NOT EXISTS idx_items_doc ON doc_items(doc_id);
CREATE INDEX IF NOT EXISTS idx_items_stock ON doc_items(stock_item_id);
CREATE INDEX IF NOT EXISTS idx_moves_item ON stock_moves(item_id);
CREATE INDEX IF NOT EXISTS idx_stock_proj ON stock_items(project_id, major_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_cat ON audit_logs(category, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_ukey ON audit_logs(ukey);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE, name TEXT, note TEXT, builtin INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS role_perms(role_id INTEGER, perm TEXT, PRIMARY KEY(role_id, perm));
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE, password TEXT, name TEXT,
  role_id INTEGER, role TEXT, team_id INTEGER, active INTEGER DEFAULT 1, created_at TEXT
);

CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT, name TEXT UNIQUE, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS majors(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT, name TEXT UNIQUE, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS teams(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS project_members(
  user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, PRIMARY KEY(user_id, project_id)
);

/* 库存条目：一条入库明细 = 一个条目；同物资不同批次不合并 */
CREATE TABLE IF NOT EXISTS stock_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL, major_id INTEGER NOT NULL,
  plan_no TEXT, material_code TEXT,
  name TEXT NOT NULL, spec TEXT, tech_req TEXT, unit TEXT NOT NULL,
  arrival_date TEXT, seq INTEGER,
  doc_id INTEGER, active INTEGER DEFAULT 1, created_at TEXT
);

/* 库存流水：唯一账本，余额一律由流水汇总 */
CREATE TABLE IF NOT EXISTS stock_moves(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL, doc_id INTEGER, doc_type TEXT,
  qty REAL NOT NULL, doc_date TEXT, user_id INTEGER, created_at TEXT
);

/* 领料单剩余量了结：放弃某张单某项物资「还没领的那部分」。
   单独记账，不改 doc_items.qty —— 原始申请数量必须与打印出来的纸单一致。
   待出库 = 申请数量 − 已出库 − 已了结。 */
CREATE TABLE IF NOT EXISTS req_closures(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  stock_item_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  reason TEXT,
  user_id INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS docs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT UNIQUE, type TEXT NOT NULL, doc_date TEXT,
  project_id INTEGER, major_id INTEGER, team_id INTEGER,
  status TEXT DEFAULT 'draft', source_doc_id INTEGER,
  remark TEXT,
  created_by INTEGER, created_at TEXT,
  submitted_at TEXT, modified_by INTEGER, modified_at TEXT
);

CREATE TABLE IF NOT EXISTS doc_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL, seq INTEGER,
  stock_item_id INTEGER,
  plan_no TEXT, material_code TEXT,
  name TEXT, spec TEXT, tech_req TEXT, unit TEXT,
  qty REAL DEFAULT 0, remark TEXT
);

/* 表单令牌：同一次页面渲染只允许生成一张单据，防双击 / 网络重试造成重复单据 */
CREATE TABLE IF NOT EXISTS form_tokens(
  token TEXT PRIMARY KEY, doc_id INTEGER, created_at TEXT
);

/* 系统日志：登录 + 操作。category: auth 登录 / op 业务操作。
   src: live 实时记录 / backfill 由历史业务数据补录（时间取自业务表，非真实访问时间）。
   ukey: 补录幂等键，重复执行补录不会产生重复行。 */
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  action_name TEXT,
  result TEXT DEFAULT 'ok',
  user_id INTEGER, username TEXT, user_name TEXT, role_name TEXT,
  target TEXT, detail TEXT, ip TEXT,
  src TEXT DEFAULT 'live', ukey TEXT
);

`;

/* 旧版业务表：升级到 v2 时清理（不动 users / roles / projects / teams / sessions） */
const LEGACY = ['ledger', 'products', 'partners', 'warehouses', 'categories', 'units', 'staff', 'docs', 'doc_items'];

/* 升级：角色与权限点对齐新系统（一次性） */
const ROLE_SEED = {
  admin: ['in.create','in.view','req.create','req.view','req.print','req.items','out.create','out.view','ret.create','ret.view','stock.view','export.xlsx','base.project','base.major','base.team','sys.role','sys.user','doc.admin'],
  keeper: ['in.create','in.view','out.create','out.view','ret.create','ret.view','stock.view','req.view','req.items','export.xlsx'],
  picker: ['req.create','req.view','req.print','req.items','stock.view'],
  viewer: ['in.view','req.view','req.items','out.view','ret.view','stock.view'],
  secadmin: ['in.create','in.view','req.create','req.view','req.print','req.items','out.create','out.view','ret.create','ret.view','stock.view','export.xlsx','doc.admin','scope.all'],
};
const ROLE_TITLE = {
  admin: ['管理员', '全部权限'],
  keeper: ['仓管员', '入库、出库、退料、库存'],
  picker: ['领料员', '提交领料申请'],
  viewer: ['只读', '仅查看'],
  secadmin: ['二级管理员', '收发存全部功能 + 撤改已提交单据；无基础档案与授权'],
};

function migrateRoles() {
  if (one("SELECT v FROM meta WHERE k = 'seed_roles'")) return;
  for (const [code, perms] of Object.entries(ROLE_SEED)) {
    const [name, note] = ROLE_TITLE[code];
    let r = one('SELECT * FROM roles WHERE code = ?', code);
    if (!r) {
      run('INSERT INTO roles(code,name,note,builtin) VALUES(?,?,?,?)', code, name, note, code === 'admin' ? 1 : 0);
      r = one('SELECT * FROM roles WHERE code = ?', code);
    } else {
      run('UPDATE roles SET name=?, note=? WHERE id=?', name, note, r.id);
    }
    run('DELETE FROM role_perms WHERE role_id = ?', r.id);
    for (const p of perms) run('INSERT OR IGNORE INTO role_perms(role_id,perm) VALUES(?,?)', r.id, p);
  }
  // 旧角色（如采购员）映射到仓管员，避免用户失去全部权限
  const keeper = one("SELECT id FROM roles WHERE code = 'keeper'");
  for (const u of all('SELECT u.id, u.role_id, r.code FROM users u LEFT JOIN roles r ON r.id = u.role_id')) {
    if (!u.code || !ROLE_SEED[u.code]) {
      run('UPDATE users SET role_id = ?, role = ? WHERE id = ?', keeper.id, 'keeper', u.id);
    }
  }
  run("INSERT OR REPLACE INTO meta(k, v) VALUES('seed_roles', '1')");
}

/* 一次性：领用明细权限点上线，凡已有「领用查询」的角色自动获得，避免现有角色突然看不到该菜单 */
function migrateReqItemsPerm() {
  if (one("SELECT v FROM meta WHERE k = 'perm_req_items'")) return;
  for (const r of all("SELECT r.id FROM roles r JOIN role_perms p ON p.role_id = r.id WHERE p.perm = 'req.view'")) {
    run('INSERT OR IGNORE INTO role_perms(role_id, perm) VALUES(?, ?)', r.id, 'req.items');
  }
  run("INSERT OR REPLACE INTO meta(k, v) VALUES('perm_req_items', '1')");
}

/* 一次性：给会话表补登录时间与 IP，用于"该账号已在别处登录"的提示 */
function migrateSessionMeta() {
  const cols = all("SELECT name FROM pragma_table_info('sessions')").map((c) => c.name);
  if (!cols.includes('created_at')) run('ALTER TABLE sessions ADD COLUMN created_at TEXT');
  if (!cols.includes('ip')) run('ALTER TABLE sessions ADD COLUMN ip TEXT');
}

/* 一次性：给已有「出库查询 / 退料查询」权限的角色补上明细页权限 */
function migrateOutRetItemsPerm() {
  if (one("SELECT v FROM meta WHERE k = 'perm_out_ret_items'")) return;
  for (const r of all("SELECT r.id FROM roles r JOIN role_perms p ON p.role_id = r.id WHERE p.perm = 'out.view'")) {
    run('INSERT OR IGNORE INTO role_perms(role_id, perm) VALUES(?, ?)', r.id, 'out.items');
  }
  for (const r of all("SELECT r.id FROM roles r JOIN role_perms p ON p.role_id = r.id WHERE p.perm = 'ret.view'")) {
    run('INSERT OR IGNORE INTO role_perms(role_id, perm) VALUES(?, ?)', r.id, 'ret.items');
  }
  run("INSERT OR REPLACE INTO meta(k, v) VALUES('perm_out_ret_items', '1')");
}

/* 一次性：建立「二级管理员」角色（收发存全权 + 撤改已提交单据，不含基础档案与授权） */
function migrateSecAdmin() {
  if (one("SELECT v FROM meta WHERE k = 'seed_secadmin'")) return;
  const perms = ROLE_SEED.secadmin;
  let r = one("SELECT * FROM roles WHERE code = 'secadmin'");
  if (!r) {
    run('INSERT INTO roles(code,name,note,builtin) VALUES(?,?,?,0)', 'secadmin', '二级管理员', ROLE_TITLE.secadmin[1]);
    r = one("SELECT * FROM roles WHERE code = 'secadmin'");
  }
  run('DELETE FROM role_perms WHERE role_id = ?', r.id);
  for (const p of perms) run('INSERT OR IGNORE INTO role_perms(role_id,perm) VALUES(?,?)', r.id, p);
  run("INSERT OR REPLACE INTO meta(k, v) VALUES('seed_secadmin', '1')");
}

function migrate() {
  db.exec(SCHEMA);
  const v = one('SELECT v FROM meta WHERE k = ?', 'schema');
  if (!v || v.v !== '2') {
    // 旧表结构与新索引不兼容，必须先删旧表再建索引
    for (const t of LEGACY) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec(SCHEMA);
    run('INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)', 'schema', '2');
  }
  db.exec(INDEXES);

  migrateRoles();
  migrateSecAdmin();
  migrateReqItemsPerm();
  migrateOutRetItemsPerm();
  migrateSessionMeta();

  // 首次升级：给出 5 个常见专业作为起点（只做一次，可自行改删）
  if (!one("SELECT v FROM meta WHERE k = 'seed_majors'")) {
    ['结构', '工艺', '电气', '暖通', '舾装'].forEach((m, i) =>
      run('INSERT OR IGNORE INTO majors(code,name,sort) VALUES(?,?,?)', 'ZY' + (i + 1), m, i + 1)
    );
    run("INSERT OR REPLACE INTO meta(k, v) VALUES('seed_majors', '1')");
  }
  const c = one('SELECT COUNT(*) n FROM users');
  if (c.n === 0) seed();

  // 清理 7 天前的表单令牌（只用于拦截短时间内的重复提交）
  const cut = new Date(Date.now() - 7 * 864e5).toISOString();
  run('DELETE FROM form_tokens WHERE created_at < ?', cut);
}

function seed() {
  const roles = [
    ['admin', '管理员', '全部权限', 1],
    ['keeper', '仓管员', '入库、出库、退料、库存', 0],
    ['picker', '领料员', '提交领料申请', 0],
    ['viewer', '只读', '仅查看', 0],
  ];
  for (const r of roles) run('INSERT OR IGNORE INTO roles(code,name,note,builtin) VALUES(?,?,?,?)', ...r);

  const perms = {
    keeper: ['in.create', 'in.view', 'out.create', 'out.view', 'ret.create', 'ret.view', 'stock.view', 'req.view', 'export.xlsx'],
    picker: ['req.create', 'req.view', 'req.print', 'stock.view'],
    viewer: ['in.view', 'req.view', 'out.view', 'ret.view', 'stock.view'],
  };
  for (const code of Object.keys(perms)) {
    const r = one('SELECT id FROM roles WHERE code = ?', code);
    if (!r) continue;
    for (const p of perms[code]) run('INSERT OR IGNORE INTO role_perms(role_id, perm) VALUES(?,?)', r.id, p);
  }

  const adminRole = one("SELECT id FROM roles WHERE code = 'admin'");
  run(
    'INSERT INTO users(username, password, name, role, role_id, active, created_at) VALUES(?,?,?,?,?,?,?)',
    'admin',
    require('./auth').hashPassword('admin888'),
    '管理员',
    'admin',
    adminRole.id,
    1,
    now()
  );

  ['结构', '工艺', '电气', '暖通', '舾装'].forEach((m, i) =>
    run('INSERT OR IGNORE INTO majors(code,name,sort) VALUES(?,?,?)', 'ZY' + (i + 1), m, i + 1)
  );
  run("INSERT OR IGNORE INTO projects(code,name,sort) VALUES('P000','公司公用',0)");
}

/* 可见工程：管理员与持 scope.all 者看全部，其余按 project_members 分配 */
function projectScope(user) {
  if (!user) return [];
  if (user.role === 'admin' || user.role_code === 'admin' || (user.perms || []).includes('scope.all')) {
    return all('SELECT * FROM projects WHERE active = 1 ORDER BY sort, id');
  }
  return all(
    `SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id
     WHERE m.user_id = ? AND p.active = 1 ORDER BY p.sort, p.id`,
    user.id
  );
}

function visibleProjectIds(user) {
  return projectScope(user).map((p) => p.id);
}

function nextDocNo(type, projectId) {
  const meta = DOC_TYPES[type];
  const p = projectId ? one('SELECT code, id FROM projects WHERE id = ?', projectId) : null;
  const code = (p && p.code) || 'P' + (p ? p.id : '000');
  const d = today().replace(/-/g, '');
  let seq = one('SELECT COUNT(*) n FROM docs WHERE type = ? AND substr(doc_no, 1, 2) = ?', type, meta.prefix).n + 1;
  let no = `${meta.prefix}-${code}-${d}-${String(seq).padStart(3, '0')}`;
  while (one('SELECT id FROM docs WHERE doc_no = ?', no)) {
    seq += 1;
    no = `${meta.prefix}-${code}-${d}-${String(seq).padStart(3, '0')}`;
  }
  return no;
}

/** 库存：条目 + 流水汇总（入 / 出 / 退 / 结存） */
const STOCK_SQL = `
SELECT si.*, pj.name AS project_name, pj.code AS project_code, mj.name AS major_name,
       IFNULL(SUM(CASE WHEN m.doc_type = 'IN'  THEN m.qty ELSE 0 END), 0) AS in_qty,
       IFNULL(-SUM(CASE WHEN m.doc_type = 'OUT' THEN m.qty ELSE 0 END), 0) AS out_qty,
       IFNULL(SUM(CASE WHEN m.doc_type = 'RET' THEN m.qty ELSE 0 END), 0) AS ret_qty,
       IFNULL(SUM(m.qty), 0) AS balance
FROM stock_items si
JOIN projects pj ON pj.id = si.project_id
JOIN majors mj ON mj.id = si.major_id
LEFT JOIN stock_moves m ON m.item_id = si.id
WHERE si.active = 1
`;

module.exports = {
  db, all, one, run, now, today, migrate, seed, DATA_DIR,
  DOC_TYPES, STATUS, projectScope, visibleProjectIds, nextDocNo, STOCK_SQL,
};
