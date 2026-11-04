'use strict';
const crypto = require('node:crypto');
const { all, one, run, now, today, STATUS, projectScope, nextDocNo, STOCK_SQL } = require('./db');
const { can, PERM_KEYS, PERM_LABELS, PERM_GROUPS, hashPassword, verifyPassword, createSession } = require('./auth');
const U = require('./ui');
const { parseImport, TEMPLATE_HEADER } = require('./sheet');
const { buildXlsx } = require('./xlsx');
const idem = require('./idem');

const q1 = (v) => (Array.isArray(v) ? v[0] : v) || '';
const toNum = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const fmt = (v) => U.num(v);
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const err = (ctx, msg, back) => ctx.flash(back, msg, 'err');

function page(ctx, title, active, body, opt = {}) {
  return ctx.html(
    U.layout({ title, user: ctx.user, active, body, wide: opt.wide !== false, topRight: opt.topRight }),
    opt.status || 200
  );
}

function msgBar(ctx) {
  return U.flash(q1(ctx.query.msg), q1(ctx.query.err) ? 'err' : 'ok');
}

/* ============ 登录 ============ */
function loginPage(ctx, error) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 龙口海工项目部</title>
<link rel="icon" href="/logo.png"><link rel="stylesheet" href="/app.css"></head><body class="login-body">
<div class="login-card">
  <div class="login-brand"><span class="brand-mark"><img src="/logo.png" alt="龙口海工项目部"></span><div><b>龙口海工项目部</b><small>收发存管理系统</small></div></div>
  ${error ? `<div class="flash err">${U.esc(error)}</div>` : ''}
  <form method="post" action="/login" class="login-form">
    <label class="field"><span>账号</span><input name="username" required autofocus autocomplete="username"></label>
    <label class="field"><span>密码</span><input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn primary block">登录</button>
  </form>
  <p class="login-hint">账号由管理员分配</p>
</div></body></html>`;
}

/* 单点登录：同一账号只允许一个有效会话。
   登录时若发现别处还登着，先给确认页；用户点确认后才踢掉旧会话。
   确认令牌只存内存、3 分钟有效、一次性，且必须先通过密码校验才会下发——
   所以光知道账号名没办法把别人踢下线。 */
const TAKEOVER = new Map(); // token -> { uid, exp }

function kickOthers(uid) {
  const olds = all('SELECT token FROM sessions WHERE user_id = ?', uid);
  let ai = null;
  try { ai = require('./ai'); } catch {}
  for (const s of olds) {
    if (ai) { try { ai.forget(s.token); } catch {} }
  }
  run('DELETE FROM sessions WHERE user_id = ?', uid);
}

function conflictPage(user, live, token) {
  const latest = live[0] || {};
  const when = latest.created_at || '未知时间';
  const ip = latest.ip ? `，来自 ${U.esc(latest.ip)}` : '';
  const more = live.length > 1 ? `（共 ${live.length} 处登录）` : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录确认 · 龙口海工项目部</title>
<link rel="icon" href="/logo.png"><link rel="stylesheet" href="/app.css"></head><body class="login-body">
<div class="login-card">
  <div class="login-brand"><span class="brand-mark"><img src="/logo.png" alt="龙口海工项目部"></span><div><b>龙口海工项目部</b><small>收发存管理系统</small></div></div>
  <div class="flash warn">该账号已在别处登录：${U.esc(when)}${ip}${more}</div>
  <p class="login-hint" style="text-align:left;line-height:1.8;margin:0 0 16px;font-size:12.5px;color:#5b6472">为保证单据不串号，同一账号只允许一个有效登录。<br>点「改为当前登录」后，其他地方（另一台电脑或另一个浏览器）的登录会立即失效。</p>
  <form method="post" action="/login">
    <input type="hidden" name="confirm" value="${U.esc(token)}">
    <button class="btn primary block">改为当前登录</button>
  </form>
  <a class="btn block" href="/login" style="margin-top:8px">取消</a>
</div></body></html>`;
}

function handleLogin(ctx) {
  const g = ctx.throttle;
  if (g && !g.ok(ctx.ip)) return ctx.html(loginPage(ctx, '尝试次数过多，请 5 分钟后再试'), 429);

  /* 第二步：用户在确认页点了"改为当前登录" */
  const confirm = String(q1(ctx.body.confirm) || '').trim();
  if (confirm) {
    const p = TAKEOVER.get(confirm);
    TAKEOVER.delete(confirm);
    if (!p || p.exp < Date.now()) return ctx.html(loginPage(ctx, '确认已过期，请重新登录'), 401);
    const u = one('SELECT * FROM users WHERE id = ? AND active = 1', p.uid);
    if (!u) return ctx.html(loginPage(ctx, '账号不存在或已停用'), 401);
    kickOthers(u.id);
    const token = createSession(u.id, { ip: ctx.ip });
    ctx.setCookie('sid', token, { maxAge: 7 * 86400 });
    return ctx.redirect('/');
  }

  const username = String(q1(ctx.body.username) || '').trim();
  const password = q1(ctx.body.password) || '';
  const user = one('SELECT * FROM users WHERE username = ? AND active = 1', username);
  if (!user || !verifyPassword(password, user.password)) {
    if (g) g.fail(ctx.ip);
    const left = g ? g.remaining(ctx.ip) : 0;
    return ctx.html(loginPage(ctx, '账号或密码不正确' + (left <= 2 && left > 0 ? `（再错 ${left} 次将锁定 5 分钟）` : '')), 401);
  }
  if (g) g.reset(ctx.ip);

  /* 同一账号已有有效会话 → 先让用户确认，不直接放行也不直接踢人 */
  const live = all(
    'SELECT token, created_at, ip FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
    user.id,
    new Date().toISOString()
  );
  if (live.length) {
    const tk = crypto.randomBytes(24).toString('hex');
    for (const [k, v] of TAKEOVER) if (v.exp < Date.now()) TAKEOVER.delete(k);
    TAKEOVER.set(tk, { uid: user.id, exp: Date.now() + 3 * 60 * 1000 });
    return ctx.html(conflictPage(user, live, tk));
  }

  const token = createSession(user.id, { ip: ctx.ip });
  ctx.setCookie('sid', token, { maxAge: 7 * 86400 });
  return ctx.redirect('/');
}

/* ============ 公共 ============ */
const projectsOf = (ctx) => projectScope(ctx.user);
const majorsOf = () => all('SELECT * FROM majors WHERE active = 1 ORDER BY sort, id');
const teamsOf = () => all('SELECT * FROM teams WHERE active = 1 ORDER BY sort, id');

const projSelect = (ctx, name, value, opt = {}) =>
  U.select(name, projectsOf(ctx).map((p) => ({ value: p.id, label: p.name })), value, {
    required: opt.required,
    placeholder: opt.placeholder || '请选择工程',
  });
const majorSelect = (name, value, opt = {}) =>
  U.select(name, majorsOf().map((m) => ({ value: m.id, label: m.name })), value, {
    required: opt.required,
    placeholder: opt.placeholder || '请选择专业',
  });
const teamSelect = (name, value, opt = {}) =>
  U.select(name, teamsOf().map((t) => ({ value: t.id, label: t.name })), value, {
    required: opt.required,
    placeholder: opt.placeholder || '请选择施工队伍',
  });

function stockRows(where = [], args = [], opts = {}) {
  const cond = ['si.active = 1', ...where];
  const having = opts.positive ? 'HAVING balance > 0' : '';
  return all(
    `${STOCK_SQL} AND ${cond.join(' AND ')} GROUP BY si.id ${having} ORDER BY pj.name, mj.name, si.id`,
    ...args
  );
}

const balanceOf = (itemId) => one('SELECT IFNULL(SUM(qty),0) b FROM stock_moves WHERE item_id = ?', itemId).b;
const outedOf = (reqId, itemId) =>
  one(
    `SELECT IFNULL(SUM(o.qty),0) q FROM doc_items o JOIN docs od ON od.id=o.doc_id
     WHERE od.type='OUT' AND od.status!='void' AND od.source_doc_id=? AND o.stock_item_id=?`,
    reqId, itemId
  ).q;
const returnedOf = (reqId, itemId) =>
  one(
    `SELECT IFNULL(SUM(o.qty),0) q FROM doc_items o JOIN docs od ON od.id=o.doc_id
     WHERE od.type='RET' AND od.source_doc_id=? AND o.stock_item_id=?`,
    reqId, itemId
  ).q;

function docOr404(ctx, id) {
  const d = one(
    `SELECT d.*, p.name AS project_name, p.code AS project_code, m.name AS major_name, t.name AS team_name,
            u.name AS maker, u2.name AS checker, s.doc_no AS source_no
     FROM docs d
     LEFT JOIN projects p ON p.id = d.project_id
     LEFT JOIN majors m ON m.id = d.major_id
     LEFT JOIN teams t ON t.id = d.team_id
     LEFT JOIN users u ON u.id = d.created_by
     LEFT JOIN users u2 ON u2.id = d.modified_by
     LEFT JOIN docs s ON s.id = d.source_doc_id
     WHERE d.id = ?`,
    id
  );
  if (!d) {
    page(ctx, '单据不存在', '', '<section class="panel">单据不存在</section>', { status: 404 });
    return null;
  }
  if (ctx.user.role_code !== 'admin' && !projectsOf(ctx).some((p) => p.id === d.project_id)) {
    page(ctx, '无权限', '', '<section class="panel">该单据不属于你参与的工程。</section>', { status: 403 });
    return null;
  }
  return d;
}

const docItems = (id) => all('SELECT * FROM doc_items WHERE doc_id = ? ORDER BY seq, id', id);

/* 关键字搜索：物资名称 / 规格型号 必须参与匹配（计划编号、编码、单号、备注为辅助元素） */
const docsItemMatch = (docAlias) =>
  `EXISTS(SELECT 1 FROM doc_items x WHERE x.doc_id=${docAlias}.id AND (x.name LIKE ? OR x.spec LIKE ? OR x.plan_no LIKE ? OR x.material_code LIKE ?))`;

/* 其他已提交未出库领料单对某库存条目的占用量（已撤回/已出完的不算） */
const pendingOf = (itemId, excludeDocId) =>
  one(
    `SELECT IFNULL(SUM(CASE WHEN x.qty - IFNULL(cl.cq,0) > IFNULL(oq.outed,0)
                            THEN x.qty - IFNULL(cl.cq,0) - IFNULL(oq.outed,0) ELSE 0 END),0) p
     FROM doc_items x
     JOIN docs xd ON xd.id = x.doc_id
     LEFT JOIN (
       SELECT o.stock_item_id AS sid, o.doc_id AS did, SUM(o.qty) AS outed
       FROM doc_items o JOIN docs od ON od.id = o.doc_id
       WHERE od.type = 'OUT' AND od.status != 'void'
       GROUP BY o.stock_item_id, o.doc_id
     ) oq ON oq.sid = x.stock_item_id AND oq.did = x.doc_id
     LEFT JOIN (
       SELECT c.doc_id AS cid, c.stock_item_id AS csid, SUM(c.qty) AS cq
       FROM req_closures c GROUP BY c.doc_id, c.stock_item_id
     ) cl ON cl.cid = x.doc_id AND cl.csid = x.stock_item_id
     WHERE xd.type = 'REQ' AND xd.status IN ('submitted','part')
       AND x.stock_item_id = ? AND x.doc_id != ?`,
    itemId, excludeDocId || 0
  ).p;

/* 某张领料单某项物资已了结（放弃）的数量 */
const closedOf = (docId, itemId) =>
  one('SELECT IFNULL(SUM(qty),0) q FROM req_closures WHERE doc_id=? AND stock_item_id=?', docId, itemId).q;

/* 某张领料单所有行还剩多少没领（申请 − 已出 − 已了结） */
const waitOfDoc = (docId) =>
  one(
    `SELECT IFNULL(SUM(CASE WHEN x.qty - IFNULL(c.cq,0) - IFNULL(o.oq,0) > 0
                            THEN x.qty - IFNULL(c.cq,0) - IFNULL(o.oq,0) ELSE 0 END),0) w
     FROM doc_items x
     LEFT JOIN (SELECT doc_id, stock_item_id, SUM(qty) cq FROM req_closures GROUP BY doc_id, stock_item_id) c
       ON c.doc_id = x.doc_id AND c.stock_item_id = x.stock_item_id
     LEFT JOIN (SELECT od.source_doc_id sid, o.stock_item_id iid, SUM(o.qty) oq
                FROM doc_items o JOIN docs od ON od.id = o.doc_id
                WHERE od.type='OUT' AND od.status!='void' AND od.source_doc_id IS NOT NULL
                GROUP BY od.source_doc_id, o.stock_item_id) o
       ON o.sid = x.doc_id AND o.iid = x.stock_item_id
     WHERE x.doc_id = ?`,
    docId
  ).w;

/* ============ 工作台 ============ */
function dashboard(ctx) {
  const pids = projectsOf(ctx).map((p) => p.id);
  const scope = pids.length ? `(${pids.join(',')})` : '(0)';
  const d0 = today();
  /* 四个卡片：今日新增入库单 / 待出库领料单 / 今日新增领料单 / 今日出库 */
  const inToday = one(`SELECT COUNT(*) n FROM docs WHERE type='IN' AND doc_date=? AND project_id IN ${scope}`, d0).n;
  const waitOut = one(`SELECT COUNT(*) n FROM docs WHERE type='REQ' AND status IN ('submitted','part') AND project_id IN ${scope}`).n;
  const reqToday = one(`SELECT COUNT(*) n FROM docs WHERE type='REQ' AND doc_date=? AND project_id IN ${scope}`, d0).n;
  const outToday = one(`SELECT COUNT(*) n FROM docs WHERE type='OUT' AND doc_date=? AND project_id IN ${scope}`, d0).n;
  const recent = all(
    `SELECT d.*, p.name AS project_name FROM docs d LEFT JOIN projects p ON p.id=d.project_id
     WHERE d.project_id IN ${scope} ORDER BY d.id DESC LIMIT 8`
  );
  const bk = require('./backup').status();
  const bkSize = bk.size ? (bk.size > 1048576 ? (bk.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bk.size / 1024)) + ' KB') : '';
  const bkText = bk.empty
    ? '⚠ 还没有任何备份文件，请检查备份任务'
    : bk.ok
      ? `🛡 每日备份正常：最近 ${bk.at}（${bkSize}，共 ${bk.count} 份）`
      : `⚠ 最近一次备份是 ${bk.ageHours} 小时前（${bk.at}），请检查备份任务是否在运行`;
  const body = `
  ${msgBar(ctx)}
  <div class="cards">
    <div class="card"><small>今日新增入库单</small><b>${inToday}</b><a href="/in/list">去查看</a></div>
    <div class="card"><small>待出库领料单</small><b>${waitOut}</b><a href="/out/new">去出库</a></div>
    <div class="card"><small>今日新增领料单</small><b>${reqToday}</b><a href="/req/list">去查看</a></div>
    <div class="card"><small>今日出库</small><b>${outToday}</b><a href="/out/list">去查看</a></div>
  </div>
  <div class="bk-line${bk.ok ? '' : ' bad'}">${U.esc(bkText)}</div>
  <section class="panel"><h2>最近单据</h2>
    ${U.table(
      [{ label: '单号' }, { label: '类型' }, { label: '工程' }, { label: '日期' }, { label: '状态' }, { label: '' }],
      recent.map((d) => [
        `<a href="/doc/${d.id}">${U.esc(d.doc_no)}</a>`,
        U.esc(U.docTypeName(d.type)),
        U.esc(d.project_name || ''),
        U.esc(d.doc_date || ''),
        U.statusBadge(d.status),
        '<a class="mini" href="/doc/' + d.id + '">查看</a>',
      ]),
      { empty: '还没有单据' }
    )}
  </section>`;
  return page(ctx, '工作台', '/', body);
}

