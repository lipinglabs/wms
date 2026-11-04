'use strict';
/* 系统日志：登录记录 + 操作记录
   写入原则：日志失败绝不影响业务（业务成功是第一位的），因此所有写库都包了 try。 */
const { all, one, run, now } = require('./db');

/* 路径 → 动作。doc: 1 表示路径里带单据 id，可用于反查单号 */
const RULES = [
  { re: /^\/in\/create$/, action: 'in.create', name: '导入入库单' },
  { re: /^\/in\/(\d+)\/submit$/, action: 'in.submit', name: '提交入库单', doc: 1 },
  { re: /^\/in\/(\d+)\/void$/, action: 'in.void', name: '作废入库单', doc: 1 },
  { re: /^\/req\/save$/, action: 'req.create', name: '生成领料单' },
  { re: /^\/req\/(\d+)\/submit$/, action: 'req.submit', name: '提交领料单', doc: 1 },
  { re: /^\/req\/(\d+)\/withdraw$/, action: 'req.withdraw', name: '撤回领料单', doc: 1 },
  { re: /^\/req\/(\d+)\/close-line$/, action: 'req.close', name: '放弃领用', doc: 1 },
  { re: /^\/req\/(\d+)\/close-rest$/, action: 'req.close', name: '全部放弃领用', doc: 1 },
  { re: /^\/req\/(\d+)\/unclose$/, action: 'req.unclose', name: '撤销放弃领用', doc: 1 },
  { re: /^\/out\/save$/, action: 'out.create', name: '出库' },
  { re: /^\/out\/(\d+)\/void$/, action: 'out.void', name: '撤回出库', doc: 1 },
  { re: /^\/ret\/save$/, action: 'ret.create', name: '退料入库' },
  { re: /^\/password$/, action: 'user.password', name: '修改密码' },
  { re: /^\/users\/save$/, action: 'sys.user', name: '保存用户' },
  { re: /^\/roles\/save$/, action: 'sys.role', name: '保存角色权限' },
  { re: /^\/roles\/create$/, action: 'sys.role', name: '新建角色' },
  { re: /^\/projects\/save$/, action: 'base.project', name: '保存工程' },
  { re: /^\/majors\/save$/, action: 'base.major', name: '保存专业' },
  { re: /^\/teams\/save$/, action: 'base.team', name: '保存施工队伍' },
  { re: /^\/base\/delete$/, action: 'base.delete', name: '删除基础档案' },
];

const DOC_NO_RE = /[A-Z]{2}-[A-Z0-9]+-\d{8}-\d{3}/;

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch (e) {
    console.error('[audit]', e && e.message ? e.message : e);
    return fallback;
  }
};

