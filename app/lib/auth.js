'use strict';
const crypto = require('node:crypto');
const { all, one, run } = require('./db');

/* 全部权限点：新增权限只需加在这里 */
const PERM_KEYS = [
  'in.create', 'in.view',
  'req.create', 'req.view', 'req.print', 'req.items',
  'out.create', 'out.view', 'out.items',
  'ret.create', 'ret.view', 'ret.items',
  'stock.view',
  'export.xlsx',
  'scope.all',
  'base.project', 'base.major', 'base.team',
  'sys.role', 'sys.user',
  'doc.admin',
];

const PERM_LABELS = {
  'in.create': '入库登记（导入 / 保存 / 提交）',
  'in.view': '入库查询与入库明细',
  'req.create': '领料申请（登记 / 提交）',
  'req.view': '领用查询',
  'req.print': '打印领料申请单',
  'req.items': '领用明细（按物资行查领用记录）',
  'out.create': '出库登记',
  'out.view': '出库查询',
  'out.items': '出库明细（按物资行查出库记录）',
  'ret.create': '退料登记',
  'ret.view': '退料查询',
  'ret.items': '退库明细（按物资行查退库记录）',
  'stock.view': '查看库存',
  'export.xlsx': '导出 Excel',
  'scope.all': '全部工程可见（不受项目分配限制）',
  'base.project': '工程管理',
  'base.major': '专业管理',
  'base.team': '施工队伍管理',
  'sys.role': '角色与授权',
  'sys.user': '用户与项目分配',
  'doc.admin': '撤改 / 作废已提交单据',
};

const PERM_GROUPS = [
  { title: '入库', keys: ['in.create', 'in.view'] },
  { title: '领用', keys: ['req.create', 'req.view', 'req.print', 'req.items'] },
  { title: '出库', keys: ['out.create', 'out.view', 'out.items'] },
  { title: '退料', keys: ['ret.create', 'ret.view', 'ret.items'] },
  { title: '查询与导出', keys: ['stock.view', 'export.xlsx', 'scope.all'] },
  { title: '基础档案', keys: ['base.project', 'base.major', 'base.team'] },
  { title: '系统', keys: ['sys.role', 'sys.user', 'doc.admin'] },
];

const ROLE_PRESETS = {
  admin: { name: '管理员', note: '全部权限', perms: ['*'] },
  keeper: {
    name: '仓管员',
    note: '入库、出库、退料、库存',
    perms: ['in.create', 'in.view', 'out.create', 'out.view', 'out.items', 'ret.create', 'ret.view', 'ret.items', 'stock.view', 'req.view', 'req.items', 'export.xlsx'],
  },
  picker: { name: '领料员', note: '提交领料申请', perms: ['req.create', 'req.view', 'req.print', 'req.items', 'stock.view'] },
  viewer: { name: '只读', note: '仅查看', perms: ['in.view', 'req.view', 'req.items', 'out.view', 'ret.view', 'stock.view'] },
  secadmin: {
    name: '二级管理员',
    note: '收发存全部功能 + 撤改已提交单据；无基础档案与授权',
    perms: [
      'in.create', 'in.view',
      'req.create', 'req.view', 'req.print', 'req.items',
      'out.create', 'out.view', 'out.items',
      'ret.create', 'ret.view', 'ret.items',
      'stock.view', 'export.xlsx',
      'doc.admin', 'scope.all',
    ],
  },
};

function permsOf(roleId) {
  return all('SELECT perm FROM role_perms WHERE role_id = ?', roleId).map((r) => r.perm);
}

const can = (user, perm) => !!user && (user.role_code === 'admin' || (user.perms || []).includes(perm));

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(plain, salt, 64).toString('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSession(userId, meta = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const exp = new Date(Date.now() + 7 * 864e5).toISOString();
  const now = new Date().toLocaleString('sv-SE').replace('T', ' ');
  run('INSERT INTO sessions(token,user_id,expires_at,created_at,ip) VALUES(?,?,?,?,?)', token, userId, exp, now, meta.ip || null);
  return token;
}

function getUserByToken(token) {
  if (!token) return null;
  const row = one(
    `SELECT u.*, r.code AS role_code, r.name AS role_name, t.name AS team_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN roles r ON r.id = u.role_id
     LEFT JOIN teams t ON t.id = u.team_id
     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
    token,
    new Date().toISOString()
  );
  if (!row) return null;
  row.perms = row.role_id ? permsOf(row.role_id) : [];
  return row;
}

function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
}

module.exports = {
  PERM_KEYS, PERM_LABELS, PERM_GROUPS, ROLE_PRESETS,
  can, permsOf, hashPassword, verifyPassword, createSession, getUserByToken, destroySession,
};