/* ============ 入库 ============ */
function inNewPage(ctx) {
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <h2>入库登记</h2>
    <p class="muted">一次导入生成一张入库单；一批只能是同一个工程、同一个专业。工程名称必须与所选工程一致，否则整批失败。</p>
    <form method="post" action="/in/create" enctype="multipart/form-data" class="form-grid">
      <input type="hidden" name="_ft" value="${idem.issue()}">
      ${U.field('工程', projSelect(ctx, 'project_id', '', { required: true }), { req: 1 })}
      ${U.field('专业', majorSelect('major_id', '', { required: true }), { req: 1 })}
      ${U.field('到货日期', U.input('arrival_date', today(), { type: 'date', required: true }), { req: 1 })}
      ${U.field('备注', U.input('remark', '', { placeholder: '可不填' }))}
      <div class="full">
        <div class="subhead">导入物资</div>
        <div class="row-gap">
          <a class="btn ghost" href="/in/template">下载导入模板</a>
          <span class="muted">或直接把 Excel 里填好的内容复制粘贴到下面</span>
        </div>
        <label class="field full"><span>上传文件（.xlsx / .csv）</span><input type="file" name="file" accept=".xlsx,.csv,.txt"></label>
        <label class="field full"><span>或粘贴（Tab / 逗号分隔）</span>
          <textarea name="text" rows="8" placeholder="序号&#9;工程名称&#9;物料编码&#9;物资名称&#9;规格型号&#9;执行标准/技术要求&#9;单位&#9;数量&#9;需求计划编号"></textarea>
        </label>
      </div>
      <div class="form-actions full"><button class="btn primary">解析并生成入库单</button></div>
    </form>
  </section>`;
  return page(ctx, '入库登记', '/in/new', body);
}

function inCreate(ctx) {
  const b = ctx.body;
  const projectId = Number(b.project_id || 0);
  const majorId = Number(b.major_id || 0);
  const arrival = String(b.arrival_date || today());
  const project = one('SELECT * FROM projects WHERE id = ?', projectId);
  const major = one('SELECT * FROM majors WHERE id = ?', majorId);
  if (!project || !major) return err(ctx, '请选择工程和专业', '/in/new');
  if (!projectsOf(ctx).some((p) => p.id === projectId)) return err(ctx, '该工程不在你的权限范围', '/in/new');

  let rows;
  try {
    if (b.__file && b.__file.buffer && b.__file.buffer.length) rows = parseImport(b.__file.buffer, b.__file.filename);
    else if (String(b.text || '').trim()) rows = parseImport(Buffer.from(String(b.text), 'utf8'), 'paste.txt');
    else return err(ctx, '请上传文件或粘贴内容', '/in/new');
  } catch (e) {
    return err(ctx, e.message, '/in/new');
  }
  if (!rows.length) return err(ctx, '没有解析到任何数据行', '/in/new');

  const errors = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.project && r.project !== project.name) errors.push(`第 ${r.row} 行：工程名称「${r.project}」与本单所选工程「${project.name}」不一致`);
    if (!r.name) errors.push(`第 ${r.row} 行：物资名称不能为空`);
    if (!r.unit) errors.push(`第 ${r.row} 行：单位不能为空`);
    if (!r.qty || r.qty <= 0) errors.push(`第 ${r.row} 行：数量必须是大于 0 的数字（当前「${r.qtyRaw}」）`);
    const key = [r.plan, r.name, r.spec, r.unit].join('|');
    if (seen.has(key)) errors.push(`第 ${r.row} 行：与文件内前面的行重复（计划编号+物资+规格+单位相同）`);
    seen.add(key);
    const dup = one(
      `SELECT id FROM stock_items WHERE project_id=? AND IFNULL(plan_no,'')=IFNULL(?,'') AND name=? AND IFNULL(spec,'')=IFNULL(?,'') AND unit=? AND active=1`,
      projectId, r.plan || '', r.name, r.spec || '', r.unit
    );
    if (dup) errors.push(`第 ${r.row} 行：该计划编号下「${r.name} ${r.spec || ''}」已入库，不能重复导入`);
  }
  if (errors.length) {
    const body = `
    ${U.flash('导入失败，共 ' + errors.length + ' 处问题', 'err')}
    <section class="panel"><h2>校验未通过</h2>
      <ul class="err-list">${errors.slice(0, 40).map((e) => `<li>${U.esc(e)}</li>`).join('')}</ul>
      ${errors.length > 40 ? `<p class="muted">仅显示前 40 条，共 ${errors.length} 条</p>` : ''}
      <div class="form-actions"><a class="btn" href="/in/new">返回修改后重新导入</a></div>
    </section>`;
    return page(ctx, '入库登记', '/in/new', body);
  }

  // 表单令牌：同一份导入只允许生成一张入库单（防双击 / 网络重试）
  const tk = idem.claim(b._ft);
  if (!tk.fresh) return ctx.flash(tk.doc_id ? '/in/' + tk.doc_id : '/in/list', '这份表单刚才已提交过，未重复生成入库单');

  const docNo = nextDocNo('IN', projectId);
  const r = run(
    `INSERT INTO docs(doc_no,type,doc_date,project_id,major_id,status,remark,created_by,created_at)
     VALUES(?,?,?,?,?,'draft',?,?,?)`,
    docNo, 'IN', arrival, projectId, majorId, String(b.remark || ''), ctx.user.id, now()
  );
  const docId = Number(r.lastInsertRowid);
  idem.bind(b._ft, docId);
  rows.forEach((row, i) => {
    run(
      `INSERT INTO doc_items(doc_id,seq,plan_no,material_code,name,spec,tech_req,unit,qty)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      docId, i + 1, row.plan || '', row.code || '', row.name, row.spec || '', row.tech || '', row.unit, row.qty
    );
  });
  return ctx.flash('/in/' + docId, `已生成入库单 ${docNo}，共 ${rows.length} 行，确认无误后点提交`);
}

function inDetail(ctx, id) {
  const d = docOr404(ctx, id);
  if (!d) return;
  if (d.type !== 'IN') return ctx.redirect('/doc/' + id);
  const items = docItems(d.id);
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <div class="doc-head">
      <div><small>单号</small><b>${U.esc(d.doc_no)}</b></div>
      <div><small>工程</small><b>${U.esc(d.project_name || '')}</b></div>
      <div><small>专业</small><b>${U.esc(d.major_name || '')}</b></div>
      <div><small>到货日期</small><b>${U.esc(d.doc_date || '')}</b></div>
      <div><small>制单人</small><b>${U.esc(d.maker || '')}</b></div>
      <div><small>状态</small><b>${U.statusBadge(d.status)}</b></div>
    </div>
    ${d.remark ? `<p class="muted">备注：${U.esc(d.remark)}</p>` : ''}
    <div class="form-actions">
      ${d.status === 'draft' && can(ctx.user, 'in.create') ? `<form method="post" action="/in/${d.id}/submit" onsubmit="return confirm('提交后库存立即增加且不可修改，确定提交？')"><button class="btn primary">提交入库</button></form>` : ''}
      ${d.status === 'submitted' && can(ctx.user, 'doc.admin') ? `<form method="post" action="/in/${d.id}/void" onsubmit="return confirm('作废将扣回本单库存，确定？')"><button class="btn danger">作废</button></form>` : ''}
      <a class="btn" href="/in/list">返回列表</a>
    </div>
  </section>
  <section class="panel"><h2>明细（${items.length} 行）</h2>
    ${U.table(
      [{ label: '序号' }, { label: '需求计划编号' }, { label: '物资名称' }, { label: '规格型号' }, { label: '技术要求' }, { label: '单位' }, { label: '数量', align: 'r' }],
      items.map((i2) => [String(i2.seq), U.esc(i2.plan_no || ''), U.esc(i2.name), U.esc(i2.spec || ''), U.esc(i2.tech_req || ''), U.esc(i2.unit), fmt(i2.qty)])
    )}
  </section>`;
  return page(ctx, '入库单', '/in/list', body);
}

function inSubmit(ctx, id) {
  const d = one('SELECT * FROM docs WHERE id = ? AND type = ?', id, 'IN');
  if (!d) return err(ctx, '单据不存在', '/in/list');
  if (d.status !== 'draft') return err(ctx, '单据状态已变化，请刷新', '/in/' + id);
  if (!can(ctx.user, 'in.create')) return err(ctx, '没有提交权限', '/in/' + id);
  const items = docItems(id);
  if (!items.length) return err(ctx, '单据没有明细', '/in/' + id);
  const t = now();
  for (const it of items) {
    const r = run(
      `INSERT INTO stock_items(project_id,major_id,plan_no,material_code,name,spec,tech_req,unit,arrival_date,seq,doc_id,active,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      d.project_id, d.major_id, it.plan_no || '', it.material_code || '', it.name, it.spec || '', it.tech_req || '', it.unit,
      d.doc_date, it.seq, d.id, t
    );
    const itemId = Number(r.lastInsertRowid);
    run('UPDATE doc_items SET stock_item_id = ? WHERE id = ?', itemId, it.id);
    run(
      'INSERT INTO stock_moves(item_id,doc_id,doc_type,qty,doc_date,user_id,created_at) VALUES(?,?,?,?,?,?,?)',
      itemId, d.id, 'IN', it.qty, d.doc_date, ctx.user.id, t
    );
  }
  run("UPDATE docs SET status='submitted', submitted_at=? WHERE id=?", t, id);
  return ctx.flash('/in/' + id, '已提交，库存已增加');
}

function inVoid(ctx, id) {
  const d = one('SELECT * FROM docs WHERE id = ? AND type = ?', id, 'IN');
  if (!d) return err(ctx, '单据不存在', '/in/list');
  if (d.status !== 'submitted') return err(ctx, '只有已提交的单据可以作废', '/in/' + id);
  if (!can(ctx.user, 'doc.admin')) return err(ctx, '你没有撤改已提交单据的权限', '/in/' + id);
  const items = docItems(id);
  for (const it of items) {
    const bal = balanceOf(it.stock_item_id);
    if (Math.abs(Number(bal) - Number(it.qty)) > 1e-9) return err(ctx, `「${it.name}」已被领用，不能作废`, '/in/' + id);
  }
  for (const it of items) {
    run('DELETE FROM stock_moves WHERE item_id = ? AND doc_id = ?', it.stock_item_id, id);
    run('UPDATE stock_items SET active = 0 WHERE id = ?', it.stock_item_id);
  }
  run("UPDATE docs SET status='void', modified_by=?, modified_at=? WHERE id=?", ctx.user.id, now(), id);
  return ctx.flash('/in/' + id, '已作废，库存已扣回');
}

function inList(ctx) {
  const pid = Number(q1(ctx.query.project) || 0);
  const from = q1(ctx.query.from) || '';
  const to = q1(ctx.query.to) || '';
  const status = q1(ctx.query.status) || '';
  const q = String(q1(ctx.query.q) || '').trim();
  const pids = projectsOf(ctx).map((p) => p.id);
  if (!pids.length) return page(ctx, '入库查询', '/in/list', '<section class="panel">你还没有被分配到任何工程。</section>');
  const where = [`d.type = 'IN'`, `d.project_id IN (${pids.join(',')})`];
  const args = [];
  if (pid) { where.push('d.project_id = ?'); args.push(pid); }
  if (from) { where.push('d.doc_date >= ?'); args.push(from); }
  if (to) { where.push('d.doc_date <= ?'); args.push(to); }
  if (status) { where.push('d.status = ?'); args.push(status); }
  if (q) {
    where.push(`(d.doc_no LIKE ? OR d.remark LIKE ? OR ${docsItemMatch('d')})`);
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = all(
    `SELECT d.*, p.name AS project_name, m.name AS major_name, u.name AS maker,
            (SELECT COUNT(*) FROM doc_items x WHERE x.doc_id = d.id) AS n,
            (SELECT IFNULL(SUM(x.qty),0) FROM doc_items x WHERE x.doc_id = d.id) AS qty,
            (SELECT GROUP_CONCAT(DISTINCT IFNULL(x.plan_no,'')) FROM doc_items x WHERE x.doc_id = d.id) AS plan_all
     FROM docs d LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN majors m ON m.id=d.major_id
     LEFT JOIN users u ON u.id=d.created_by
     WHERE ${where.join(' AND ')} ORDER BY d.doc_date DESC, d.id DESC LIMIT 300`,
    ...args
  );
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <form class="toolbar" method="get" action="/in/list">
      ${U.select('project', projectsOf(ctx).map((p) => ({ value: p.id, label: p.name })), pid, { placeholder: '全部工程' })}
      <input type="date" name="from" value="${U.esc(from)}"> <span class="muted">至</span> <input type="date" name="to" value="${U.esc(to)}">
      ${U.select('status', [{ value: 'draft', label: '保存' }, { value: 'submitted', label: '已提交' }, { value: 'void', label: '已作废' }], status, { placeholder: '全部状态' })}
      <input name="q" value="${U.esc(q)}" placeholder="单号 / 物资 / 规格 / 计划编号 / 备注">
      <button class="btn">查询</button>
      <a class="btn ghost" href="/in/new">入库登记</a>
    </form>
  </section>
  <section class="panel">${U.table(
    [{ label: '单号' }, { label: '工程' }, { label: '专业' }, { label: '到货日期' }, { label: '需求计划编号' }, { label: '行数', align: 'r' }, { label: '数量合计', align: 'r' }, { label: '制单人' }, { label: '备注' }, { label: '状态' }, { label: '' }],
    rows.map((d) => {
      const plans = String(d.plan_all || '').split(',').filter(Boolean);
      const planText = plans.length > 1 ? `共 ${plans.length} 个` : plans[0] || '';
      return [
        `<a href="/in/${d.id}">${U.esc(d.doc_no)}</a>`,
        U.esc(d.project_name || ''),
        U.esc(d.major_name || ''),
        U.esc(d.doc_date || ''),
        U.esc(planText),
        String(d.n),
        fmt(d.qty),
        U.esc(d.maker || ''),
        U.esc(d.remark || ''),
        U.statusBadge(d.status),
        `<a class="mini" href="/in/${d.id}">查看</a>`,
      ];
    }),
    { empty: '没有符合条件的入库单' }
  )}</section>`;
  return page(ctx, '入库查询', '/in/list', body);
}

function inItemsPage(ctx) {
  const pid = Number(q1(ctx.query.project) || 0);
  const mid = Number(q1(ctx.query.major) || 0);
  const from = q1(ctx.query.from) || '';
  const to = q1(ctx.query.to) || '';
  const plan = String(q1(ctx.query.plan) || '').trim();
  const q = String(q1(ctx.query.q) || '').trim();
  const pids = projectsOf(ctx).map((p) => p.id);
  if (!pids.length) return page(ctx, '入库明细', '/in/items', '<section class="panel">你还没有被分配到任何工程。</section>');
  const where = [`si.project_id IN (${pids.join(',')})`];
  const args = [];
  if (pid) { where.push('si.project_id = ?'); args.push(pid); }
  if (mid) { where.push('si.major_id = ?'); args.push(mid); }
  if (from) { where.push('si.arrival_date >= ?'); args.push(from); }
  if (to) { where.push('si.arrival_date <= ?'); args.push(to); }
  if (plan) { where.push('si.plan_no LIKE ?'); args.push(`%${plan}%`); }
  if (q) { where.push('(si.name LIKE ? OR si.spec LIKE ? OR si.material_code LIKE ? OR si.plan_no LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = stockRows(where, args);
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <form class="toolbar" method="get" action="/in/items">
      ${U.select('project', projectsOf(ctx).map((p) => ({ value: p.id, label: p.name })), pid, { placeholder: '全部工程' })}
      ${U.select('major', majorsOf().map((m) => ({ value: m.id, label: m.name })), mid, { placeholder: '全部专业' })}
      <input type="date" name="from" value="${U.esc(from)}"> <span class="muted">至</span> <input type="date" name="to" value="${U.esc(to)}">
      <input name="plan" value="${U.esc(plan)}" placeholder="需求计划编号">
      <input name="q" value="${U.esc(q)}" placeholder="物资 / 规格 / 编码 / 计划编号">
      <button class="btn">查询</button>
      ${can(ctx.user, 'export.xlsx') ? `<a class="btn ghost" href="/export?kind=in_items&project=${pid}&major=${mid}&from=${from}&to=${to}&plan=${encodeURIComponent(plan)}&q=${encodeURIComponent(q)}">导出 Excel</a>` : ''}
    </form>
  </section>
  <section class="panel">${U.table(
    [{ label: '工程' }, { label: '专业' }, { label: '序号', align: 'r' }, { label: '需求计划编号' }, { label: '物资名称' }, { label: '规格型号' }, { label: '技术要求' }, { label: '单位' }, { label: '数量', align: 'r' }, { label: '出库数量', align: 'r' }, { label: '退库数量', align: 'r' }, { label: '剩余数量', align: 'r' }],
    rows.map((r) => [
      U.esc(r.project_name), U.esc(r.major_name), String(r.seq || ''),
      U.esc(r.plan_no || ''), U.esc(r.name), U.esc(r.spec || ''), U.esc(r.tech_req || ''), U.esc(r.unit),
      fmt(r.in_qty), fmt(r.out_qty), (Number(r.ret_qty) > 0 ? `<span class="in">${fmt(r.ret_qty)}</span>` : fmt(0)), `<b>${fmt(r.balance)}</b>`,
    ]),
    { empty: '没有入库记录' }
  )}</section>`;
  return page(ctx, '入库明细', '/in/items', body);
}

/* ============ 领用申请 ============ */
function reqNewPage(ctx) {
  const pid = Number(q1(ctx.query.project) || 0);
  const tid = Number(q1(ctx.query.team) || 0);
  const mid = Number(q1(ctx.query.major) || 0);
  const ready = pid && tid && mid;
  const items = ready
    ? stockRows(['si.project_id = ?', 'si.major_id = ?'], [pid, mid], { positive: true }).map((r2) => {
        const pend = Number(pendingOf(r2.id, 0));
        return { ...r2, pend, avail: Math.max(0, Number(r2.balance) - pend) };
      })
    : [];
  const occupied = items.filter((r2) => r2.pend > 1e-9);
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <h2>领用登记</h2>
    <form class="toolbar" method="get" action="/req/new">
      ${projSelect(ctx, 'project', pid)}
      ${teamSelect('team', tid)}
      ${majorSelect('major', mid)}
      <button class="btn">列出该工程现存物资</button>
    </form>
    <p class="muted">同一张领料单只能领一个专业的物资；「可申请」= 结存 − 其他已提交未出库领料单的占用量，防止超领。</p>
  </section>
  ${
    ready
      ? `<section class="panel"><h2>现存物资（${items.length} 条）</h2>
    <form method="post" action="/req/save">
      <input type="hidden" name="project_id" value="${pid}">
      <input type="hidden" name="team_id" value="${tid}">
      <input type="hidden" name="major_id" value="${mid}">
      <input type="hidden" name="_ft" value="${idem.issue()}">
      <div class="kw-box">
        <input type="search" id="kw" placeholder="输入关键字筛选：物资名称 / 规格 / 计划编号" autocomplete="off">
        <span class="hint" id="kw-hint"></span>
      </div>
      ${U.table(
        [{ label: '选择' }, { label: '需求计划编号', width: '132px' }, { label: '物资名称' }, { label: '规格型号' }, { label: '单位' }, { label: '到货日期' }, { label: '到货数量', align: 'r' }, { label: '出库明细' }, { label: '结存', align: 'r' }, { label: '已申请待出库', align: 'r' }, { label: '可申请', align: 'r' }, { label: '本次领用', align: 'r' }],
        items.map((r) => [
          `<input type="checkbox" name="pick" value="${r.id}">`,
          U.esc(r.plan_no || ''),
          U.esc(r.name),
          U.esc(r.spec || ''),
          U.esc(r.unit),
          U.esc(r.arrival_date || ''),
          fmt(r.in_qty),
          `<a class="mini" href="/stock/${r.id}/outs" target="_blank" rel="noopener">出库明细</a>`,
          fmt(r.balance),
          r.pend > 1e-9 ? `<span class="warn-num">${fmt(r.pend)}</span>` : '0',
          `<b>${fmt(r.avail)}</b>`,
          `<input class="qty" type="number" step="0.001" min="0" max="${r.avail}" name="qty_${r.id}" placeholder="0">`,
        ]),
        { empty: '该工程该专业暂无库存，请先入库' }
      )}
      ${occupied.length ? `<p class="muted" style="color:#b42318">注意：有 ${occupied.length} 条物资已被其他已提交未出库的领料单占用，「可申请 = 结存 − 占用」，超出会被拒绝。</p>` : ''}
      <div class="form-actions">
        <label class="field"><span>备注</span><input name="remark" placeholder="用途 / 部位，可不填"></label>
        <button class="btn primary"${items.length ? '' : ' disabled'}>生成领料申请单</button>
      </div>
    </form></section>`
      : '<section class="panel"><p class="muted">请先选择工程、施工队伍和专业。</p></section>'
  }`;
  return page(ctx, '领用登记', '/req/new', body);
}

function reqSave(ctx) {
  const b = ctx.body;
  const pid = Number(b.project_id || 0);
  const tid = Number(b.team_id || 0);
  const mid = Number(b.major_id || 0);
  if (!pid || !tid || !mid) return err(ctx, '请选择工程、施工队伍和专业', '/req/new');
  const back = `/req/new?project=${pid}&team=${tid}&major=${mid}`;
  const picks = arr(b.pick).map(Number).filter(Boolean);
  if (!picks.length) return err(ctx, '请至少勾选一条物资', back);

  const lines = [];
  const problems = [];
  for (const id of picks) {
    const qty = toNum(b['qty_' + id]);
    const item = one('SELECT * FROM stock_items WHERE id = ? AND active = 1', id);
    if (!item || item.project_id !== pid || item.major_id !== mid) continue;
    if (!qty || qty <= 0) { problems.push(`「${item.name}」未填写领用数量`); continue; }
    const bal = Number(balanceOf(id));
    const pend = Number(pendingOf(id, 0));
    const avail = bal - pend;
    if (qty > avail + 1e-9) {
      problems.push(
        pend > 1e-9
          ? `「${item.name}」可申请 ${fmt(avail)}（结存 ${fmt(bal)}，其他领料单已占用 ${fmt(pend)}），本次填了 ${fmt(qty)}`
          : `「${item.name}」可申请 ${fmt(avail)}，本次填了 ${fmt(qty)}`
      );
      continue;
    }
    lines.push({ item, qty });
  }
  if (!lines.length) return err(ctx, problems[0] || '没有有效的领用行', back);
  if (problems.length) return err(ctx, problems.join('；'), back);

  // 表单令牌：同一份表单只允许生成一张领料单（防双击 / 网络重试）
  const tk = idem.claim(b._ft);
  if (!tk.fresh) return ctx.flash(tk.doc_id ? '/req/' + tk.doc_id : '/req/list', '这份表单刚才已提交过，未重复生成领料单');

  const docNo = nextDocNo('REQ', pid);
  const r = run(
    `INSERT INTO docs(doc_no,type,doc_date,project_id,major_id,team_id,status,remark,created_by,created_at)
     VALUES(?,?,?,?,?,?,'draft',?,?,?)`,
    docNo, 'REQ', today(), pid, mid, tid, String(b.remark || ''), ctx.user.id, now()
  );
  const docId = Number(r.lastInsertRowid);
  lines.forEach((l, i) => {
    run(
      `INSERT INTO doc_items(doc_id,seq,stock_item_id,plan_no,material_code,name,spec,tech_req,unit,qty)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      docId, i + 1, l.item.id, l.item.plan_no || '', l.item.material_code || '', l.item.name, l.item.spec || '', l.item.tech_req || '', l.item.unit, l.qty
    );
  });
  idem.bind(b._ft, docId);
  return ctx.flash('/req/' + docId, `已生成领料申请单 ${docNo}，提交后可打印`);
}