/* 底层写入。ukey 非空时幂等（补录用） */
function write(o) {
  return safe(
    () =>
      run(
        `INSERT OR IGNORE INTO audit_logs
           (created_at,category,action,action_name,result,user_id,username,user_name,role_name,target,detail,ip,src,ukey)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        o.created_at || now(),
        o.category || 'op',
        o.action || 'other',
        o.action_name || '',
        o.result || 'ok',
        o.user_id == null ? null : o.user_id,
        o.username || null,
        o.user_name || null,
        o.role_name || null,
        o.target || null,
        o.detail || null,
        o.ip || null,
        o.src || 'live',
        o.ukey || null
      ),
    0
  );
}

/* 业务代码调用：audit.op(ctx, {action, name, target, detail, result}) */
function op(ctx, o = {}) {
  const u = (ctx && ctx.user) || {};
  return write({
    category: o.category || 'op',
    action: o.action,
    action_name: o.name || '',
    result: o.result || 'ok',
    user_id: u.id,
    username: u.username,
    user_name: u.name,
    role_name: u.role_name || u.role || '',
    target: o.target || null,
    detail: o.detail || null,
    ip: ctx && ctx.ip,
  });
}

/* 从消息 / 路径推单据号 */
function docNoOf(pathname, id) {
  if (id) {
    const d = safe(() => one('SELECT doc_no FROM docs WHERE id = ?', id), null);
    if (d && d.doc_no) return d.doc_no;
  }
  return null;
}

/* 由路径解析动作定义 */
function routeOf(pathname) {
  for (const r of RULES) {
    const m = pathname.match(r.re);
    if (m) return { def: r, id: r.doc ? Number(m[1]) : 0 };
  }
  return null;
}

/* 一次 POST 结束后的自动记账。trace 为 ctx 记录的跳转地址与提示语 */
function record(ctx, pathname, trace) {
  if (!ctx || !ctx.user) return;
  const hit = routeOf(pathname);
  const def = hit ? hit.def : { action: 'other', name: pathname };
  const msg = (trace && trace.msg) || '';
  const fail = !!(trace && trace.err);

  /* 对象：优先路径里的单据 id，其次提示语中的单号，最后退化为用户名 / 名称 */
  let target = docNoOf(pathname, hit && hit.id);
  if (!target) {
    const m = DOC_NO_RE.exec(msg);
    if (m) target = m[0];
  }
  if (!target && ctx.body) {
    target = String(ctx.body.username || ctx.body.name || '').trim() || null;
  }

  return write({
    category: 'op',
    action: def.action,
    action_name: def.name,
    result: fail ? 'fail' : 'ok',
    user_id: ctx.user.id,
    username: ctx.user.username,
    user_name: ctx.user.name,
    role_name: ctx.user.role_name || ctx.user.role || '',
    target,
    detail: !msg || msg === '已保存' || msg === '授权已保存' ? def.name + (target ? '：' + target : '') : msg,
    ip: ctx.ip,
  });
}

/* 权限被拒绝 */
function denied(ctx, pathname) {
  const hit = routeOf(pathname);
  const name = hit ? hit.def.name : pathname;
  return op(ctx, { action: 'denied', name: '无权限操作', target: null, detail: `越权尝试：${name}（${pathname}）`, result: 'fail' });
}

/* ============ 历史补录 ============
   依据业务表时间戳重建，无法重建的动作（查询、查看）不在其中。
   时间取自单据 / 会话 / 流水自身的时间，不是真实访问时间，界面上会标「补录」。 */
const TYPE_LABEL = { IN: '入库单', REQ: '领料申请单', OUT: '出库单', RET: '退料入库单' };

function backfill() {
  const done = safe(() => one("SELECT v FROM meta WHERE k = 'audit_backfill_v1'"), null);
  if (done) return 0;

  let n = 0;
  const put = (o) => {
    const before = safe(() => one('SELECT id FROM audit_logs WHERE ukey = ?', o.ukey), null);
    if (before) return;
    write({ ...o, src: 'backfill' });
    n += 1;
  };

  /* 1) 账号创建 */
  for (const u of all('SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.id')) {
    put({
      created_at: u.created_at || now(),
      category: 'op', action: 'sys.user', action_name: '新建账号',
      user_id: u.id, username: u.username, user_name: u.name, role_name: u.role_name || '',
      target: u.username, detail: `新建账号 ${u.username}（${u.name}）`,
      ukey: 'bf:user:' + u.id,
    });
  }

  /* 2) 历史登录（会话表里仍留存的）。早期会话没有 created_at，
        但有效期恒为"创建 + 7 天"，可据此倒推，避免把时间写成补录当天。 */
  const sessTime = (s) => {
    if (s.created_at) return s.created_at;
    const d = new Date(s.expires_at || '');
    if (Number.isNaN(d.getTime())) return null;
    d.setTime(d.getTime() - 7 * 864e5);
    return d.toLocaleString('sv-SE').replace('T', ' ');
  };
  for (const s of all('SELECT s.*, u.username, u.name, r.name AS role_name FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN roles r ON r.id = u.role_id')) {
    const at = sessTime(s);
    if (!at) continue;
    put({
      created_at: at,
      category: 'auth', action: 'login', action_name: '登录',
      user_id: s.user_id, username: s.username, user_name: s.name, role_name: s.role_name || '',
      detail: '登录系统', ip: s.ip || null,
      ukey: 'bf:sess:' + s.token,
    });
  }

  /* 3) 单据：建单 / 提交 / 作废 */
  const docs = all(
    `SELECT d.*, p.name AS project_name, m.name AS major_name, t.name AS team_name, u.username, u.name AS user_name,
            r.name AS role_name, sd.doc_no AS source_no,
            (SELECT COUNT(*) FROM doc_items x WHERE x.doc_id = d.id) AS n,
            (SELECT IFNULL(SUM(x.qty),0) FROM doc_items x WHERE x.doc_id = d.id) AS qty
     FROM docs d
     LEFT JOIN projects p ON p.id = d.project_id
     LEFT JOIN majors m ON m.id = d.major_id
     LEFT JOIN teams t ON t.id = d.team_id
     LEFT JOIN users u ON u.id = d.created_by
     LEFT JOIN roles r ON r.id = u.role_id
     LEFT JOIN docs sd ON sd.id = d.source_doc_id
     ORDER BY d.id`
  );
  for (const d of docs) {
    const base = {
      user_id: d.created_by, username: d.username, user_name: d.user_name, role_name: d.role_name || '',
      target: d.doc_no,
    };
    const where = [d.project_name, d.major_name, d.team_name].filter(Boolean).join(' / ');
    const what = `${TYPE_LABEL[d.type] || d.type} ${d.doc_no}${where ? '｜' + where : ''}｜${d.n} 项，合计 ${d.qty}`;
    const src = d.source_no ? `｜关联 ${d.source_no}` : '';

    put({
      ...base, created_at: d.created_at || now(),
      action: 'doc.create', action_name: '创建' + (TYPE_LABEL[d.type] || '单据'),
      detail: d.type === 'OUT' || d.type === 'RET' ? what + src : what,
      ukey: 'bf:doc-new:' + d.id,
    });

    if ((d.type === 'IN' || d.type === 'REQ') && d.submitted_at) {
      put({
        ...base, created_at: d.submitted_at,
        action: 'doc.submit', action_name: '提交' + (TYPE_LABEL[d.type] || '单据'),
        detail: `提交${TYPE_LABEL[d.type]} ${d.doc_no}`,
        ukey: 'bf:doc-submit:' + d.id,
      });
    }

    if (d.status === 'void' && d.modified_at) {
      put({
        ...base, created_at: d.modified_at,
        user_id: d.modified_by || d.created_by,
        action: 'doc.void', action_name: '作废' + (TYPE_LABEL[d.type] || '单据'),
        detail: `作废${TYPE_LABEL[d.type]} ${d.doc_no}`,
        ukey: 'bf:doc-void:' + d.id,
      });
    }
  }

  /* 4) 放弃领用 */
  for (const c of all(
    `SELECT c.*, d.doc_no, u.username, u.name AS user_name, r.name AS role_name
     FROM req_closures c LEFT JOIN docs d ON d.id = c.doc_id
     LEFT JOIN users u ON u.id = c.user_id LEFT JOIN roles r ON r.id = u.role_id`
  )) {
    put({
      created_at: c.created_at || now(),
      action: 'req.close', action_name: '放弃领用',
      user_id: c.user_id, username: c.username, user_name: c.user_name, role_name: c.role_name || '',
      target: c.doc_no, detail: `放弃领用 ${c.qty}（${c.reason || '放弃领用'}）`,
      ukey: 'bf:closure:' + c.id,
    });
  }

  run("INSERT OR REPLACE INTO meta(k, v) VALUES('audit_backfill_v1', ?)", String(n));
  return n;
}

/* 统计（日志页头部） */
function summary(where, args) {
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return safe(
    () =>
      one(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN category = 'auth' THEN 1 ELSE 0 END) auth,
                SUM(CASE WHEN category = 'op' THEN 1 ELSE 0 END) op,
                SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END) fail
         FROM audit_logs ${w}`,
        ...args
      ),
    { total: 0, auth: 0, op: 0, fail: 0 }
  );
}

module.exports = { write, op, record, denied, backfill, summary, RULES };