/* 了结剩余 = 放弃申请。管理员（doc.admin）与领料员（req.create）都能操作，
   且不限于该单的制单人；仓管员、只读无此权限。 */
const canCloseReq = (u) => can(u, 'doc.admin') || can(u, 'req.create');

function reqDetail(ctx, id) {
  const d = docOr404(ctx, id);
  if (!d) return;
  if (d.type !== 'REQ') return ctx.redirect('/doc/' + id);
  const items = all(
    `SELECT x.*,
      IFNULL((SELECT SUM(o.qty) FROM doc_items o JOIN docs od ON od.id=o.doc_id WHERE od.type='OUT' AND od.status!='void' AND od.source_doc_id=? AND o.stock_item_id=x.stock_item_id),0) AS out_qty,
      IFNULL((SELECT SUM(r2.qty) FROM doc_items r2 JOIN docs rd ON rd.id=r2.doc_id WHERE rd.type='RET' AND rd.source_doc_id=? AND r2.stock_item_id=x.stock_item_id),0) AS ret_qty,
      IFNULL((SELECT SUM(c.qty) FROM req_closures c WHERE c.doc_id=? AND c.stock_item_id=x.stock_item_id),0) AS closed_qty
     FROM doc_items x WHERE x.doc_id=? ORDER BY x.seq`,
    d.id, d.id, d.id, d.id
  );
  const closures = all(
    `SELECT c.*, u.name AS by_name, si.name AS item_name, si.unit
     FROM req_closures c
     LEFT JOIN users u ON u.id = c.user_id
     LEFT JOIN stock_items si ON si.id = c.stock_item_id
     WHERE c.doc_id = ? ORDER BY c.id DESC`,
    d.id
  );
  const lineLeft = (x) => Math.max(0, Number(x.qty) - Number(x.out_qty) - Number(x.closed_qty));
  const waitTotal = items.reduce((s, x) => s + lineLeft(x), 0);
  const waitLines = items.filter((x) => lineLeft(x) > 1e-9).length;
  const closable = (d.status === 'submitted' || d.status === 'part') && canCloseReq(ctx.user);
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <div class="doc-head">
      <div><small>制单编号</small><b>${U.esc(d.doc_no)}</b></div>
      <div><small>工程</small><b>${U.esc(d.project_name || '')}</b></div>
      <div><small>领料单位</small><b>${U.esc(d.team_name || '')}</b></div>
      <div><small>专业</small><b>${U.esc(d.major_name || '')}</b></div>
      <div><small>申请时间</small><b>${U.esc(d.created_at || '')}</b></div>
      <div><small>状态</small><b>${U.statusBadge(d.status)}</b></div>
    </div>
    ${
      waitLines
        ? `<p class="muted" style="color:#b26a00">本单还有 ${waitLines} 项待出库，合计 ${fmt(waitTotal)}。确实不再领的项，可逐项「放弃领用」；已出库部分不受影响。</p>`
        : ''
    }
    <div class="form-actions">
      ${d.status === 'draft' && can(ctx.user, 'req.create') ? `<form method="post" action="/req/${d.id}/submit"><button class="btn primary">提交申请</button></form>` : ''}
      ${can(ctx.user, 'req.print') ? `<a class="btn" href="/req/${d.id}/print" target="_blank">打印领料单</a>` : ''}
      ${closable && waitLines > 1 ? `<form method="post" action="/req/${d.id}/close-rest" onsubmit="return confirm('将放弃本单全部 ${waitLines} 项待出库数量（合计 ${fmt(waitTotal)}），确定？')"><button class="btn danger">全部放弃领用</button></form>` : ''}
      ${d.status !== 'draft' && can(ctx.user, 'doc.admin') ? `<form method="post" action="/req/${d.id}/withdraw" onsubmit="return confirm('撤回后重新变为保存状态，确定？')"><button class="btn danger">撤回</button></form>` : ''}
      <a class="btn" href="/req/list">返回列表</a>
    </div>
  </section>
  <section class="panel"><h2>明细</h2>
    ${U.table(
      [{ label: '序号' }, { label: '需求计划编号', width: '132px' }, { label: '物资名称' }, { label: '规格型号' }, { label: '技术要求' }, { label: '单位' }, { label: '申请数量', align: 'r' }, { label: '已出库', align: 'r' }, { label: '已退料', align: 'r' }, { label: '放弃领用', align: 'r' }, { label: '待出库', align: 'r' }, { label: '' }],
      items.map((i2) => {
        const left = lineLeft(i2);
        return [
          String(i2.seq), U.esc(i2.plan_no || ''), U.esc(i2.name), U.esc(i2.spec || ''), U.esc(i2.tech_req || ''), U.esc(i2.unit),
          fmt(i2.qty), fmt(i2.out_qty), fmt(i2.ret_qty),
          Number(i2.closed_qty) > 0 ? `<span class="muted">${fmt(i2.closed_qty)}</span>` : '0',
          `<b>${fmt(left)}</b>`,
          closable && left > 1e-9
            ? `<form method="post" action="/req/${d.id}/close-line" onsubmit="return confirm('确定放弃这一项待出的 ${fmt(left)} ${U.esc(i2.unit)}？放弃后不能再领，需要时须重新开单。')"><input type="hidden" name="item_id" value="${i2.stock_item_id}"><button class="mini danger">放弃领用</button></form>`
            : '',
        ];
      })
    )}
  </section>
  ${
    closures.length
      ? `<section class="panel"><h2>放弃领用记录（${closures.length}）</h2>
    ${U.table(
      [{ label: '时间' }, { label: '物资名称' }, { label: '放弃数量', align: 'r' }, { label: '操作人' }, { label: '' }],
      closures.map((c) => [
        U.esc(c.created_at || ''),
        U.esc(c.item_name || ''),
        fmt(c.qty) + ' ' + U.esc(c.unit || ''),
        U.esc(c.by_name || ''),
        canCloseReq(ctx.user)
          ? `<form method="post" action="/req/${d.id}/unclose" onsubmit="return confirm('撤销这条放弃领用记录？撤销后该数量恢复为待出库。')"><input type="hidden" name="closure_id" value="${c.id}"><button class="mini">撤销</button></form>`
          : '',
      ])
    )}
    <p class="muted">放弃领用只放弃「还没领的那部分」，已出库的数量不受影响，原始申请数量也不改动。</p>
  </section>`
      : ''
  }`;
  return page(ctx, '领料申请单', '/req/list', body);
}

/* 了结某一行剩余（放弃不领），不动原始申请数量 */
function reqCloseLine(ctx, id) {
  const d = one("SELECT * FROM docs WHERE id=? AND type='REQ'", id);
  if (!d) return err(ctx, '单据不存在', '/req/list');
  if (!canCloseReq(ctx.user)) return err(ctx, '只有管理员、二级管理员或领料员可以放弃领用', '/req/' + id);
  if (d.status !== 'submitted' && d.status !== 'part') return err(ctx, '只有已提交或部分出库的单据可以放弃领用', '/req/' + id);
  const itemId = Number(ctx.body.item_id || 0);
  const line = one('SELECT * FROM doc_items WHERE doc_id=? AND stock_item_id=?', id, itemId);
  if (!line) return err(ctx, '这项物资不在这张单里', '/req/' + id);
  const left = Number(line.qty) - Number(outedOf(id, itemId)) - Number(closedOf(id, itemId));
  if (left <= 1e-9) return err(ctx, '该项已无待出数量', '/req/' + id);
  run(
    'INSERT INTO req_closures(doc_id,stock_item_id,qty,reason,user_id,created_at) VALUES(?,?,?,?,?,?)',
    id, itemId, left, '放弃领用', ctx.user.id, now()
  );
  refreshReqStatus(id);
  return ctx.flash('/req/' + id, `已放弃领用「${line.name}」剩余 ${fmt(left)}${line.unit || ''}`);
}

/* 一次性了结本单所有还没领完的行 */
function reqCloseRest(ctx, id) {
  const d = one("SELECT * FROM docs WHERE id=? AND type='REQ'", id);
  if (!d) return err(ctx, '单据不存在', '/req/list');
  if (!canCloseReq(ctx.user)) return err(ctx, '只有管理员、二级管理员或领料员可以放弃领用', '/req/' + id);
  if (d.status !== 'submitted' && d.status !== 'part') return err(ctx, '只有已提交或部分出库的单据可以放弃领用', '/req/' + id);
  const lines = all('SELECT * FROM doc_items WHERE doc_id=?', id);
  let n = 0;
  let total = 0;
  for (const l of lines) {
    const left = Number(l.qty) - Number(outedOf(id, l.stock_item_id)) - Number(closedOf(id, l.stock_item_id));
    if (left <= 1e-9) continue;
    run(
      'INSERT INTO req_closures(doc_id,stock_item_id,qty,reason,user_id,created_at) VALUES(?,?,?,?,?,?)',
      id, l.stock_item_id, left, '全部放弃领用', ctx.user.id, now()
    );
    n++;
    total += left;
  }
  if (!n) return err(ctx, '本单没有待出库的数量了', '/req/' + id);
  refreshReqStatus(id);
  return ctx.flash('/req/' + id, `已放弃领用 ${n} 项，合计 ${fmt(total)}`);
}

/* 撤销一条了结记录（点错了 / 对方又要了） */
function reqUnclose(ctx, id) {
  if (!canCloseReq(ctx.user)) return err(ctx, '只有管理员、二级管理员或领料员可以撤销放弃领用', '/req/' + id);
  const cid = Number(ctx.body.closure_id || 0);
  const c = one('SELECT * FROM req_closures WHERE id=? AND doc_id=?', cid, id);
  if (!c) return err(ctx, '放弃领用记录不存在', '/req/' + id);
  run('DELETE FROM req_closures WHERE id=?', cid);
  refreshReqStatus(id);
  return ctx.flash('/req/' + id, '已撤销该条放弃领用，数量恢复为待出库');
}

function reqSubmit(ctx, id) {
  const d = one("SELECT * FROM docs WHERE id=? AND type='REQ'", id);
  if (!d) return err(ctx, '单据不存在', '/req/list');
  if (d.status !== 'draft') return err(ctx, '单据已提交', '/req/' + id);
  if (!can(ctx.user, 'req.create')) return err(ctx, '没有提交权限', '/req/' + id);
  run("UPDATE docs SET status='submitted', submitted_at=? WHERE id=?", now(), id);
  return ctx.flash('/req/' + id, '已提交，可打印后交仓库出库');
}

function reqWithdraw(ctx, id) {
  const d = one("SELECT * FROM docs WHERE id=? AND type='REQ'", id);
  if (!d) return err(ctx, '单据不存在', '/req/list');
  if (!can(ctx.user, 'doc.admin')) return err(ctx, '你没有撤改已提交单据的权限', '/req/' + id);
  const used = one("SELECT COUNT(*) n FROM docs WHERE type IN ('OUT','RET') AND source_doc_id=?", id).n;
  if (used > 0) return err(ctx, '已有出库或退料记录，不能撤回', '/req/' + id);
  run("UPDATE docs SET status='draft', modified_by=?, modified_at=? WHERE id=?", ctx.user.id, now(), id);
  return ctx.flash('/req/' + id, '已撤回为保存状态');
}

function reqPrint(ctx, id) {
  const d = docOr404(ctx, id);
  if (!d) return;
  const items = docItems(d.id);
  const pdfJson = JSON.stringify({
    filename: `${d.doc_no}-领料申请单.pdf`,
    title: `${d.project_name || ''}领料申请单`,
    sub: `制单编号：${d.doc_no || ''}`,
    meta: [
      ['工程名称', d.project_name || ''],
      ['领料单位', d.team_name || ''],
      ['申请时间', d.doc_date || ''],
      ['专业', d.major_name || ''],
      ['制单人', d.maker || ''],
    ],
    columns: [
      ['序号', 0.07, 'center'], ['物资名称', 0.27, 'left'], ['规格型号', 0.25, 'left'],
      ['单位', 0.08, 'center'], ['数量', 0.10, 'right'], ['实发数量', 0.11, 'right'], ['备注', 0.12, 'left'],
    ],
    rows: items.map((it, n) => [String(n + 1), it.name || '', it.spec || '', it.unit || '', fmt(it.qty), '', '']),
    blanks: Math.max(0, 8 - items.length),
    remark: d.remark || '',
    signs: ['制单', '审核', '领料', '发料'],
  }).replace(/</g, '\\u003c');
  const rows = items
    .map(
      (i2, n) => `<tr><td>${n + 1}</td><td>${U.esc(i2.name)}</td><td>${U.esc(i2.spec || '')}</td><td>${U.esc(i2.unit)}</td>
      <td class="r">${fmt(i2.qty)}</td><td></td><td></td></tr>`
    )
    .join('');
  const blank = Array.from({ length: Math.max(0, 8 - items.length) })
    .map(() => '<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>')
    .join('');
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${U.esc(d.doc_no)} 领料申请单</title>
<style>
  @page{size:A4 portrait;margin:18mm 14mm}
  body{font:13px/1.6 "Microsoft YaHei",SimSun,sans-serif;color:#000;margin:0}
  h1{text-align:center;font-size:20px;letter-spacing:2px;margin:0 0 4px}
  .sub{text-align:center;font-size:12px;color:#333;margin-bottom:10px}
  .meta{display:flex;flex-wrap:wrap;gap:4px 26px;font-size:12.5px;margin:8px 0 6px}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  th,td{border:1px solid #000;padding:4px 5px;font-size:12px}
  th{background:#f2f2f2;font-weight:600}
  .r{text-align:right}
  .sign{display:flex;justify-content:space-between;margin-top:26px;font-size:13px}
  .sign div{width:23%}
  .sign span{display:inline-block;border-bottom:1px solid #000;width:110px}
  .tb{margin:0 0 10px;font-size:12px;color:#555}
  @media print{.tb{display:none}}
</style></head><body>
<div class="tb">
  <button type="button" class="pdf-btn" onclick="wmsExportPdf()">导出 PDF</button>
  <span>有打印机可按 Ctrl+P 直接打印；没有打印机就点「导出 PDF」存成文件。此提示不会打印在纸上。</span>
</div>
<h1>${U.esc(d.project_name || '')} 领料申请单</h1>
<div class="sub">制单编号：${U.esc(d.doc_no)}</div>
<div class="meta">
  <div>工程名称：<b>${U.esc(d.project_name || '')}</b></div>
  <div>领料单位：<b>${U.esc(d.team_name || '')}</b></div>
  <div>申请时间：<b>${U.esc(d.doc_date || '')}</b></div>
  <div>专业：<b>${U.esc(d.major_name || '')}</b></div>
  <div>制单人：<b>${U.esc(d.maker || '')}</b></div>
</div>
<table>
  <thead><tr><th style="width:6%">序号</th><th style="width:28%">物资名称</th><th style="width:26%">规格型号</th><th style="width:8%">单位</th><th style="width:10%">数量</th><th style="width:11%">实发数量</th><th style="width:11%">备注</th></tr></thead>
  <tbody>${rows}${blank}</tbody>
</table>
${d.remark ? `<div style="margin-top:8px;font-size:12.5px">备注：${U.esc(d.remark)}</div>` : ''}
<div class="sign"><div>制单：<span></span></div><div>审核：<span></span></div><div>领料：<span></span></div><div>发料：<span></span></div></div>
<script type="application/json" id="pdf-data">${pdfJson}</script>
<script src="/printpdf.js"></script>
</body></html>`;
  return ctx.html(html);
}

function reqList(ctx) {
  const pid = Number(q1(ctx.query.project) || 0);
  const tid = Number(q1(ctx.query.team) || 0);
  const from = q1(ctx.query.from) || '';
  const to = q1(ctx.query.to) || '';
  const no = String(q1(ctx.query.no) || '').trim();
  const maker = String(q1(ctx.query.maker) || '').trim();
  const q = String(q1(ctx.query.q) || '').trim();
  const status = String(q1(ctx.query.status) || '').trim();
  const pids = projectsOf(ctx).map((p) => p.id);
  if (!pids.length) return page(ctx, '领用查询', '/req/list', '<section class="panel">你还没有被分配到任何工程。</section>');
  const where = [`d.type='REQ'`, `d.project_id IN (${pids.join(',')})`];
  const args = [];
  if (pid) { where.push('d.project_id=?'); args.push(pid); }
  if (tid) { where.push('d.team_id=?'); args.push(tid); }
  if (status) { where.push('d.status=?'); args.push(status); }
  if (from) { where.push('d.doc_date>=?'); args.push(from); }
  if (to) { where.push('d.doc_date<=?'); args.push(to); }
  if (no) { where.push('d.doc_no LIKE ?'); args.push(`%${no}%`); }
  if (maker) { where.push('u.name LIKE ?'); args.push(`%${maker}%`); }
  if (q) {
    where.push(`(d.remark LIKE ? OR d.doc_no LIKE ? OR ${docsItemMatch('d')})`);
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = all(
    `SELECT d.*, p.name AS project_name, m.name AS major_name, t.name AS team_name, u.name AS maker_name,
            (SELECT IFNULL(SUM(x.qty),0) FROM doc_items x WHERE x.doc_id=d.id) AS qty,
            (SELECT COUNT(*) FROM doc_items x WHERE x.doc_id=d.id) AS n,
            (SELECT IFNULL(SUM(CASE WHEN x.qty - IFNULL(c.cq,0) - IFNULL(o.oq,0) > 0
                                    THEN x.qty - IFNULL(c.cq,0) - IFNULL(o.oq,0) ELSE 0 END),0)
               FROM doc_items x
               LEFT JOIN (SELECT doc_id, stock_item_id, SUM(qty) cq FROM req_closures GROUP BY doc_id, stock_item_id) c
                 ON c.doc_id = x.doc_id AND c.stock_item_id = x.stock_item_id
               LEFT JOIN (SELECT od.source_doc_id sid, o.stock_item_id iid, SUM(o.qty) oq
                          FROM doc_items o JOIN docs od ON od.id = o.doc_id
                          WHERE od.type='OUT' AND od.status!='void' AND od.source_doc_id IS NOT NULL
                          GROUP BY od.source_doc_id, o.stock_item_id) o
                 ON o.sid = x.doc_id AND o.iid = x.stock_item_id
               WHERE x.doc_id = d.id) AS wait_qty
     FROM docs d LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN majors m ON m.id=d.major_id
     LEFT JOIN teams t ON t.id=d.team_id LEFT JOIN users u ON u.id=d.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY ${status === 'part' ? 'wait_qty DESC, d.id DESC' : 'd.id DESC'} LIMIT 300`,
    ...args
  );
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <form class="toolbar" method="get" action="/req/list">
      ${U.select('project', projectsOf(ctx).map((p) => ({ value: p.id, label: p.name })), pid, { placeholder: '全部工程' })}
      ${U.select('team', teamsOf().map((t) => ({ value: t.id, label: t.name })), tid, { placeholder: '全部领料单位' })}
      <input type="date" name="from" value="${U.esc(from)}"> <span class="muted">至</span> <input type="date" name="to" value="${U.esc(to)}">
      <input name="no" value="${U.esc(no)}" placeholder="制单编号">
      <input name="maker" value="${U.esc(maker)}" placeholder="制单人">
      <input name="q" value="${U.esc(q)}" placeholder="物资 / 规格 / 计划编号 / 备注">
      <button class="btn">查询</button>
      <button class="btn ${status === 'part' ? 'primary' : 'ghost'}" type="submit" name="status" value="${status === 'part' ? '' : 'part'}">部分出库</button>
      ${can(ctx.user, 'export.xlsx') ? `<a class="btn ghost" href="/export?kind=req&project=${pid}&team=${tid}&from=${from}&to=${to}&no=${encodeURIComponent(no)}&maker=${encodeURIComponent(maker)}&q=${encodeURIComponent(q)}">导出 Excel</a>` : ''}
    </form>
  </section>
  <section class="panel">${U.table(
    [{ label: '制单编号' }, { label: '工程' }, { label: '领料单位' }, { label: '专业' }, { label: '申请日期' }, { label: '行数', align: 'r' }, { label: '数量合计', align: 'r' }, { label: '制单人' }, { label: '状态' }, { label: '待出库', align: 'r' }, { label: '' }],
    rows.map((d) => [
      `<a href="/req/${d.id}">${U.esc(d.doc_no)}</a>`,
      U.esc(d.project_name || ''), U.esc(d.team_name || ''), U.esc(d.major_name || ''),
      U.esc(d.doc_date || ''), String(d.n), fmt(d.qty), U.esc(d.maker_name || ''),
      U.statusBadge(d.status),
      Number(d.wait_qty) > 1e-9 ? `<span class="warn-num">${fmt(d.wait_qty)}</span>` : '<span class="muted">0</span>',
      `<a class="mini" href="/req/${d.id}">查看</a>${can(ctx.user, 'req.print') ? ` <a class="mini" href="/req/${d.id}/print" target="_blank">打印</a>` : ''}`,
    ]),
    { empty: status === 'part' ? '没有部分出库的单据，很干净' : '没有符合条件的领料单' }
  )}</section>`;
  return page(ctx, '领用查询', '/req/list', body);
}

/* ============ 领用明细（按物资行展开，可筛未出库） ============ */
const REQ_ITEMS_WHERE = (scopeIds) => [`d.type='REQ'`, `d.status != 'void'`, `d.project_id IN (${scopeIds.join(',')})`];

function reqItemsFilters(ctx) {
  return {
    pid: Number(q1(ctx.query.project) || 0),
    mid: Number(q1(ctx.query.major) || 0),
    tid: Number(q1(ctx.query.team) || 0),
    maker: String(q1(ctx.query.maker) || '').trim(),
    from: q1(ctx.query.from) || '',
    to: q1(ctx.query.to) || '',
    open: q1(ctx.query.open) === '1',
    q: String(q1(ctx.query.q) || '').trim(),
  };
}

function reqItemsQuery(f, scopeIds, withStatus) {
  const where = REQ_ITEMS_WHERE(scopeIds);
  const args = [];
  if (f.pid) { where.push('d.project_id=?'); args.push(f.pid); }
  if (f.mid) { where.push('d.major_id=?'); args.push(f.mid); }
  if (f.tid) { where.push('d.team_id=?'); args.push(f.tid); }
  if (f.maker) { where.push('u.name LIKE ?'); args.push(`%${f.maker}%`); }
  if (f.from) { where.push('d.doc_date>=?'); args.push(f.from); }
  if (f.to) { where.push('d.doc_date<=?'); args.push(f.to); }
  if (f.q) {
    where.push('(x.name LIKE ? OR x.spec LIKE ? OR x.plan_no LIKE ? OR x.material_code LIKE ? OR d.doc_no LIKE ?)');
    args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  if (f.open) {
    where.push(`x.qty - IFNULL((SELECT SUM(c.qty) FROM req_closures c
        WHERE c.doc_id=d.id AND c.stock_item_id=x.stock_item_id),0)
      > IFNULL((SELECT SUM(o.qty) FROM doc_items o JOIN docs od ON od.id=o.doc_id
        WHERE od.type='OUT' AND od.status!='void' AND od.source_doc_id=d.id AND o.stock_item_id=x.stock_item_id),0) + 1e-9`);
  }
  const rows = all(
    `SELECT d.id AS req_id, d.doc_no, d.doc_date, d.status,
            p.name AS project_name, m.name AS major_name, t.name AS team_name, u.name AS maker,
            x.plan_no, x.name, x.spec, x.unit, x.qty,
            IFNULL((SELECT SUM(o.qty) FROM doc_items o JOIN docs od ON od.id=o.doc_id
              WHERE od.type='OUT' AND od.status!='void' AND od.source_doc_id=d.id AND o.stock_item_id=x.stock_item_id),0) AS out_qty,
            IFNULL((SELECT SUM(c.qty) FROM req_closures c
              WHERE c.doc_id=d.id AND c.stock_item_id=x.stock_item_id),0) AS closed_qty
     FROM doc_items x
     JOIN docs d ON d.id = x.doc_id
     LEFT JOIN projects p ON p.id = d.project_id
     LEFT JOIN majors m ON m.id = d.major_id
     LEFT JOIN teams t ON t.id = d.team_id
     LEFT JOIN users u ON u.id = d.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY d.doc_date DESC, d.id DESC, x.seq
     LIMIT 800`,
    ...args
  ).map((r2) => ({ ...r2, left: Math.max(0, Number(r2.qty) - Number(r2.out_qty) - Number(r2.closed_qty)), status_name: withStatus ? (STATUS[r2.status] || {}).name || r2.status : undefined }));
  return rows;
}

function reqItemsPage(ctx) {
  const f = reqItemsFilters(ctx);
  const pids = projectsOf(ctx).map((p) => p.id);
  if (!pids.length) return page(ctx, '领用明细', '/req/items', '<section class="panel">你还没有被分配到任何工程。</section>');
  const rows = reqItemsQuery(f, pids, true);
  const pendingSum = rows.reduce((s2, r2) => s2 + r2.left, 0);
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <form class="toolbar" method="get" action="/req/items">
      ${projSelect(ctx, 'project', f.pid, { placeholder: '全部工程' })}
      ${majorSelect('major', f.mid, { placeholder: '全部专业' })}
      ${teamSelect('team', f.tid, { placeholder: '全部施工队伍' })}
      <input name="maker" value="${U.esc(f.maker)}" placeholder="制单人" style="width:110px">
      <label class="inl"><input type="date" name="from" value="${U.esc(f.from)}"> 至 <input type="date" name="to" value="${U.esc(f.to)}"></label>
      <label class="inl"><input type="checkbox" name="open" value="1"${f.open ? ' checked' : ''}> 未出库</label>
      <input name="q" value="${U.esc(f.q)}" placeholder="物资 / 规格 / 计划编号 / 领料单号">
      <button class="btn">查询</button>
      ${can(ctx.user, 'export.xlsx') ? `<a class="btn ghost" href="/export?kind=req_items&project=${f.pid}&major=${f.mid}&team=${f.tid}&maker=${encodeURIComponent(f.maker)}&from=${f.from}&to=${f.to}&open=${f.open ? 1 : 0}&q=${encodeURIComponent(f.q)}">导出 Excel</a>` : ''}
    </form>
    <p class="muted">把所有领料申请单按物资逐行展开；勾选「未出库」只看还没出（或没出完）的行。出库数量按领料单汇总。</p>
  </section>
  <section class="panel">${U.table(
    [
      { label: '领料单号' }, { label: '申请日期' }, { label: '项目' }, { label: '需求计划编号' },
      { label: '物资名称' }, { label: '规格型号' }, { label: '单位' },
      { label: '数量', align: 'r' }, { label: '出库数量', align: 'r' }, { label: '放弃领用', align: 'r' }, { label: '待出库', align: 'r' }, { label: '制单人' },
    ],
    rows.map((r2) => [
      `<a href="/req/${r2.req_id}">${U.esc(r2.doc_no)}</a>`,
      U.esc(r2.doc_date || ''),
      U.esc(r2.project_name || ''),
      U.esc(r2.plan_no || ''),
      U.esc(r2.name),
      U.esc(r2.spec || ''),
      U.esc(r2.unit),
      fmt(r2.qty),
      fmt(r2.out_qty),
      Number(r2.closed_qty) > 0 ? `<span class="muted">${fmt(r2.closed_qty)}</span>` : fmt(0),
      r2.left > 1e-9 ? `<b>${fmt(r2.left)}</b>` : fmt(0),
      U.esc(r2.maker || ''),
    ]),
    { empty: '没有符合条件的领用明细' }
  )}
  ${rows.length ? `<p class="hint" style="padding:10px 14px">共 ${rows.length} 行，待出库合计 ${fmt(pendingSum)}。</p>` : ''}</section>`;
  return page(ctx, '领用明细', '/req/items', body);
}

/* ---------- 出库 / 退库明细（把单据按物资行展开，筛选口径与领用明细一致） ---------- */
function outRetFilters(ctx) {
  return {
    pid: Number(q1(ctx.query.project) || 0),
    mid: Number(q1(ctx.query.major) || 0),
    tid: Number(q1(ctx.query.team) || 0),
    who: String(q1(ctx.query.who) || '').trim(),
    from: q1(ctx.query.from) || '',
    to: q1(ctx.query.to) || '',
    q: String(q1(ctx.query.q) || '').trim(),
  };
}

function outRetItemsQuery(type, f, pids) {
  const where = ['d.type=?', `d.project_id IN (${pids.join(',')})`];
  const args = [type];
  if (f.pid) { where.push('d.project_id=?'); args.push(f.pid); }
  if (f.mid) { where.push('d.major_id=?'); args.push(f.mid); }
  if (f.tid) { where.push('d.team_id=?'); args.push(f.tid); }
  if (f.who) { where.push('u.name LIKE ?'); args.push(`%${f.who}%`); }
  if (f.from) { where.push('d.doc_date>=?'); args.push(f.from); }
  if (f.to) { where.push('d.doc_date<=?'); args.push(f.to); }
  if (f.q) {
    where.push('(d.doc_no LIKE ? OR s.doc_no LIKE ? OR x.name LIKE ? OR x.spec LIKE ? OR x.plan_no LIKE ? OR x.material_code LIKE ?)');
    args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  return all(
    `SELECT d.id AS doc_id, d.doc_no, d.doc_date, s.id AS req_id, s.doc_no AS req_no, s.doc_date AS req_date,
            p.name AS project_name, m.name AS major_name, t.name AS team_name,
            u.name AS who, requ.name AS req_maker,
            x.plan_no, x.name, x.spec, x.unit, x.qty, x.seq
     FROM docs d
     JOIN doc_items x ON x.doc_id = d.id
     LEFT JOIN docs s ON s.id = d.source_doc_id
     LEFT JOIN users requ ON requ.id = s.created_by
     LEFT JOIN projects p ON p.id = d.project_id
     LEFT JOIN majors m ON m.id = d.major_id
     LEFT JOIN teams t ON t.id = d.team_id
     LEFT JOIN users u ON u.id = d.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY d.doc_date DESC, d.id DESC, x.seq
     LIMIT 800`,
    ...args
  );
}

function outRetItemsPage(ctx, type, o) {
  const f = outRetFilters(ctx);
  const pids = projectsOf(ctx).map((p) => p.id);
  if (!pids.length) return page(ctx, o.title, o.active, '<section class="panel">你还没有被分配到任何工程。</section>');
  const rows = outRetItemsQuery(type, f, pids);
  const link =
    `/export?kind=${o.exportKind}&project=${f.pid}&major=${f.mid}&team=${f.tid}` +
    `&who=${encodeURIComponent(f.who)}&from=${f.from}&to=${f.to}&q=${encodeURIComponent(f.q)}`;
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <form class="toolbar" method="get" action="${o.active}">
      ${projSelect(ctx, 'project', f.pid, { placeholder: '全部工程' })}
      ${majorSelect('major', f.mid, { placeholder: '全部专业' })}
      ${teamSelect('team', f.tid, { placeholder: '全部施工队伍' })}
      <input name="who" value="${U.esc(f.who)}" placeholder="${o.whoLabel}" style="width:110px">
      <label class="inl"><input type="date" name="from" value="${U.esc(f.from)}"> 至 <input type="date" name="to" value="${U.esc(f.to)}"></label>
      <input name="q" value="${U.esc(f.q)}" placeholder="物资 / 规格 / 计划编号 / 单号">
      <button class="btn">查询</button>
      ${can(ctx.user, 'export.xlsx') ? `<a class="btn ghost" href="${link}">导出 Excel</a>` : ''}
    </form>
    <p class="muted">把所有${o.docName}按物资逐行展开；可组合工程、专业、队伍、${o.whoLabel}、日期区间和关键字筛选。</p>
  </section>
  <section class="panel">${U.table(
    [
      { label: o.docCol }, { label: o.dateCol }, { label: '工程' }, { label: '专业' }, { label: '领料单位' },
      { label: '需求计划编号' }, { label: '物资名称' }, { label: '规格型号' }, { label: '单位' },
      { label: '数量', align: 'r' }, { label: '领料单号' }, { label: o.whoLabel },
    ],
    rows.map((r2) => [
      `<a href="/doc/${r2.doc_id}">${U.esc(r2.doc_no)}</a>`,
      U.esc(r2.doc_date || ''),
      U.esc(r2.project_name || ''),
      U.esc(r2.major_name || ''),
      U.esc(r2.team_name || ''),
      U.esc(r2.plan_no || ''),
      U.esc(r2.name || ''),
      U.esc(r2.spec || ''),
      U.esc(r2.unit || ''),
      fmt(r2.qty),
      r2.req_id ? `<a href="/req/${r2.req_id}">${U.esc(r2.req_no)}</a>` : '',
      U.esc(r2.who || ''),
    ]),
    { empty: `没有符合条件的${o.title}` }
  )}
  ${rows.length ? `<p class="hint" style="padding:10px 14px">共 ${rows.length} 行。</p>` : ''}</section>`;
  return page(ctx, o.title, o.active, body);
}

function outItemsPage(ctx) {
  return outRetItemsPage(ctx, 'OUT', {
    title: '出库明细',
    active: '/out/items',
    docName: '出库单',
    docCol: '出库单号',
    dateCol: '出库日期',
    whoLabel: '出库人',
    exportKind: 'out',
  });
}

function retItemsPage(ctx) {
  return outRetItemsPage(ctx, 'RET', {
    title: '退库明细',
    active: '/ret/items',
    docName: '退料单',
    docCol: '退料单号',
    dateCol: '退库日期',
    whoLabel: '退库人',
    exportKind: 'ret',
  });
}

/* ============ 出库 ============ */
function outNewPage(ctx) {
  const q = String(q1(ctx.query.q) || '').trim();
  const pids = projectsOf(ctx).map((p) => p.id);
  if (!pids.length) return page(ctx, '出库登记', '/out/new', '<section class="panel">你还没有被分配到任何工程。</section>');
  const args = [];
  let extra = '';
  if (q) {
    extra = ` AND (d.doc_no LIKE ? OR p.name LIKE ? OR t.name LIKE ? OR ${docsItemMatch('d')})`;
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = all(
    `SELECT d.*, p.name AS project_name, t.name AS team_name, m.name AS major_name,
            (SELECT COUNT(*) FROM doc_items x WHERE x.doc_id=d.id) AS n,
            (SELECT IFNULL(SUM(x.qty),0) FROM doc_items x WHERE x.doc_id=d.id) AS qty
     FROM docs d LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN teams t ON t.id=d.team_id
     LEFT JOIN majors m ON m.id=d.major_id
     WHERE d.type='REQ' AND d.status IN ('submitted','part') AND d.project_id IN (${pids.join(',')})${extra}
     ORDER BY d.id DESC LIMIT 200`,
    ...args
  );
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <h2>出库登记</h2>
    <form class="toolbar" method="get" action="/out/new">
      <input name="q" value="${U.esc(q)}" placeholder="领料单号 / 物资 / 规格 / 计划编号" style="min-width:260px">
      <button class="btn">搜索</button>
    </form>
    <p class="muted">出库必须凭领料申请单。点"去出库"进入该单，勾选物资并填写本次实发数量。</p>
  </section>
  <section class="panel">${U.table(
    [{ label: '领料单号' }, { label: '工程' }, { label: '领料单位' }, { label: '专业' }, { label: '申请日期' }, { label: '行数', align: 'r' }, { label: '申请数量', align: 'r' }, { label: '状态' }, { label: '' }],
    rows.map((d) => [
      U.esc(d.doc_no), U.esc(d.project_name || ''), U.esc(d.team_name || ''), U.esc(d.major_name || ''),
      U.esc(d.doc_date || ''), String(d.n), fmt(d.qty), U.statusBadge(d.status),
      `<a class="btn mini primary" href="/out/${d.id}">去出库</a>`,
    ]),
    { empty: '没有待出库的领料单' }
  )}</section>`;
  return page(ctx, '出库登记', '/out/new', body);
}

function outPickPage(ctx, reqId) {
  const d = docOr404(ctx, reqId);
  if (!d) return;
  if (d.type !== 'REQ') return ctx.redirect('/out/new');
  if (!['submitted', 'part'].includes(d.status)) return err(ctx, '该领料单当前不可出库', '/out/new');
  const items = all(
    `SELECT x.*,
      IFNULL((SELECT SUM(o.qty) FROM doc_items o JOIN docs od ON od.id=o.doc_id WHERE od.type='OUT' AND od.status!='void' AND od.source_doc_id=? AND o.stock_item_id=x.stock_item_id),0) AS out_qty,
      IFNULL((SELECT SUM(c.qty) FROM req_closures c WHERE c.doc_id=? AND c.stock_item_id=x.stock_item_id),0) AS closed_qty
     FROM doc_items x WHERE x.doc_id=? ORDER BY x.seq`,
    d.id, d.id, d.id
  );
  const lines = items
    .map((i2) => ({ ...i2, left: i2.qty - i2.out_qty - i2.closed_qty, stock: i2.stock_item_id ? balanceOf(i2.stock_item_id) : 0 }))
    .filter((i2) => i2.left > 1e-9);
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <div class="doc-head">
      <div><small>领料单号</small><b>${U.esc(d.doc_no)}</b></div>
      <div><small>工程</small><b>${U.esc(d.project_name || '')}</b></div>
      <div><small>领料单位</small><b>${U.esc(d.team_name || '')}</b></div>
      <div><small>专业</small><b>${U.esc(d.major_name || '')}</b></div>
      <div><small>状态</small><b>${U.statusBadge(d.status)}</b></div>
    </div>
    <form method="post" action="/out/save">
      <input type="hidden" name="req_id" value="${d.id}">
      <input type="hidden" name="_ft" value="${idem.issue()}">
      ${U.table(
        [{ label: '勾选' }, { label: '物资名称' }, { label: '规格型号' }, { label: '单位' }, { label: '申请', align: 'r' }, { label: '已出', align: 'r' }, { label: '待出', align: 'r' }, { label: '结存', align: 'r' }, { label: '本次出库', align: 'r' }],
        lines.map((i2) => [
          `<input type="checkbox" name="pick" value="${i2.id}">`,
          U.esc(i2.name), U.esc(i2.spec || ''), U.esc(i2.unit),
          fmt(i2.qty), fmt(i2.out_qty), fmt(i2.left), fmt(i2.stock),
          `<input class="qty" type="number" step="0.001" min="0" max="${i2.left}" name="qty_${i2.id}" placeholder="${fmt(i2.left)}">`,
        ]),
        { empty: '该单已全部出库' }
      )}
      <div class="form-actions">
        <label class="field"><span>备注</span><input name="remark" placeholder="可不填"></label>
        <button class="btn primary"${lines.length ? '' : ' disabled'}>确认出库</button>
        <a class="btn" href="/out/new">返回</a>
      </div>
    </form>
  </section>`;
  return page(ctx, '出库', '/out/new', body);
}

function outSave(ctx) {
  const b = ctx.body;
  const reqId = Number(b.req_id || 0);
  const d = one("SELECT * FROM docs WHERE id=? AND type='REQ'", reqId);
  if (!d) return err(ctx, '领料单不存在', '/out/new');
  const picks = arr(b.pick).map(Number).filter(Boolean);
  if (!picks.length) return err(ctx, '请勾选要出库的物资', '/out/' + reqId);

  const rows = [];
  const problems = [];
  for (const id of picks) {
    const line = one('SELECT * FROM doc_items WHERE id=? AND doc_id=?', id, reqId);
    if (!line) continue;
    const already = Number(outedOf(reqId, line.stock_item_id));
    const closed = Number(closedOf(reqId, line.stock_item_id));
    const left = Number(line.qty) - already - closed;
    const qty = toNum(b['qty_' + id]) || left;
    if (qty <= 0) { problems.push(`「${line.name}」出库数量必须大于 0`); continue; }
    if (qty > left + 1e-9) { problems.push(`「${line.name}」待出 ${fmt(left)}，本次填了 ${fmt(qty)}`); continue; }
    const bal = balanceOf(line.stock_item_id);
    if (qty > Number(bal) + 1e-9) { problems.push(`「${line.name}」库存只有 ${fmt(bal)}，不足 ${fmt(qty)}`); continue; }
    rows.push({ line, qty });
  }
  if (!rows.length) return err(ctx, problems[0] || '没有有效行', '/out/' + reqId);
  if (problems.length) return err(ctx, problems.join('；'), '/out/' + reqId);

  // 表单令牌：同一份出库表单只允许生成一张出库单（防双击 / 网络重试）
  const tk = idem.claim(b._ft);
  if (!tk.fresh) return ctx.flash(tk.doc_id ? '/doc/' + tk.doc_id : '/req/' + reqId, '这份出库表单刚才已提交过，未重复出库');

  const docNo = nextDocNo('OUT', d.project_id);
  const r = run(
    `INSERT INTO docs(doc_no,type,doc_date,project_id,major_id,team_id,status,source_doc_id,remark,created_by,created_at,submitted_at)
     VALUES(?,?,?,?,?,?,'submitted',?,?,?,?,?)`,
    docNo, 'OUT', today(), d.project_id, d.major_id, d.team_id, reqId, String(b.remark || ''), ctx.user.id, now(), now()
  );
  const docId = Number(r.lastInsertRowid);
  const t = now();
  rows.forEach((x, i) => {
    run(
      `INSERT INTO doc_items(doc_id,seq,stock_item_id,plan_no,material_code,name,spec,tech_req,unit,qty)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      docId, i + 1, x.line.stock_item_id, x.line.plan_no || '', x.line.material_code || '', x.line.name, x.line.spec || '', x.line.tech_req || '', x.line.unit, x.qty
    );
    run(
      'INSERT INTO stock_moves(item_id,doc_id,doc_type,qty,doc_date,user_id,created_at) VALUES(?,?,?,?,?,?,?)',
      x.line.stock_item_id, docId, 'OUT', -Math.abs(x.qty), today(), ctx.user.id, t
    );
  });
  idem.bind(b._ft, docId);
  refreshReqStatus(reqId);
  return ctx.flash('/req/' + reqId, `出库完成，单号 ${docNo}`);
}

function refreshReqStatus(reqId) {
  const lines = all('SELECT * FROM doc_items WHERE doc_id=?', reqId);
  let left = 0;
  let out = 0;
  for (const l of lines) {
    const o = outedOf(reqId, l.stock_item_id);
    const c = closedOf(reqId, l.stock_item_id);
    out += o;
    left += Math.max(0, l.qty - o - c);
  }
  if (left <= 1e-9) run("UPDATE docs SET status='closed' WHERE id=? AND type='REQ'", reqId);
  else if (out > 1e-9) run("UPDATE docs SET status='part' WHERE id=? AND type='REQ'", reqId);
  else run("UPDATE docs SET status='submitted' WHERE id=? AND type='REQ'", reqId);
}

function outList(ctx) {
  const pid = Number(q1(ctx.query.project) || 0);
  const tid = Number(q1(ctx.query.team) || 0);
  const from = q1(ctx.query.from) || '';
  const to = q1(ctx.query.to) || '';
  const who = String(q1(ctx.query.who) || '').trim();
  const q = String(q1(ctx.query.q) || '').trim();
  const pids = projectsOf(ctx).map((p) => p.id);
  if (!pids.length) return page(ctx, '出库查询', '/out/list', '<section class="panel">你还没有被分配到任何工程。</section>');
  const where = [`d.type='OUT'`, `d.project_id IN (${pids.join(',')})`];
  const args = [];
  if (pid) { where.push('d.project_id=?'); args.push(pid); }
  if (tid) { where.push('d.team_id=?'); args.push(tid); }
  if (from) { where.push('d.doc_date>=?'); args.push(from); }
  if (to) { where.push('d.doc_date<=?'); args.push(to); }
  if (who) { where.push('u.name LIKE ?'); args.push(`%${who}%`); }
  if (q) {
    where.push(`(d.doc_no LIKE ? OR s.doc_no LIKE ? OR ${docsItemMatch('d')})`);
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = all(
    `SELECT d.*, p.name AS project_name, t.name AS team_name, u.name AS out_by, s.doc_no AS req_no, s.doc_date AS req_date,
            (SELECT IFNULL(SUM(x.qty),0) FROM doc_items x WHERE x.doc_id=d.id) AS qty,
            (SELECT COUNT(*) FROM doc_items x WHERE x.doc_id=d.id) AS n
     FROM docs d LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN teams t ON t.id=d.team_id
     LEFT JOIN users u ON u.id=d.created_by LEFT JOIN docs s ON s.id=d.source_doc_id
     WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 300`,
    ...args
  );
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <form class="toolbar" method="get" action="/out/list">
      ${U.select('project', projectsOf(ctx).map((p) => ({ value: p.id, label: p.name })), pid, { placeholder: '全部工程' })}
      ${U.select('team', teamsOf().map((t) => ({ value: t.id, label: t.name })), tid, { placeholder: '全部领料单位' })}
      <input type="date" name="from" value="${U.esc(from)}"> <span class="muted">至</span> <input type="date" name="to" value="${U.esc(to)}">
      <input name="who" value="${U.esc(who)}" placeholder="出库人">
      <input name="q" value="${U.esc(q)}" placeholder="单号 / 物资 / 规格 / 计划编号">
      <button class="btn">查询</button>
      ${can(ctx.user, 'export.xlsx') ? `<a class="btn ghost" href="/export?kind=out&project=${pid}&team=${tid}&from=${from}&to=${to}&who=${encodeURIComponent(who)}&q=${encodeURIComponent(q)}">导出 Excel</a>` : ''}
    </form>
  </section>
  <section class="panel">${U.table(
    [{ label: '出库单号' }, { label: '领料单号' }, { label: '工程' }, { label: '领料单位' }, { label: '出库日期' }, { label: '行数', align: 'r' }, { label: '数量合计', align: 'r' }, { label: '出库人' }, { label: '状态' }, { label: '' }],
    rows.map((d) => [
      U.esc(d.doc_no), `<a href="/req/${d.source_doc_id}">${U.esc(d.req_no || '')}</a>`, U.esc(d.project_name || ''),
      U.esc(d.team_name || ''), U.esc(d.doc_date || ''), String(d.n), fmt(d.qty), U.esc(d.out_by || ''),
      U.statusBadge(d.status),
      `<a class="mini" href="/doc/${d.id}">明细</a>`,
    ]),
    { empty: '没有出库记录' }
  )}</section>`;
  return page(ctx, '出库查询', '/out/list', body);
}

/* ============ 退料 ============ */
function retNewPage(ctx) {
  const q = String(q1(ctx.query.q) || '').trim();
  const pids = projectsOf(ctx).map((p) => p.id);
  if (!pids.length) return page(ctx, '退料登记', '/ret/new', '<section class="panel">你还没有被分配到任何工程。</section>');
  const args = [];
  let extra = '';
  if (q) {
    extra = ` AND (d.doc_no LIKE ? OR p.name LIKE ? OR ${docsItemMatch('d')})`;
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = all(
    `SELECT d.*, p.name AS project_name, t.name AS team_name,
            (SELECT IFNULL(SUM(x.qty),0) FROM doc_items x JOIN docs od ON od.id=x.doc_id WHERE od.type='OUT' AND od.status!='void' AND od.source_doc_id=d.id) AS out_qty,
            (SELECT IFNULL(SUM(x.qty),0) FROM doc_items x JOIN docs rd ON rd.id=x.doc_id WHERE rd.type='RET' AND rd.source_doc_id=d.id) AS ret_qty
     FROM docs d LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN teams t ON t.id=d.team_id
     WHERE d.type='REQ' AND d.status IN ('submitted','part','closed') AND d.project_id IN (${pids.join(',')})${extra}
     ORDER BY d.id DESC LIMIT 200`,
    ...args
  );
  const list = rows.filter((r) => Number(r.out_qty) - Number(r.ret_qty) > 1e-9);
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <h2>退料登记</h2>
    <form class="toolbar" method="get" action="/ret/new">
      <input name="q" value="${U.esc(q)}" placeholder="领料单号 / 物资 / 规格 / 计划编号" style="min-width:260px">
      <button class="btn">搜索</button>
    </form>
    <p class="muted">只能对已出库且还有未退数量的领料单退料；退料直接加回库存。</p>
  </section>
  <section class="panel">${U.table(
    [{ label: '领料单号' }, { label: '工程' }, { label: '领料单位' }, { label: '已出库', align: 'r' }, { label: '已退', align: 'r' }, { label: '可退', align: 'r' }, { label: '' }],
    list.map((d) => [
      U.esc(d.doc_no), U.esc(d.project_name || ''), U.esc(d.team_name || ''),
      fmt(d.out_qty), fmt(d.ret_qty), `<b>${fmt(Number(d.out_qty) - Number(d.ret_qty))}</b>`,
      `<a class="btn mini primary" href="/ret/${d.id}">去退料</a>`,
    ]),
    { empty: '没有可退料的领料单' }
  )}</section>`;
  return page(ctx, '退料登记', '/ret/new', body);
}

function retPickPage(ctx, reqId) {
  const d = docOr404(ctx, reqId);
  if (!d) return;
  if (d.type !== 'REQ') return ctx.redirect('/ret/new');
  const items = all(
    `SELECT x.*,
      IFNULL((SELECT SUM(o.qty) FROM doc_items o JOIN docs od ON od.id=o.doc_id WHERE od.type='OUT' AND od.status!='void' AND od.source_doc_id=? AND o.stock_item_id=x.stock_item_id),0) AS out_qty,
      IFNULL((SELECT SUM(o.qty) FROM doc_items o JOIN docs od ON od.id=o.doc_id WHERE od.type='RET' AND od.source_doc_id=? AND o.stock_item_id=x.stock_item_id),0) AS ret_qty
     FROM doc_items x WHERE x.doc_id=? ORDER BY x.seq`,
    d.id, d.id, d.id
  );
  const lines = items
    .map((i2) => ({ ...i2, left: Math.min(Number(i2.out_qty) - Number(i2.ret_qty), Number(i2.qty)) }))
    .filter((i2) => i2.left > 1e-9);
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <div class="doc-head">
      <div><small>领料单号</small><b>${U.esc(d.doc_no)}</b></div>
      <div><small>工程</small><b>${U.esc(d.project_name || '')}</b></div>
      <div><small>领料单位</small><b>${U.esc(d.team_name || '')}</b></div>
      <div><small>状态</small><b>${U.statusBadge(d.status)}</b></div>
    </div>
    <form method="post" action="/ret/save">
      <input type="hidden" name="req_id" value="${d.id}">
      <input type="hidden" name="_ft" value="${idem.issue()}">
      ${U.table(
        [{ label: '勾选' }, { label: '物资名称' }, { label: '规格型号' }, { label: '单位' }, { label: '已出库', align: 'r' }, { label: '已退', align: 'r' }, { label: '可退', align: 'r' }, { label: '本次退料', align: 'r' }],
        lines.map((i2) => [
          `<input type="checkbox" name="pick" value="${i2.id}">`,
          U.esc(i2.name), U.esc(i2.spec || ''), U.esc(i2.unit),
          fmt(i2.out_qty), fmt(i2.ret_qty), fmt(i2.left),
          `<input class="qty" type="number" step="0.001" min="0" max="${i2.left}" name="qty_${i2.id}" placeholder="${fmt(i2.left)}">`,
        ]),
        { empty: '没有可退物资' }
      )}
      <div class="form-actions">
        <label class="field"><span>备注</span><input name="remark" placeholder="退料原因，可不填"></label>
        <button class="btn primary"${lines.length ? '' : ' disabled'}>确认退料入库</button>
        <a class="btn" href="/ret/new">返回</a>
      </div>
    </form>
  </section>`;
  return page(ctx, '退料入库', '/ret/new', body);
}

function retSave(ctx) {
  const b = ctx.body;
  const reqId = Number(b.req_id || 0);
  const d = one("SELECT * FROM docs WHERE id=? AND type='REQ'", reqId);
  if (!d) return err(ctx, '领料单不存在', '/ret/new');
  const picks = arr(b.pick).map(Number).filter(Boolean);
  if (!picks.length) return err(ctx, '请勾选要退的物资', '/ret/' + reqId);

  const rows = [];
  const problems = [];
  for (const id of picks) {
    const line = one('SELECT * FROM doc_items WHERE id=? AND doc_id=?', id, reqId);
    if (!line) continue;
    const left = Math.min(outedOf(reqId, line.stock_item_id) - returnedOf(reqId, line.stock_item_id), line.qty);
    const qty = toNum(b['qty_' + id]) || left;
    if (qty <= 0) { problems.push(`「${line.name}」退料数量必须大于 0`); continue; }
    if (qty > left + 1e-9) { problems.push(`「${line.name}」最多可退 ${fmt(left)}，本次填了 ${fmt(qty)}`); continue; }
    rows.push({ line, qty });
  }
  if (!rows.length) return err(ctx, problems[0] || '没有有效行', '/ret/' + reqId);
  if (problems.length) return err(ctx, problems.join('；'), '/ret/' + reqId);

  // 表单令牌：同一份退料表单只允许生成一张退料单（防双击 / 网络重试）
  const tk = idem.claim(b._ft);
  if (!tk.fresh) return ctx.flash(tk.doc_id ? '/doc/' + tk.doc_id : '/req/' + reqId, '这份退料表单刚才已提交过，未重复退料');

  const docNo = nextDocNo('RET', d.project_id);
  const r = run(
    `INSERT INTO docs(doc_no,type,doc_date,project_id,major_id,team_id,status,source_doc_id,remark,created_by,created_at,submitted_at)
     VALUES(?,?,?,?,?,?,'submitted',?,?,?,?,?)`,
    docNo, 'RET', today(), d.project_id, d.major_id, d.team_id, reqId, String(b.remark || ''), ctx.user.id, now(), now()
  );
  const docId = Number(r.lastInsertRowid);
  const t = now();
  rows.forEach((x, i) => {
    run(
      `INSERT INTO doc_items(doc_id,seq,stock_item_id,plan_no,material_code,name,spec,tech_req,unit,qty)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      docId, i + 1, x.line.stock_item_id, x.line.plan_no || '', x.line.material_code || '', x.line.name, x.line.spec || '', x.line.tech_req || '', x.line.unit, x.qty
    );
    run(
      'INSERT INTO stock_moves(item_id,doc_id,doc_type,qty,doc_date,user_id,created_at) VALUES(?,?,?,?,?,?,?)',
      x.line.stock_item_id, docId, 'RET', Math.abs(x.qty), today(), ctx.user.id, t
    );
  });
  idem.bind(b._ft, docId);
  return ctx.flash('/req/' + reqId, `退料完成，单号 ${docNo}，库存已增加`);
}

function retList(ctx) {
  const pid = Number(q1(ctx.query.project) || 0);
  const from = q1(ctx.query.from) || '';
  const to = q1(ctx.query.to) || '';
  const q = String(q1(ctx.query.q) || '').trim();
  const pids = projectsOf(ctx).map((p) => p.id);
  if (!pids.length) return page(ctx, '退料查询', '/ret/list', '<section class="panel">你还没有被分配到任何工程。</section>');
  const where = [`d.type='RET'`, `d.project_id IN (${pids.join(',')})`];
  const args = [];
  if (pid) { where.push('d.project_id=?'); args.push(pid); }
  if (from) { where.push('d.doc_date>=?'); args.push(from); }
  if (to) { where.push('d.doc_date<=?'); args.push(to); }
  if (q) {
    where.push(`(d.doc_no LIKE ? OR s.doc_no LIKE ? OR ${docsItemMatch('d')})`);
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = all(
    `SELECT d.*, p.name AS project_name, t.name AS team_name, u.name AS back_by, s.doc_no AS req_no,
            (SELECT IFNULL(SUM(x.qty),0) FROM doc_items x WHERE x.doc_id=d.id) AS qty,
            (SELECT COUNT(*) FROM doc_items x WHERE x.doc_id=d.id) AS n
     FROM docs d LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN teams t ON t.id=d.team_id
     LEFT JOIN users u ON u.id=d.created_by LEFT JOIN docs s ON s.id=d.source_doc_id
     WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 300`,
    ...args
  );
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <form class="toolbar" method="get" action="/ret/list">
      ${U.select('project', projectsOf(ctx).map((p) => ({ value: p.id, label: p.name })), pid, { placeholder: '全部工程' })}
      <input type="date" name="from" value="${U.esc(from)}"> <span class="muted">至</span> <input type="date" name="to" value="${U.esc(to)}">
      <input name="q" value="${U.esc(q)}" placeholder="单号 / 物资 / 规格 / 计划编号">
      <button class="btn">查询</button>
      ${can(ctx.user, 'export.xlsx') ? `<a class="btn ghost" href="/export?kind=ret&project=${pid}&from=${from}&to=${to}&q=${encodeURIComponent(q)}">导出 Excel</a>` : ''}
    </form>
  </section>
  <section class="panel">${U.table(
    [{ label: '退料单号' }, { label: '领料单号' }, { label: '工程' }, { label: '领料单位' }, { label: '退料日期' }, { label: '行数', align: 'r' }, { label: '数量合计', align: 'r' }, { label: '退料人' }, { label: '' }],
    rows.map((d) => [
      U.esc(d.doc_no), `<a href="/req/${d.source_doc_id}">${U.esc(d.req_no || '')}</a>`, U.esc(d.project_name || ''),
      U.esc(d.team_name || ''), U.esc(d.doc_date || ''), String(d.n), fmt(d.qty), U.esc(d.back_by || ''),
      `<a class="mini" href="/doc/${d.id}">明细</a>`,
    ]),
    { empty: '没有退料记录' }
  )}</section>`;
  return page(ctx, '退料查询', '/ret/list', body);
}

/* ============ 库存 ============ */
function stockPage(ctx) {
  const pid = Number(q1(ctx.query.project) || 0);
  const mid = Number(q1(ctx.query.major) || 0);
  const q = String(q1(ctx.query.q) || '').trim();
  const zero = q1(ctx.query.zero) === '1';
  const pids = projectsOf(ctx).map((p) => p.id);
  if (!pids.length) return page(ctx, '库存', '/stock', '<section class="panel">你还没有被分配到任何工程。</section>');
  const where = [`si.project_id IN (${pids.join(',')})`];
  const args = [];
  if (pid) { where.push('si.project_id = ?'); args.push(pid); }
  if (mid) { where.push('si.major_id = ?'); args.push(mid); }
  if (q) { where.push('(si.name LIKE ? OR si.spec LIKE ? OR si.material_code LIKE ? OR si.plan_no LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = stockRows(where, args, { positive: !zero });
  const sum = rows.reduce((s2, r) => s2 + Number(r.balance || 0), 0);
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <form class="toolbar" method="get" action="/stock">
      ${U.select('project', projectsOf(ctx).map((p) => ({ value: p.id, label: p.name })), pid, { placeholder: '全部工程' })}
      ${U.select('major', majorsOf().map((m) => ({ value: m.id, label: m.name })), mid, { placeholder: '全部专业' })}
      <input name="q" value="${U.esc(q)}" placeholder="物资 / 规格 / 编码 / 计划编号">
      <label class="inl"><input type="checkbox" name="zero" value="1"${zero ? ' checked' : ''}> 显示 0 数量物资</label>
      <button class="btn">查询</button>
      ${can(ctx.user, 'export.xlsx') ? `<a class="btn ghost" href="/export?kind=stock&project=${pid}&major=${mid}&q=${encodeURIComponent(q)}&zero=${zero ? 1 : 0}">导出 Excel</a>` : ''}
      <span class="hint">共 ${rows.length} 条，合计 ${fmt(sum)}</span>
    </form>
    <p class="muted">同一物资不同批次分行显示、互不合并；结存由入库、出库、退料流水汇总得出。</p>
  </section>
  <section class="panel">${U.table(
    [{ label: '工程' }, { label: '专业' }, { label: '需求计划编号' }, { label: '物资名称' }, { label: '规格型号' }, { label: '单位' }, { label: '入库', align: 'r' }, { label: '出库', align: 'r' }, { label: '退料', align: 'r' }, { label: '结存', align: 'r' }, { label: '最近到货' }, { label: '' }],
    rows.map((r) => [
      U.esc(r.project_name), U.esc(r.major_name), U.esc(r.plan_no || ''), U.esc(r.name), U.esc(r.spec || ''), U.esc(r.unit),
      fmt(r.in_qty), fmt(r.out_qty), fmt(r.ret_qty), `<b>${fmt(r.balance)}</b>`, U.esc(r.arrival_date || ''),
      `<a class="mini" href="/stock/${r.id}/outs" target="_blank">出库明细</a>`,
    ]),
    { empty: '没有库存记录' }
  )}</section>`;
  return page(ctx, '库存', '/stock', body);
}

/* ============ 单项物资的出库 / 退库记录 ============ */
function stockOutPage(ctx, itemId) {
  const pids = projectsOf(ctx).map((p) => p.id);
  const item = one(
    `SELECT si.*, pj.name AS project_name, mj.name AS major_name,
            IFNULL((SELECT SUM(m.qty) FROM stock_moves m WHERE m.item_id = si.id), 0) AS balance
     FROM stock_items si LEFT JOIN projects pj ON pj.id = si.project_id LEFT JOIN majors mj ON mj.id = si.major_id
     WHERE si.id = ? AND si.project_id IN (${pids.join(',')})`,
    itemId
  );
  if (!item) {
    return page(ctx, '出库明细', '/stock', '<section class="panel">物资不存在，或不属于你参与的工程。<div class="form-actions"><a class="btn" href="/stock">返回库存</a></div></section>', { status: 404 });
  }
  const moves = all(
    `SELECT sm.qty, sm.doc_date, sm.doc_type, od.doc_no, od.remark, od.id AS doc_id,
            s.id AS req_id, s.doc_no AS req_no,
            t.name AS team_name, uo.name AS by_name, um.name AS req_maker
     FROM stock_moves sm
     JOIN docs od ON od.id = sm.doc_id
     LEFT JOIN docs s ON s.id = od.source_doc_id
     LEFT JOIN teams t ON t.id = od.team_id
     LEFT JOIN users uo ON uo.id = od.created_by
     LEFT JOIN users um ON um.id = s.created_by
     WHERE sm.item_id = ? AND sm.doc_type IN ('OUT','RET')
     ORDER BY sm.doc_date, sm.id`,
    itemId
  );
  const sumOf = (t) => moves.filter((m) => m.doc_type === t).reduce((s2, m) => s2 + Math.abs(Number(m.qty)), 0);
  const outSum = sumOf('OUT');
  const retSum = sumOf('RET');
  const unit = U.esc(item.unit);
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <div class="doc-head">
      <div><small>物资名称</small><b>${U.esc(item.name)}</b></div>
      <div><small>规格型号</small><b>${U.esc(item.spec || '—')}</b></div>
      <div><small>需求计划编号</small><b>${U.esc(item.plan_no || '—')}</b></div>
      <div><small>工程</small><b>${U.esc(item.project_name || '')}</b></div>
      <div><small>专业</small><b>${U.esc(item.major_name || '')}</b></div>
      <div><small>当前结存</small><b>${fmt(item.balance)} ${unit}</b></div>
    </div>
    <div class="form-actions">
      <a class="btn" href="/stock" onclick="window.close()">返回库存</a>
      <span class="hint">累计出库 <b class="out">${fmt(outSum)}</b> ${unit}　累计退库 <b class="in">${fmt(retSum)}</b> ${unit}　净出库 <b>${fmt(outSum - retSum)}</b> ${unit}　共 ${moves.length} 笔</span>
    </div>
  </section>
  <section class="panel"><h2>出库 / 退库记录</h2>
    <p class="muted">出库为领用，退库为领用后退回，两者都记在同一台账里；净出库 = 累计出库 − 累计退库。</p>
    ${U.table(
      [
        { label: '类型' }, { label: '日期' }, { label: '单据号' }, { label: '领料单号' }, { label: '领料队伍' },
        { label: '数量', align: 'r' }, { label: '经办人' }, { label: '领料单制单人' }, { label: '备注' },
      ],
      moves.map((m) => {
        const isOut = m.doc_type === 'OUT';
        const qty = Math.abs(Number(m.qty));
        return [
          isOut ? '<span class="out">出库</span>' : '<span class="in">退库</span>',
          U.esc(m.doc_date || ''),
          `<a href="/doc/${m.doc_id}" target="_blank">${U.esc(m.doc_no || '')}</a>`,
          m.req_id ? `<a href="/req/${m.req_id}" target="_blank">${U.esc(m.req_no || '')}</a>` : '—',
          U.esc(m.team_name || '—'),
          isOut ? `<span class="out">-${fmt(qty)}</span>` : `<span class="in">+${fmt(qty)}</span>`,
          U.esc(m.by_name || '—'),
          U.esc(m.req_maker || '—'),
          U.esc(m.remark || ''),
        ];
      }),
      { empty: '该物资还没有出库或退库记录' }
    )}</section>`;
  return page(ctx, '出库 / 退库记录 · ' + item.name, '/stock', body);
}

/* ============ 单据查看 ============ */
/* 天气：点击顶栏天气时调用，强制刷新（60 秒内仍走缓存） */
async function apiWeather(ctx) {
  const force = q1(ctx.query.force) === '1';
  const w = await require('./weather')
    .get('Longkou', '龙口', force)
    .catch(() => null);
  if (!w) return ctx.json({ ok: false, msg: '天气服务暂时不可用' });
  return ctx.json({ ok: true, data: w });
}

async function aiChat(ctx) {
  const q = String(ctx.body.q || '').trim().slice(0, 500);
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(String(ctx.req.headers.cookie || ''));
  const sid = m ? m[1] : 'u' + (ctx.user && ctx.user.id);
  const raw = ctx.body && ctx.body.ctx;
  const page = raw && typeof raw === 'object' && Number(raw.item_id) > 0 ? { item_id: Number(raw.item_id) } : null;
  const r = await require('./ai').ask(ctx.user, q, sid, page);
  return ctx.json(r);
}

function docView(ctx, id) {
  const d = docOr404(ctx, id);
  if (!d) return;
  if (d.type === 'IN') return inDetail(ctx, id);
  if (d.type === 'REQ') return ctx.redirect('/req/' + id);
  const items = docItems(id);
  const body = `
  ${msgBar(ctx)}
  <section class="panel">
    <div class="doc-head">
      <div><small>单号</small><b>${U.esc(d.doc_no)}</b></div>
      <div><small>类型</small><b>${U.esc(U.docTypeName(d.type))}</b></div>
      <div><small>工程</small><b>${U.esc(d.project_name || '')}</b></div>
      <div><small>领料单位</small><b>${U.esc(d.team_name || '')}</b></div>
      <div><small>关联领料单</small><b><a href="/req/${d.source_doc_id || ''}">${U.esc(d.source_no || '')}</a></b></div>
      <div><small>日期</small><b>${U.esc(d.doc_date || '')}</b></div>
      <div><small>经办人</small><b>${U.esc(d.maker || '')}</b></div>
      <div><small>状态</small><b>${U.statusBadge(d.status)}</b></div>
    </div>
    ${d.remark ? `<p class="muted">备注：${U.esc(d.remark)}</p>` : ''}
    ${
      d.type === 'OUT' && d.status === 'submitted'
        ? can(ctx.user, 'doc.admin')
          ? `<p class="muted" style="color:#b26a00">填错数量？可撤回这张出库单：库存会冲回，关联领料单恢复为待出库，随后重新出库即可。</p>`
          : `<p class="muted">如需撤回这张出库单，请联系管理员。</p>`
        : ''
    }
    <div class="form-actions">
      <a class="btn" href="${d.type === 'RET' ? '/ret/list' : '/out/list'}">返回</a>
      ${
        d.type === 'OUT' && d.status === 'submitted' && can(ctx.user, 'doc.admin')
          ? `<form method="post" action="/out/${d.id}/void" onsubmit="return confirm('撤回后这张出库单作废、库存冲回，关联领料单恢复为待出库。确定？')"><button class="btn danger">撤回出库</button></form>`
          : ''
      }
    </div>
  </section>
  <section class="panel"><h2>明细</h2>
    ${U.table(
      [{ label: '序号' }, { label: '需求计划编号' }, { label: '物资名称' }, { label: '规格型号' }, { label: '单位' }, { label: '数量', align: 'r' }],
      items.map((i2) => [String(i2.seq), U.esc(i2.plan_no || ''), U.esc(i2.name), U.esc(i2.spec || ''), U.esc(i2.unit), fmt(i2.qty)])
    )}
  </section>`;
  return page(ctx, U.docTypeName(d.type), '', body);
}

/* 撤回出库：冲回库存 + 单据作废 + 关联领料单状态回退。仅管理员 / 二级管理员（doc.admin）。 */
function outVoid(ctx, id) {
  const d = one("SELECT * FROM docs WHERE id=? AND type='OUT'", id);
  if (!d) return err(ctx, '出库单不存在', '/out/list');
  if (!can(ctx.user, 'doc.admin')) return err(ctx, '只有管理员或二级管理员可以撤回出库', '/doc/' + id);
  if (d.status === 'void') return err(ctx, '这张出库单已作废，无需重复撤回', '/doc/' + id);
  if (d.status !== 'submitted') return err(ctx, '当前状态不允许撤回', '/doc/' + id);
  /* 同一领料单若已发生退料，撤回出库会让「退了却没出」的账对不上，先拦住 */
  const rets = one("SELECT COUNT(*) n FROM docs WHERE type='RET' AND source_doc_id=?", d.source_doc_id || 0);
  if (rets.n > 0) return err(ctx, '这张领料单已有退料记录，请先撤回退料，再撤回出库', '/doc/' + id);

  const items = docItems(id);
  for (const it of items) {
    run('DELETE FROM stock_moves WHERE item_id=? AND doc_id=?', it.stock_item_id, id);
  }
  run("UPDATE docs SET status='void', modified_by=?, modified_at=? WHERE id=?", ctx.user.id, now(), id);
  if (d.source_doc_id) refreshReqStatus(d.source_doc_id);
  return ctx.flash('/doc/' + id, `已撤回 ${d.doc_no}：库存已冲回，领料单恢复为待出库`);
}

/* ============ 导出 ============ */
function exportXlsx(ctx) {
  const kind = q1(ctx.query.kind);
  const pids = projectsOf(ctx).map((p) => p.id);
  const scope = pids.length ? pids.join(',') : '0';
  let name = '导出';
  let columns = [];
  let rows = [];

  if (kind === 'stock') {
    name = '库存';
    const pid = Number(q1(ctx.query.project) || 0);
    const mid = Number(q1(ctx.query.major) || 0);
    const q = String(q1(ctx.query.q) || '').trim();
    const zero = q1(ctx.query.zero) === '1';
    const where = [`si.project_id IN (${scope})`];
    const args = [];
    if (pid) { where.push('si.project_id = ?'); args.push(pid); }
    if (mid) { where.push('si.major_id = ?'); args.push(mid); }
    if (q) { where.push('(si.name LIKE ? OR si.spec LIKE ? OR si.material_code LIKE ? OR si.plan_no LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    rows = stockRows(where, args, { positive: !zero });
    columns = [
      { key: 'project_name', label: '工程', width: 18 },
      { key: 'major_name', label: '专业', width: 10 },
      { key: 'plan_no', label: '需求计划编号', width: 24 },
      { key: 'name', label: '物资名称', width: 26 },
      { key: 'spec', label: '规格型号', width: 30 },
      { key: 'tech_req', label: '技术要求', width: 20 },
      { key: 'unit', label: '单位', width: 8 },
      { key: 'in_qty', label: '入库', width: 10, type: 'number' },
      { key: 'out_qty', label: '出库', width: 10, type: 'number' },
      { key: 'ret_qty', label: '退料', width: 10, type: 'number' },
      { key: 'balance', label: '结存', width: 10, type: 'number' },
      { key: 'arrival_date', label: '最近到货', width: 12 },
    ];
  } else if (kind === 'in_items') {
    name = '入库明细';
    const pid = Number(q1(ctx.query.project) || 0);
    const mid = Number(q1(ctx.query.major) || 0);
    const from = q1(ctx.query.from) || '';
    const to = q1(ctx.query.to) || '';
    const plan = String(q1(ctx.query.plan) || '').trim();
    const q = String(q1(ctx.query.q) || '').trim();
    const where = [`si.project_id IN (${scope})`];
    const args = [];
    if (pid) { where.push('si.project_id = ?'); args.push(pid); }
    if (mid) { where.push('si.major_id = ?'); args.push(mid); }
    if (from) { where.push('si.arrival_date >= ?'); args.push(from); }
    if (to) { where.push('si.arrival_date <= ?'); args.push(to); }
    if (plan) { where.push('si.plan_no LIKE ?'); args.push(`%${plan}%`); }
    if (q) { where.push('(si.name LIKE ? OR si.spec LIKE ? OR si.material_code LIKE ? OR si.plan_no LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    rows = stockRows(where, args);
    columns = [
      { key: 'project_name', label: '工程名称', width: 18 },
      { key: 'major_name', label: '专业', width: 10 },
      { key: 'seq', label: '序号', width: 6, type: 'number' },
      { key: 'plan_no', label: '需求计划编号', width: 24 },
      { key: 'name', label: '物资名称', width: 26 },
      { key: 'spec', label: '规格型号', width: 30 },
      { key: 'tech_req', label: '技术要求', width: 20 },
      { key: 'unit', label: '单位', width: 8 },
      { key: 'in_qty', label: '数量', width: 10, type: 'number' },
      { key: 'out_qty', label: '出库数量', width: 10, type: 'number' },
      { key: 'ret_qty', label: '退库数量', width: 10, type: 'number' },
      { key: 'balance', label: '剩余数量', width: 10, type: 'number' },
    ];
  } else if (kind === 'req') {
    name = '领用明细';
    const pid = Number(q1(ctx.query.project) || 0);
    const tid = Number(q1(ctx.query.team) || 0);
    const from = q1(ctx.query.from) || '';
    const to = q1(ctx.query.to) || '';
    const no = String(q1(ctx.query.no) || '').trim();
    const q = String(q1(ctx.query.q) || '').trim();
    const where = [`d.type='REQ'`, `d.project_id IN (${scope})`];
    const args = [];
    if (pid) { where.push('d.project_id=?'); args.push(pid); }
    if (tid) { where.push('d.team_id=?'); args.push(tid); }
    if (from) { where.push('d.doc_date>=?'); args.push(from); }
    if (to) { where.push('d.doc_date<=?'); args.push(to); }
    if (no) { where.push('d.doc_no LIKE ?'); args.push(`%${no}%`); }
    if (q) { where.push('(x.name LIKE ? OR x.spec LIKE ? OR x.plan_no LIKE ? OR x.material_code LIKE ? OR d.remark LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    rows = all(
      `SELECT d.doc_no, d.doc_date, p.name AS project_name, t.name AS team_name, m.name AS major_name,
              u.name AS maker, d.status, x.seq, x.plan_no, x.name, x.spec, x.tech_req, x.unit, x.qty
       FROM docs d JOIN doc_items x ON x.doc_id=d.id
       LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN teams t ON t.id=d.team_id
       LEFT JOIN majors m ON m.id=d.major_id LEFT JOIN users u ON u.id=d.created_by
       WHERE ${where.join(' AND ')} ORDER BY d.id DESC, x.seq`,
      ...args
    ).map((r) => ({ ...r, status_name: (STATUS[r.status] || {}).name || r.status }));
    columns = [
      { key: 'doc_no', label: '制单编号', width: 22 },
      { key: 'doc_date', label: '申请日期', width: 12 },
      { key: 'project_name', label: '工程', width: 18 },
      { key: 'team_name', label: '领料单位', width: 16 },
      { key: 'major_name', label: '专业', width: 10 },
      { key: 'seq', label: '序号', width: 6, type: 'number' },
      { key: 'plan_no', label: '需求计划编号', width: 22 },
      { key: 'name', label: '物资名称', width: 26 },
      { key: 'spec', label: '规格型号', width: 28 },
      { key: 'unit', label: '单位', width: 8 },
      { key: 'qty', label: '数量', width: 10, type: 'number' },
      { key: 'status_name', label: '状态', width: 10 },
      { key: 'maker', label: '制单人', width: 10 },
    ];
  } else if (kind === 'req_items') {
    name = '领用明细';
    const f = reqItemsFilters(ctx);
    rows = reqItemsQuery(f, pids, true);
    columns = [
      { key: 'doc_no', label: '领料单号', width: 22 },
      { key: 'doc_date', label: '申请日期', width: 12 },
      { key: 'project_name', label: '项目', width: 16 },
      { key: 'plan_no', label: '需求计划编号', width: 26 },
      { key: 'name', label: '物资名称', width: 26 },
      { key: 'spec', label: '规格型号', width: 24 },
      { key: 'unit', label: '单位', width: 8 },
      { key: 'qty', label: '数量', width: 10, type: 'number' },
      { key: 'out_qty', label: '出库数量', width: 10, type: 'number' },
      { key: 'closed_qty', label: '放弃领用', width: 10, type: 'number' },
      { key: 'left', label: '待出库', width: 10, type: 'number' },
      { key: 'maker', label: '制单人', width: 10 },
      { key: 'status_name', label: '状态', width: 10 },
    ];
  } else if (kind === 'out' || kind === 'ret') {
    const isOut = kind === 'out';
    name = isOut ? '出库明细' : '退库明细';
    const f = outRetFilters(ctx);
    rows = outRetItemsQuery(isOut ? 'OUT' : 'RET', f, pids);
    columns = [
      { key: 'doc_no', label: isOut ? '出库单号' : '退料单号', width: 22 },
      { key: 'doc_date', label: isOut ? '出库日期' : '退库日期', width: 12 },
      { key: 'project_name', label: '工程', width: 18 },
      { key: 'major_name', label: '专业', width: 10 },
      { key: 'team_name', label: '领料单位', width: 16 },
      { key: 'plan_no', label: '需求计划编号', width: 22 },
      { key: 'name', label: '物资名称', width: 26 },
      { key: 'spec', label: '规格型号', width: 28 },
      { key: 'unit', label: '单位', width: 8 },
      { key: 'qty', label: '数量', width: 10, type: 'number' },
      { key: 'req_no', label: '领料单号', width: 22 },
      { key: 'req_date', label: '领料日期', width: 12 },
      { key: 'who', label: isOut ? '出库人' : '退库人', width: 10 },
    ];
  } else {
    return ctx.html('未知的导出类型', 400);
  }

  const buf = buildXlsx({ sheetName: name, title: name, columns, rows });
  const fname = `${name}_${today()}.xlsx`;
  ctx.res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  ctx.res.end(buf);
}

/* 导入模板 */
function inTemplate(ctx) {
  const widths = [6, 16, 14, 26, 34, 20, 8, 10, 24];
  const columns = TEMPLATE_HEADER.map((h, i) => ({ key: 'c' + i, label: h, width: widths[i] || 14 }));
  const sample = {
    c0: 1, c1: '花港', c2: '', c3: '6.4不锈钢管',
    c4: '3/4" PE,316L,S-80S Ф26.7X3.91mm 6.8米', c5: '', c6: '支', c7: 5, c8: 'SD-MAL-HG-LQ-PI-1015-03',
  };
  const buf = buildXlsx({ sheetName: '物资导入', title: '物资导入模板', columns, rows: [sample] });
  ctx.res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="template.xlsx"; filename*=UTF-8''${encodeURIComponent('物资导入模板.xlsx')}`,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  ctx.res.end(buf);
}

/* ============ 基础档案 ============ */
function majorsPage(ctx) {
  const rows = all('SELECT * FROM majors ORDER BY sort, id');
  const edit = q1(ctx.query.edit) ? one('SELECT * FROM majors WHERE id=?', Number(q1(ctx.query.edit))) : null;
  const body = `
  ${msgBar(ctx)}
  <section class="panel"><h2>${edit ? '编辑专业' : '新增专业'}</h2>
    <form method="post" action="/majors/save" class="form-grid">
      <input type="hidden" name="id" value="${edit ? edit.id : ''}">
      ${U.field('专业名称', U.input('name', edit && edit.name, { required: true, placeholder: '如：结构' }), { req: 1 })}
      ${U.field('排序', U.input('sort', edit ? edit.sort : 0, { type: 'number' }))}
      ${U.field('状态', U.select('active', [{ value: 1, label: '启用' }, { value: 0, label: '停用' }], edit ? edit.active : 1))}
      <div class="form-actions full"><button class="btn primary">保存</button>${edit ? '<a class="btn" href="/majors">取消</a>' : ''}</div>
    </form>
  </section>
  <section class="panel"><h2>专业列表</h2>
    ${U.table(
      [{ label: '专业' }, { label: '排序', align: 'r' }, { label: '状态' }, { label: '库存条目', align: 'r' }, { label: '' }],
      rows.map((m) => [
        U.esc(m.name),
        String(m.sort || 0),
        m.active ? '<span class="badge ok">启用</span>' : '<span class="badge">停用</span>',
        String(one('SELECT COUNT(*) n FROM stock_items WHERE major_id=? AND active=1', m.id).n),
        `<a class="mini" href="/majors?edit=${m.id}">编辑</a>${delBtn('major', m.id, m.name, '专业')}`,
      ]),
      { empty: '还没有专业' }
    )}
  </section>`;
  return page(ctx, '专业', '/majors', body);
}

function saveMajor(ctx) {
  const b = ctx.body;
  const name = String(b.name || '').trim();
  if (!name) return err(ctx, '专业名称必填', '/majors');
  const vals = [name, Number(b.sort || 0), b.active === '0' ? 0 : 1];
  try {
    if (b.id) run('UPDATE majors SET name=?, sort=?, active=? WHERE id=?', ...vals, Number(b.id));
    else run('INSERT INTO majors(name,sort,active) VALUES(?,?,?)', ...vals);
  } catch {
    return err(ctx, '保存失败：专业名称可能重复', '/majors');
  }
  return ctx.flash('/majors', '已保存');
}

function projectsPage(ctx) {
  const rows = all('SELECT * FROM projects ORDER BY sort, id');
  const edit = q1(ctx.query.edit) ? one('SELECT * FROM projects WHERE id=?', Number(q1(ctx.query.edit))) : null;
  const body = `
  ${msgBar(ctx)}
  <section class="panel"><h2>${edit ? '编辑工程' : '新增工程'}</h2>
    <form method="post" action="/projects/save" class="form-grid">
      <input type="hidden" name="id" value="${edit ? edit.id : ''}">
      ${U.field('工程编号', U.input('code', edit && edit.code, { placeholder: '如：HG' }), {})}
      ${U.field('工程名称', U.input('name', edit && edit.name, { required: true, placeholder: '导入模板里的工程名称必须与此一致' }), { req: 1 })}
      ${U.field('排序', U.input('sort', edit ? edit.sort : 0, { type: 'number' }))}
      ${U.field('状态', U.select('active', [{ value: 1, label: '在建' }, { value: 0, label: '已完工' }], edit ? edit.active : 1))}
      <div class="form-actions full"><button class="btn primary">保存</button>${edit ? '<a class="btn" href="/projects">取消</a>' : ''}</div>
    </form>
  </section>
  <section class="panel"><h2>工程列表</h2>
    ${U.table(
      [{ label: '工程名称' }, { label: '编号' }, { label: '排序', align: 'r' }, { label: '状态' }, { label: '库存条目', align: 'r' }, { label: '成员', align: 'r' }, { label: '' }],
      rows.map((p) => [
        U.esc(p.name), U.esc(p.code || ''), String(p.sort || 0),
        p.active ? '<span class="badge ok">在建</span>' : '<span class="badge">完工</span>',
        String(one('SELECT COUNT(*) n FROM stock_items WHERE project_id=? AND active=1', p.id).n),
        String(one('SELECT COUNT(*) n FROM project_members WHERE project_id=?', p.id).n),
        `<a class="mini" href="/projects?edit=${p.id}">编辑</a>${delBtn('project', p.id, p.name, '工程')}`,
      ]),
      { empty: '还没有工程' }
    )}
  </section>`;
  return page(ctx, '工程', '/projects', body);
}

function saveProject(ctx) {
  const b = ctx.body;
  const name = String(b.name || '').trim();
  if (!name) return err(ctx, '工程名称必填', '/projects');
  const vals = [String(b.code || '').trim() || null, name, Number(b.sort || 0), b.active === '0' ? 0 : 1];
  try {
    if (b.id) run('UPDATE projects SET code=?, name=?, sort=?, active=? WHERE id=?', ...vals, Number(b.id));
    else run('INSERT INTO projects(code,name,sort,active) VALUES(?,?,?,?)', ...vals);
  } catch {
    return err(ctx, '保存失败：工程名称可能重复', '/projects');
  }
  return ctx.flash('/projects', '已保存');
}

function teamsPage(ctx) {
  const rows = all('SELECT * FROM teams ORDER BY sort, id');
  const edit = q1(ctx.query.edit) ? one('SELECT * FROM teams WHERE id=?', Number(q1(ctx.query.edit))) : null;
  const body = `
  ${msgBar(ctx)}
  <section class="panel"><h2>${edit ? '编辑施工队伍' : '新增施工队伍'}</h2>
    <form method="post" action="/teams/save" class="form-grid">
      <input type="hidden" name="id" value="${edit ? edit.id : ''}">
      ${U.field('队伍名称', U.input('name', edit && edit.name, { required: true, placeholder: '如：管道一班' }), { req: 1 })}
      ${U.field('排序', U.input('sort', edit ? edit.sort : 0, { type: 'number' }))}
      ${U.field('状态', U.select('active', [{ value: 1, label: '启用' }, { value: 0, label: '停用' }], edit ? edit.active : 1))}
      <div class="form-actions full"><button class="btn primary">保存</button>${edit ? '<a class="btn" href="/teams">取消</a>' : ''}</div>
    </form>
  </section>
  <section class="panel"><h2>队伍列表</h2>
    ${U.table(
      [{ label: '队伍' }, { label: '排序', align: 'r' }, { label: '状态' }, { label: '领料单数', align: 'r' }, { label: '' }],
      rows.map((t) => [
        U.esc(t.name), String(t.sort || 0),
        t.active ? '<span class="badge ok">启用</span>' : '<span class="badge">停用</span>',
        String(one('SELECT COUNT(*) n FROM docs WHERE team_id=? AND type=?', t.id, 'REQ').n),
        `<a class="mini" href="/teams?edit=${t.id}">编辑</a>${delBtn('team', t.id, t.name, '施工队伍')}`,
      ]),
      { empty: '还没有施工队伍' }
    )}
  </section>`;
  return page(ctx, '施工队伍', '/teams', body);
}

function saveTeam(ctx) {
  const b = ctx.body;
  const name = String(b.name || '').trim();
  if (!name) return err(ctx, '队伍名称必填', '/teams');
  const vals = [name, Number(b.sort || 0), b.active === '0' ? 0 : 1];
  try {
    if (b.id) run('UPDATE teams SET name=?, sort=?, active=? WHERE id=?', ...vals, Number(b.id));
    else run('INSERT INTO teams(name,sort,active) VALUES(?,?,?)', ...vals);
  } catch {
    return err(ctx, '保存失败：队伍名称可能重复', '/teams');
  }
  return ctx.flash('/teams', '已保存');
}

/* ============ 角色 / 用户 ============ */
function rolesPage(ctx) {
  const roles = all('SELECT * FROM roles ORDER BY id');
  const editId = Number(q1(ctx.query.edit) || 0);
  const edit = editId ? one('SELECT * FROM roles WHERE id=?', editId) : null;
  const granted = edit ? new Set(all('SELECT perm FROM role_perms WHERE role_id=?', edit.id).map((r) => r.perm)) : new Set();
  const counts = {};
  all('SELECT role_id, COUNT(*) n FROM users WHERE role_id IS NOT NULL GROUP BY role_id').forEach((x) => (counts[x.role_id] = x.n));

  const permBoxes = PERM_GROUPS.map(
    (g) => `<fieldset class="perm-group"><legend>${U.esc(g.title)}</legend>
      ${g.keys
        .map(
          (k) =>
            `<label class="perm"><input type="checkbox" name="perms" value="${k}"${granted.has(k) ? ' checked' : ''}${!edit || edit.code === 'admin' ? ' disabled' : ''}><span>${U.esc(PERM_LABELS[k] || k)}</span></label>`
        )
        .join('')}
    </fieldset>`
  ).join('');

  const body = `
  ${msgBar(ctx)}
  <section class="panel"><h2>${edit ? '编辑角色：' + U.esc(edit.name) : '角色与授权'}</h2>
    ${edit && edit.code === 'admin' ? '<p class="muted">管理员角色固定拥有全部权限，不可调整。</p>' : ''}
    ${
      edit
        ? `<form method="post" action="/roles/save" class="form-grid">
        <input type="hidden" name="id" value="${edit.id}">
        ${U.field('角色名称', U.input('name', edit.name, { required: true, readonly: edit.code === 'admin' }), { req: 1 })}
        ${U.field('说明', U.input('note', edit.note))}
        <div class="full"><div class="perm-wrap">${permBoxes}</div></div>
        <div class="form-actions full"><button class="btn primary">保存授权</button><a class="btn" href="/roles">取消</a></div>
      </form>`
        : `<form method="post" action="/roles/create" class="form-grid">
        ${U.field('新角色名称', U.input('name', '', { required: true, placeholder: '如：材料员' }), { req: 1 })}
        ${U.field('说明', U.input('note', '', { placeholder: '可选' }))}
        <div class="form-actions full"><button class="btn primary">创建角色</button></div>
      </form>`
    }
  </section>
  <section class="panel"><h2>角色列表</h2>
    ${U.table(
      [{ label: '角色' }, { label: '说明' }, { label: '权限数', align: 'r' }, { label: '用户数', align: 'r' }, { label: '' }],
      roles.map((r) => [
        U.esc(r.name) + (r.builtin ? ' <span class="badge">内置</span>' : ''),
        U.esc(r.note || ''),
        String(all('SELECT COUNT(*) n FROM role_perms WHERE role_id=?', r.id)[0].n),
        String(counts[r.id] || 0),
        `<a class="mini" href="/roles?edit=${r.id}">${r.code === 'admin' ? '查看' : '授权'}</a>${r.code === 'admin' || r.builtin ? '' : delBtn('role', r.id, r.name, '角色')}`,
      ])
    )}
  </section>`;
  return page(ctx, '角色权限', '/roles', body);
}

function saveRole(ctx) {
  const b = ctx.body;
  const id = Number(b.id);
  const role = one('SELECT * FROM roles WHERE id=?', id);
  if (!role) return err(ctx, '角色不存在', '/roles');
  if (role.code !== 'admin') {
    if (!role.builtin && b.name) run('UPDATE roles SET name=?, note=? WHERE id=?', String(b.name).trim(), b.note || null, id);
    else run('UPDATE roles SET note=? WHERE id=?', b.note || null, id);
    run('DELETE FROM role_perms WHERE role_id=?', id);
    for (const p of arr(b.perms)) {
      if (PERM_KEYS.includes(p)) run('INSERT OR IGNORE INTO role_perms(role_id,perm) VALUES(?,?)', id, p);
    }
  }
  return ctx.flash('/roles', '授权已保存');
}

function createRole(ctx) {
  const name = String(ctx.body.name || '').trim();
  if (!name) return err(ctx, '角色名称必填', '/roles');
  const code = 'r' + Date.now().toString(36);
  const r = run('INSERT INTO roles(code,name,note,builtin) VALUES(?,?,?,0)', code, name, ctx.body.note || null);
  return ctx.flash('/roles?edit=' + Number(r.lastInsertRowid), '角色已创建，请勾选权限');
}

/* ---------- 基础档案删除 ----------
   规则：被业务数据引用时拒绝删除并说明原因，只有"建错了、还没被用"的档案才真删。
   工程 / 用户删除时连带清理"参与工程"这类纯关联记录（它们不算业务引用）。 */
const BASE_DEL = {
  project: {
    perm: 'base.project', label: '工程', table: 'projects', back: '/projects', nameCol: 'name',
    refs: (id) => [
      ['库存条目', one('SELECT COUNT(*) n FROM stock_items WHERE project_id=?', id).n],
      ['单据', one('SELECT COUNT(*) n FROM docs WHERE project_id=?', id).n],
    ],
    cleanup: (id) => run('DELETE FROM project_members WHERE project_id=?', id),
  },
  major: {
    perm: 'base.major', label: '专业', table: 'majors', back: '/majors', nameCol: 'name',
    refs: (id) => [
      ['库存条目', one('SELECT COUNT(*) n FROM stock_items WHERE major_id=?', id).n],
      ['单据', one('SELECT COUNT(*) n FROM docs WHERE major_id=?', id).n],
    ],
  },
  team: {
    perm: 'base.team', label: '施工队伍', table: 'teams', back: '/teams', nameCol: 'name',
    refs: (id) => [
      ['单据', one('SELECT COUNT(*) n FROM docs WHERE team_id=?', id).n],
      ['用户', one('SELECT COUNT(*) n FROM users WHERE team_id=?', id).n],
    ],
  },
  user: {
    perm: 'sys.user', label: '用户', table: 'users', back: '/users', nameCol: 'name',
    refs: (id) => [
      ['制单记录', one('SELECT COUNT(*) n FROM docs WHERE created_by=?', id).n],
      ['库存流水', one('SELECT COUNT(*) n FROM stock_moves WHERE user_id=?', id).n],
    ],
    guard: (ctx, row) => {
      if (row.id === ctx.user.id) return '不能删除当前正在登录的账号。';
      const code = row.role_id ? (one('SELECT code FROM roles WHERE id=?', row.role_id) || {}).code : '';
      if (code === 'admin' && one("SELECT COUNT(*) n FROM users u JOIN roles r ON r.id=u.role_id WHERE r.code='admin' AND u.active=1").n <= 1) {
        return '这是最后一个启用中的管理员账号，删除后将没有人能管理系统，已阻止。';
      }
      return null;
    },
    cleanup: (id) => {
      run('DELETE FROM sessions WHERE user_id=?', id);
      run('DELETE FROM project_members WHERE user_id=?', id);
    },
  },
  role: {
    perm: 'sys.role', label: '角色', table: 'roles', back: '/roles', nameCol: 'name',
    refs: (id) => [['用户', one('SELECT COUNT(*) n FROM users WHERE role_id=?', id).n]],
    guard: (ctx, row) => {
      if (row.code === 'admin') return '管理员角色不能删除。';
      if (row.builtin) return '内置角色不能删除。';
      return null;
    },
    cleanup: (id) => run('DELETE FROM role_perms WHERE role_id=?', id),
  },
};

function deleteBase(ctx) {
  const spec = BASE_DEL[String(ctx.body.kind || '')];
  const id = Number(ctx.body.id || 0);
  if (!spec) return err(ctx, '不支持的删除类型', '/');
  if (!can(ctx.user, spec.perm)) return err(ctx, '没有删除该档案的权限', spec.back);
  const row = one(`SELECT * FROM ${spec.table} WHERE id=?`, id);
  if (!row) return err(ctx, `${spec.label}不存在或已被删除`, spec.back);
  const shown = String(row[spec.nameCol] || row.username || id);

  // 先判"绝对不能删"的硬规则（自删、最后一个管理员、内置角色），再判引用
  const blocked = spec.guard ? spec.guard(ctx, row) : null;
  if (blocked) return err(ctx, blocked, spec.back);

  const used = (spec.refs ? spec.refs(id) : []).filter((x) => Number(x[1]) > 0);
  if (used.length) {
    return err(
      ctx,
      `无法删除${spec.label}「${shown}」：仍被 ${used.map((x) => x[0] + ' ' + x[1] + ' 条').join('、')} 使用。请先清理这些数据，或改用「停用 / 完工」状态。`,
      spec.back
    );
  }

  if (spec.cleanup) spec.cleanup(id);
  run(`DELETE FROM ${spec.table} WHERE id=?`, id);
  return ctx.flash(spec.back, `已删除${spec.label}「${shown}」`);
}

/* 列表行内删除按钮：POST + 二次确认，不用 GET 链接，避免被预加载或爬虫误触 */
function delBtn(kind, id, shown, label) {
  const tip = `确定删除${label}「${shown}」？删除后不可恢复。`;
  return `<form method="post" action="/base/delete" class="inline-del" onsubmit='return confirm(${U.esc(JSON.stringify(tip))})'><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="id" value="${id}"><button type="submit" class="mini danger">删除</button></form>`;
}

function usersPage(ctx) {
  const rows = all('SELECT u.*, r.name AS role_name, r.code AS role_code FROM users u LEFT JOIN roles r ON r.id=u.role_id ORDER BY u.id');
  const edit = q1(ctx.query.edit) ? one('SELECT * FROM users WHERE id=?', Number(q1(ctx.query.edit))) : null;
  const roles = all('SELECT id,code,name FROM roles ORDER BY id');
  const members = edit ? new Set(all('SELECT project_id FROM project_members WHERE user_id=?', edit.id).map((m) => m.project_id)) : new Set();
  const projects = all('SELECT * FROM projects ORDER BY sort, id');
  /* 列表里直接把参与工程的名字列出来，不再只显示个数 */
  const memNames = (uid) =>
    all(
      'SELECT p.name FROM project_members m JOIN projects p ON p.id = m.project_id WHERE m.user_id = ? ORDER BY p.sort, p.id',
      uid
    ).map((x) => x.name);
  const seesAll = (u2) =>
    u2.role_code === 'admin' ||
    (u2.role_id ? !!one("SELECT 1 AS x FROM role_perms WHERE role_id=? AND perm='scope.all'", u2.role_id) : false);
  const body = `
  ${msgBar(ctx)}
  <section class="panel"><h2>${edit ? '编辑用户：' + U.esc(edit.name) : '新增用户'}</h2>
    <form method="post" action="/users/save" class="form-grid">
      <input type="hidden" name="id" value="${edit ? edit.id : ''}">
      ${U.field('登录账号', U.input('username', edit && edit.username, { required: true }), { req: 1 })}
      ${U.field('姓名', U.input('name', edit && edit.name, { required: true }), { req: 1 })}
      ${U.field('岗位（角色）', U.select('role_id', roles.map((r) => ({ value: r.id, label: r.name })), edit && edit.role_id, { required: true, placeholder: '选择角色' }), { req: 1 })}
      ${U.field(edit ? '重设密码（留空不改）' : '密码', U.input('password', '', { type: 'password', required: !edit }), { req: !edit })}
      ${U.field('状态', U.select('active', [{ value: 1, label: '启用' }, { value: 0, label: '停用' }], edit ? edit.active : 1))}
      <div class="full">
        <div class="subhead">参与工程（不勾选则该用户看不到任何工程）</div>
        <div class="perm-wrap">
          ${
            projects
              .map((p) => `<label class="perm"><input type="checkbox" name="projects" value="${p.id}"${members.has(p.id) ? ' checked' : ''}><span>${U.esc(p.name)}</span></label>`)
              .join('') || '<span class="muted">还没有工程</span>'
          }
        </div>
      </div>
      <div class="form-actions full"><button class="btn primary">保存</button>${edit ? '<a class="btn" href="/users">取消</a>' : ''}</div>
    </form>
  </section>
  <section class="panel"><h2>用户列表</h2>
    ${U.table(
      [{ label: '账号' }, { label: '姓名' }, { label: '岗位' }, { label: '参与工程' }, { label: '状态' }, { label: '' }],
      rows.map((u2) => [
        U.esc(u2.username), U.esc(u2.name), U.esc(u2.role_name || ''),
        seesAll(u2)
          ? '<span class="badge ok" title="拥有「全部工程可见」权限，不受工程分配限制">全部工程</span>'
          : `<span class="cell-badges">${
              memNames(u2.id).map((n) => `<span class="badge">${U.esc(n)}</span>`).join('') || '<span class="muted">未分配</span>'
            }</span>`,
        u2.active ? '<span class="badge ok">启用</span>' : '<span class="badge">停用</span>',
        `<a class="mini" href="/users?edit=${u2.id}">编辑</a>${delBtn('user', u2.id, u2.name, '用户')}`,
      ])
    )}
  </section>`;
  return page(ctx, '用户', '/users', body);
}

function saveUser(ctx) {
  const b = ctx.body;
  const id = b.id ? Number(b.id) : null;
  const username = String(b.username || '').trim();
  const name = String(b.name || '').trim();
  const roleId = b.role_id ? Number(b.role_id) : null;
  const active = b.active === '0' ? 0 : 1;
  if (!username || !name || !roleId) return err(ctx, '账号、姓名、岗位必填', '/users');
  const role = one('SELECT code FROM roles WHERE id=?', roleId);
  let uid = id;
  try {
    if (id) {
      run('UPDATE users SET username=?, name=?, role=?, role_id=?, active=? WHERE id=?', username, name, role ? role.code : null, roleId, active, id);
      if (b.password) run('UPDATE users SET password=? WHERE id=?', hashPassword(b.password), id);
    } else {
      if (!b.password) return err(ctx, '新用户必须设置密码', '/users');
      const r = run(
        'INSERT INTO users(username,password,name,role,role_id,active,created_at) VALUES(?,?,?,?,?,?,?)',
        username, hashPassword(b.password), name, role ? role.code : null, roleId, active, now()
      );
      uid = Number(r.lastInsertRowid);
    }
  } catch {
    return err(ctx, '保存失败：账号可能已存在', '/users');
  }
  run('DELETE FROM project_members WHERE user_id=?', uid);
  for (const pid of arr(b.projects).map(Number).filter(Boolean)) {
    run('INSERT OR IGNORE INTO project_members(user_id,project_id) VALUES(?,?)', uid, pid);
  }
  return ctx.flash('/users', '已保存');
}

function passwordPage(ctx) {
  const body = `
  ${msgBar(ctx)}
  <section class="panel"><h2>修改我的密码</h2>
    <form method="post" action="/password" class="form-grid">
      ${U.field('当前密码', U.input('old', '', { type: 'password', required: true }), { req: 1 })}
      ${U.field('新密码', U.input('new1', '', { type: 'password', required: true }), { req: 1 })}
      ${U.field('确认新密码', U.input('new2', '', { type: 'password', required: true }), { req: 1 })}
      <div class="form-actions full"><button class="btn primary">保存</button></div>
    </form>
  </section>`;
  return page(ctx, '修改密码', '', body);
}

function savePassword(ctx) {
  const b = ctx.body;
  const u = one('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!verifyPassword(String(b.old || ''), u.password)) return err(ctx, '当前密码不正确', '/password');
  const n1 = String(b.new1 || '');
  if (n1.length < 6) return err(ctx, '新密码至少 6 位', '/password');
  if (n1 !== String(b.new2 || '')) return err(ctx, '两次输入的新密码不一致', '/password');
  run('UPDATE users SET password=? WHERE id=?', hashPassword(n1), u.id);
  /* 改完密码把该账号在其它设备上的登录踢掉，当前这台保留 */
  const token = (/(?:^|;\s*)sid=([^;]+)/.exec(String(ctx.req.headers.cookie || '')) || [])[1] || '';
  run('DELETE FROM sessions WHERE user_id=? AND token<>?', u.id, token);
  return ctx.flash('/password', '密码已修改');
}

module.exports = {
  loginPage, handleLogin, dashboard,
  inNewPage, inCreate, inDetail, inSubmit, inVoid, inList, inItemsPage, inTemplate,
  reqNewPage, reqSave, reqDetail, reqSubmit, reqWithdraw, reqPrint, reqList, reqItemsPage,
  reqCloseLine, reqCloseRest, reqUnclose,
  outNewPage, outPickPage, outSave, outList, outItemsPage, outVoid,
  retNewPage, retPickPage, retSave, retList, retItemsPage,
  stockPage, stockOutPage, docView, exportXlsx, aiChat, apiWeather,
  majorsPage, saveMajor, projectsPage, saveProject, teamsPage, saveTeam,
  rolesPage, saveRole, createRole, usersPage, saveUser, passwordPage, savePassword,
  deleteBase,
};
