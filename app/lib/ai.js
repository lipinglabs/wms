'use strict';
/* 本系统 AI 助手：意图识别 → 只读取数/知识检索 → 交给本地 Dify 组织语言
   设计原则：数字一律来自数据库查询，模型只负责表达；查询按用户工程范围过滤 */
const { all, one, projectScope } = require('./db');
const KB = require('./kb');

const DIFY_URL = (process.env.WMS_DIFY_URL || 'http://100.72.233.97:8080').replace(/\/+$/, '');
const DIFY_KEY = process.env.WMS_DIFY_KEY || '';
const DIFY_APP_USER = 'wms';

const REFUSE = '我只能回答本系统内的收发存问题。';

/* 会话记忆：仅本次登录有效，退出登录即清空（按会话 sid 存内存） */
const HISTORY = new Map(); // sid -> [{q, a}]
const HITS = new Map(); // sid -> [ts]
/* 关键字命中的多条物资：先列出来让用户挑，记住这一轮候选以便下一句"1"能接上 */
const CHOICES = new Map(); // sid -> [row]
const MAX_TURNS = 6;
const RATE_MAX = 25;
const RATE_WINDOW = 5 * 60 * 1000;

function rateOk(sid) {
  const now = Date.now();
  const arr = (HITS.get(sid) || []).filter((t) => now - t < RATE_WINDOW);
  if (arr.length >= RATE_MAX) { HITS.set(sid, arr); return false; }
  arr.push(now);
  HITS.set(sid, arr);
  return true;
}
const remember = (sid, q, a) => {
  const arr = HISTORY.get(sid) || [];
  arr.push({ q, a });
  while (arr.length > MAX_TURNS) arr.shift();
  HISTORY.set(sid, arr);
};
const forget = (sid) => { HISTORY.delete(sid); HITS.delete(sid); CHOICES.delete(sid); };

/* ---------- 文本工具 ---------- */
const STOP = new Set(['这个', '那个', '多少', '还有', '还剩', '剩余', '现在', '目前', '怎么', '如何', '什么', '哪些', '哪个', '可以', '能不能', '是否', '我们', '我的', '一下', '请问', '帮我', '查查', '看看', '还有多少', '有多少', '还剩多少', '系统', '里面', '情况', '状态', '记录', '信息']);

function grams(q) {
  const out = new Set();
  const s = String(q || '');
  for (const w of s.match(/[A-Za-z][A-Za-z0-9\-_.\/]{1,}|\d{2,}/g) || []) out.add(w.toLowerCase());
  const cjk = s.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/).filter(Boolean);
  for (const seg of cjk) {
    for (let n = 2; n <= 6; n++) for (let i = 0; i + n <= seg.length; i++) {
      const g = seg.slice(i, i + n);
      if (!STOP.has(g)) out.add(g);
    }
  }
  return [...out];
}

const isOffTopicHint = (q) =>
  /(天气|新闻|股价|股票|汇率|彩票|笑话|写诗|作文|翻译|代码|编程|python|java|法律|律师|医疗|看病|药|投资|理财|贷款|游戏|电影|音乐|星座|算命|情感|分手|旅游|订票)/i.test(q);

const wantMyPending = (q) => /(我|俺|本人)/.test(q) && /(待出库|未出库|没出|还没|出库了吗|领的单|申请的单)/.test(q);

/* ---------- 查询（全部按用户工程范围） ---------- */
function scopeIds(user) {
  return projectScope(user).map((p) => p.id);
}

function stockRowsOf(user, ids) {
  if (!ids.length) return [];
  return all(
    `SELECT si.id, si.name, si.spec, si.unit, si.plan_no, si.arrival_date,
            pj.name AS project_name, mj.name AS major_name,
            IFNULL(SUM(m.qty),0) AS balance
     FROM stock_items si
     JOIN projects pj ON pj.id = si.project_id
     JOIN majors mj ON mj.id = si.major_id
     LEFT JOIN stock_moves m ON m.item_id = si.id
     WHERE si.active = 1 AND si.project_id IN (${ids.join(',')})
     GROUP BY si.id`
  );
}

/* 去掉疑问词/客套话，留下"用户真正想搜的东西"，例如
   "跨接线去哪了" → ["跨接线"]、"卡套" → ["卡套"] */
const CORE_STRIP =
  /(哪个队|哪支队|什么队|是谁开|谁开的|谁领的|谁申请|去哪里|去哪了|去哪|被谁|谁领走|谁领|领走了|领走|还有多少|还剩多少|有多少个|有多少|多少个|多少|怎么样|怎么|如何|是什么|什么|哪些|哪个|查一下|查查|看看|一下|请问|帮我|现在|目前|物资|材料|库存|结存|发给|给了|给谁|呢|吗|了|的|是)/g;

function coreWords(q) {
  return String(q || '')
    .replace(CORE_STRIP, ' ')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9.]+/g, ' ') // 保留小数点，"8.7"这类前缀才搜得到
    .replace(/\.+$/, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && /[\u4e00-\u9fa5A-Za-z0-9]/.test(w));
}

function matchStock(user, q, limit = 8) {
  const gs = grams(q);
  const cores = coreWords(q);
  if (!gs.length && !cores.length) return [];
  const rows = stockRowsOf(user, scopeIds(user));
  const scored = rows
    .map((r) => {
      const hay = `${r.project_name}|${r.major_name}|${r.plan_no || ''}|${r.name}|${r.spec || ''}`.toLowerCase();
      let score = 0;
      for (const g of gs) if (hay.includes(g)) score += g.length; // 长匹配权重高
      /* 核心词整体命中（如"卡套"只是"8.7直通卡套接头"的一段）直接重加权。
         这样用户不必打全名，短关键字也能搜到 */
      for (const c of cores) if (hay.includes(c.toLowerCase())) score += 10;
      return { r, score };
    })
    .filter((x) => x.score >= 4)
    .sort((a, b) => b.score - a.score || Math.abs(b.r.balance) - Math.abs(a.r.balance));
  return scored.slice(0, limit).map((x) => x.r);
}

/* 单个物资（含结存）：用于"用户正站在某个物资的明细页"这种上下文 */
function stockRowById(user, id) {
  const ids = scopeIds(user);
  if (!id || !ids.length) return null;
  return (
    all(
      `SELECT si.id, si.name, si.spec, si.unit, si.plan_no, si.arrival_date,
              pj.name AS project_name, mj.name AS major_name,
              IFNULL(SUM(m.qty),0) AS balance
       FROM stock_items si
       JOIN projects pj ON pj.id = si.project_id
       JOIN majors mj ON mj.id = si.major_id
       LEFT JOIN stock_moves m ON m.item_id = si.id
       WHERE si.id = ? AND si.active = 1 AND si.project_id IN (${ids.join(',')})
       GROUP BY si.id`,
      id
    )[0] || null
  );
}

function pendingOfUsers(user, ownOnly, limit = 10) {
  const ids = scopeIds(user);
  if (!ids.length) return [];
  const args = [];
  let extra = '';
  if (ownOnly) { extra = ' AND d.created_by = ?'; args.push(user.id); }
  return all(
    `SELECT d.id AS req_id, d.doc_no AS req_no, d.status, d.doc_date,
            pj.name AS project_name, tm.name AS team_name, u.name AS maker,
            x.name, x.spec, x.unit, x.qty,
            IFNULL((SELECT SUM(o.qty) FROM doc_items o JOIN docs od ON od.id=o.doc_id
                    WHERE od.type='OUT' AND od.status!='void' AND od.source_doc_id=d.id AND o.stock_item_id=x.stock_item_id),0) AS out_qty,
            IFNULL((SELECT SUM(c.qty) FROM req_closures c
                    WHERE c.doc_id=d.id AND c.stock_item_id=x.stock_item_id),0) AS closed_qty
     FROM doc_items x
     JOIN docs d ON d.id = x.doc_id
     LEFT JOIN projects pj ON pj.id = d.project_id
     LEFT JOIN teams tm ON tm.id = d.team_id
     LEFT JOIN users u ON u.id = d.created_by
     WHERE d.type='REQ' AND d.status IN ('submitted','part')
       AND d.project_id IN (${ids.join(',')})${extra}
     ORDER BY d.id DESC
     LIMIT 60`,
    ...args
  )
    .filter((r) => Number(r.qty) - Number(r.out_qty) - Number(r.closed_qty) > 1e-9)
    .slice(0, limit);
}

function docLookup(user, docNo) {
  const ids = scopeIds(user);
  if (!ids.length) return null;
  const d = one(
    `SELECT d.*, pj.name AS project_name, mj.name AS major_name, tm.name AS team_name, u.name AS maker,
            s.doc_no AS source_no
     FROM docs d
     LEFT JOIN projects pj ON pj.id=d.project_id
     LEFT JOIN majors mj ON mj.id=d.major_id
     LEFT JOIN teams tm ON tm.id=d.team_id
     LEFT JOIN users u ON u.id=d.created_by
     LEFT JOIN docs s ON s.id=d.source_doc_id
     WHERE d.doc_no = ? AND d.project_id IN (${ids.join(',')})`,
    docNo
  );
  if (!d) return null;
  d.items = all('SELECT * FROM doc_items WHERE doc_id=? ORDER BY seq', d.id);
  return d;
}

/* 物资去向：列出该批次每一笔出库/退库（谁、哪支队伍、哪张单、多少） */
function movesOf(user, items) {
  if (!items.length) return [];
  const ids = items.map((i) => i.id).join(',');
  return all(
    `SELECT sm.item_id, sm.doc_type, sm.qty, sm.doc_date, od.doc_no AS doc_no,
            s.doc_no AS req_no, ru.name AS req_maker, s.doc_date AS req_date,
            tm.name AS team_name, u.name AS by_name, od.id AS doc_id
     FROM stock_moves sm
     JOIN docs od ON od.id = sm.doc_id
     LEFT JOIN docs s ON s.id = od.source_doc_id
     LEFT JOIN users ru ON ru.id = s.created_by
     LEFT JOIN teams tm ON tm.id = od.team_id
     LEFT JOIN users u ON u.id = od.created_by
     WHERE sm.item_id IN (${ids}) AND sm.doc_type IN ('OUT','RET')
     ORDER BY sm.doc_date, sm.id
     LIMIT 60`
  );
}

/* 按物资分组输出，避免"堵头"这类同名多规格的流水混在一起；
   口径与库存页的「出库明细」一致：累计出库 / 累计退库 / 净出库 */
function traceText(items, moves) {
  if (!items.length) return '（没有匹配到物资）';
  const blocks = items.map((it) => {
    const mine = moves.filter((m) => m.item_id === it.id);
    const title = `物资：${it.name}${it.spec ? '｜规格 ' + it.spec : ''}${it.unit ? '｜单位 ' + it.unit : ''}`;
    if (!mine.length) return title + '\n（该物资还没有出库或退库记录）';
    const out = mine.filter((m) => m.doc_type === 'OUT').reduce((s, m) => s + Math.abs(Number(m.qty) || 0), 0);
    const ret = mine.filter((m) => m.doc_type === 'RET').reduce((s, m) => s + Math.abs(Number(m.qty) || 0), 0);
    const body = mine
      .map((m) => {
        const docName = m.doc_type === 'OUT' ? '出库单' : '退料单';
        const reqPart = m.req_no
          ? `｜领料单 ${m.req_no}${m.req_maker ? '（开单 ' + m.req_maker + '）' : ''}`
          : '｜无关联领料单';
        return `- ${m.doc_type === 'OUT' ? '出库' : '退库'} ${m.doc_date}｜${docName} ${m.doc_no}${reqPart}｜领用队伍 ${m.team_name || '—'}｜${Math.abs(Number(m.qty))} ${it.unit || ''}｜出库经办 ${m.by_name || '—'}`;
      })
      .join('\n');
    return `${title}\n累计出库 ${out}，累计退库 ${ret}，净出库 ${out - ret}\n${body}`;
  });
  return blocks.join('\n\n');
}

/* ---------- 知识检索（关键词命中打分，取前 3） ---------- */
function matchKB(q, limit = 3) {
  const s = String(q || '');
  const scored = KB.map((e) => {
    let score = 0;
    for (const k of e.k) if (s.includes(k)) score += k.length * 2;
    if (s.includes(e.t)) score += 6;
    for (const ch of s) if (e.t.includes(ch)) score += 0.3;
    return { e, score };
  })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.e);
}

/* ---------- 组装 ---------- */
const TYPE_NAME = { IN: '入库单', REQ: '领料申请单', OUT: '出库单', RET: '退料单' };
const STATUS_NAME = { draft: '保存', submitted: '已提交', part: '部分出库', closed: '已出库', void: '已作废' };

function stockText(rows) {
  if (!rows.length) return '（无匹配库存）';
  return rows
    .map((r) => `工程：${r.project_name}｜专业：${r.major_name}｜计划编号：${r.plan_no || '无'}｜物资：${r.name}｜规格：${r.spec || '无'}｜结存：${r.balance} ${r.unit}｜到货：${r.arrival_date || '—'}`)
    .join('\n');
}
function pendingText(rows) {
  if (!rows.length) return '（没有待出库的领料单）';
  return rows
    .map((r) => `领料单：${r.req_no}（${STATUS_NAME[r.status] || r.status}）｜工程：${r.project_name}｜队伍：${r.team_name || '—'}｜物资：${r.name} ${r.spec || ''}｜申请：${r.qty} ${r.unit}｜已出：${r.out_qty}${Number(r.closed_qty) > 0 ? '｜放弃领用：' + r.closed_qty : ''}｜待出：${Number(r.qty) - Number(r.out_qty) - Number(r.closed_qty)}｜制单：${r.maker || '—'}`)
    .join('\n');
}
function docText(d) {
  const head = `单据号：${d.doc_no}｜类型：${TYPE_NAME[d.type] || d.type}｜状态：${STATUS_NAME[d.status] || d.status}｜日期：${d.doc_date}｜工程：${d.project_name || '—'}｜专业：${d.major_name || '—'}${d.team_name ? '｜领料单位：' + d.team_name : ''}${d.source_no ? '｜关联领料单：' + d.source_no : ''}｜制单：${d.maker || '—'}`;
  const items = d.items.map((x, i) => `  ${i + 1}. ${x.name} ${x.spec || ''}｜${x.qty} ${x.unit}｜计划编号：${x.plan_no || '无'}`).join('\n');
  return head + '\n' + items;
}

/* ---------- 按人查领用 ---------- */
function findPerson(user, text) {
  const s = String(text || '');
  return all('SELECT id, username, name FROM users WHERE active = 1')
    .filter((u) => {
      if (u.name && u.name.length >= 2 && s.includes(u.name)) return true;
      if (u.username && u.username.length >= 3 && s.toLowerCase().includes(String(u.username).toLowerCase())) return true;
      return false;
    })
    .slice(0, 1);
}

function personDocs(user, uid, limit = 8) {
  const ids = scopeIds(user);
  if (!ids.length) return [];
  const docs = all(
    `SELECT d.id, d.doc_no, d.type, d.status, d.doc_date,
            pj.name AS project_name, tm.name AS team_name
     FROM docs d
     LEFT JOIN projects pj ON pj.id = d.project_id
     LEFT JOIN teams tm ON tm.id = d.team_id
     WHERE d.created_by = ? AND d.project_id IN (${ids.join(',')}) AND d.status <> 'void'
     ORDER BY d.doc_date DESC, d.id DESC
     LIMIT ${limit}`,
    uid
  );
  for (const d of docs) {
    d.items = all('SELECT name, spec, qty, unit FROM doc_items WHERE doc_id = ? ORDER BY seq LIMIT 5', d.id);
    d.itemCount = one('SELECT COUNT(*) n FROM doc_items WHERE doc_id = ?', d.id).n;
  }
  return docs;
}

function personText(person, docs) {
  if (!docs.length) return `${person.name}名下没有单据记录（没有他制单的入库、领料、出库或退料单）。`;
  const body = docs
    .map((d) => {
      const its = d.items.map((x) => `${x.name}${x.spec ? ' ' + x.spec : ''}×${x.qty}${x.unit}`).join('、');
      const more = d.itemCount > d.items.length ? ` 等 ${d.itemCount} 项` : '';
      return `${TYPE_NAME[d.type] || d.type} ${d.doc_no}（${STATUS_NAME[d.status] || d.status}）${d.doc_date}｜工程 ${d.project_name || '—'}｜队伍 ${d.team_name || '—'}｜${its}${more}`;
    })
    .join('\n');
  return `${person.name} 最近 ${docs.length} 张单据：\n${body}`;
}

/* ---------- 库存汇总（问"多少种/合计/统计"这类整体口径） ---------- */
function aggText(user) {
  const rows = stockRowsOf(user, scopeIds(user));
  if (!rows.length) return '（当前范围内没有在库物资）';
  const byUnit = new Map();
  const byProject = new Map();
  let zero = 0;
  for (const r of rows) {
    const u = r.unit || '—';
    const n = Number(r.balance || 0);
    byUnit.set(u, (byUnit.get(u) || 0) + n);
    if (Math.abs(n) < 1e-9) zero += 1;
    const p = byProject.get(r.project_name) || { kinds: 0, units: new Map() };
    p.kinds += 1;
    p.units.set(u, (p.units.get(u) || 0) + n);
    byProject.set(r.project_name, p);
  }
  const unitStr = [...byUnit.entries()].map(([u, v]) => `${Number(v.toFixed(3))} ${u}`).join('、');
  const projStr = [...byProject.entries()]
    .map(([p, v]) => `${p} ${v.kinds} 种（${[...v.units.entries()].map(([u, n]) => `${Number(n.toFixed(3))} ${u}`).join('、')}）`)
    .join('；');
  const body = rows
    .slice(0, 10)
    .map((r) => `${r.project_name}｜${r.name} ${r.spec || ''}｜结存 ${r.balance} ${r.unit}`)
    .join('\n');
  return `物资种类：${rows.length} 种（其中结存为 0 的 ${zero} 种）\n结存合计：${unitStr}\n按工程：${projStr}\n主要物资：\n${body}`;
}

/* ---------- 关键字命中多条：列候选让用户挑 ---------- */
function choicesText(rows, kw) {
  const head = `按「${kw}」匹配到 ${rows.length} 条物资，尚未确定是哪一条，所以还没有领用人/单据信息：`;
  const body = rows
    .slice(0, 8)
    .map((r, i) => `${i + 1}. ${r.name}${r.spec ? '（' + r.spec + '）' : ''}｜工程：${r.project_name}｜结存 ${r.balance} ${r.unit}`)
    .join('\n');
  return `${head}\n${body}\n\n请用户回复序号（如「1」）或补充规格，选定后再查该物资的领用、出库与退库记录。`;
}

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/* 上一轮列过候选，这一句如果是序号就接着答 */
function resolveChoice(sid, text) {
  const arr = sid ? CHOICES.get(sid) : null;
  if (!arr || !arr.length) return null;
  const t = String(text || '').trim();
  const m = /^([1-9])$/.exec(t) || /^第?([一二三四五六七八九])$/.exec(t);
  if (!m) return null;
  const idx = (/[1-9]/.test(m[1]) ? Number(m[1]) : CN_NUM[m[1]]) - 1;
  return arr[idx] || null;
}

/* 选定单个物资后的回答（含结存） */
function answerOne(user, it) {
  const mv = movesOf(user, [it]);
  return { kind: 'trace', data: { items: [it], moves: mv }, text: traceText([it], mv) + '\n\n当前结存：\n' + stockText([it]) };
}

function route(user, q, page) {
  const text = String(q || '').trim();
  if (!text) return { kind: 'empty' };
  const noMatch = /\b((RK|LL|CK|TL)-[A-Za-z0-9\-]+)/i.exec(text);
  if (noMatch) {
    const d = docLookup(user, noMatch[1].toUpperCase());
    if (d) return { kind: 'doc', data: d, text: docText(d) };
    return { kind: 'doc-miss', text: `（没有查到单号 ${noMatch[1]}）` };
  }
  const docs = matchKB(text, 3);
  if (wantMyPending(text)) {
    const rows = pendingOfUsers(user, true);
    return { kind: 'pending', data: rows, docs, text: pendingText(rows) };
  }
  /* 想问"物资流向/谁动过"的各种说法：发出去、领了多少、谁开的料单、哪支队领的 */
  const wantsTrace =
    /(被谁|谁领|领走|去哪|用到哪|去向|领用记录|出库明细|给谁|发出去|发出|发了|发料|领出去|领用|谁开|开单|开料|制单|谁制|申请人|申请的|哪张单|哪个单|出库记录|退库记录|领了多少|出了多少|哪个队|什么队|谁办|经办)/.test(
      text
    );
  const wantsStock = /(库存|结存|剩|还有|多少|余量|有没有|有没有货|在哪|哪里|哪儿|位置)/.test(text);
  const rows = matchStock(user, text);
  /* 页面上下文：用户正站在某个物资的「出库明细」页提问时，按该物资解释（名字没打全也能答） */
  const pinned = page && page.item_id ? stockRowById(user, Number(page.item_id)) : null;
  const target = rows.length ? rows : pinned ? [pinned] : [];
  /* 关键字命中多条：先列候选让用户挑，避免几支物资的流水混在一起答 */
  if (target.length > 2 && (wantsTrace || wantsStock || !docs.length) && !/(都|全部|所有|各|分别|每条|每个)/.test(text)) {
    return { kind: 'choices', data: target, docs, text: choicesText(target, text) };
  }
  if (target.length && wantsTrace) {
    const mv = movesOf(user, target);
    return { kind: 'trace', data: { items: target, moves: mv }, docs, text: traceText(target, mv) + '\n\n当前结存：\n' + stockText(target) };
  }
  if (target.length && (wantsStock || !docs.length)) return { kind: 'stock', data: target, docs, text: stockText(target) };

  /* 按人查领用：放在物资匹配之后，避免把工程名/物资名里的人名当成提问对象 */
  const asksPerson = /(领|拿|出库|申请|要了|用了|单据|记录|领料)/.test(text) && !/(我|俺|本人)/.test(text);
  if (asksPerson) {
    const ps = findPerson(user, text);
    if (ps.length) {
      const pd = personDocs(user, ps[0].id);
      return { kind: 'person', data: { person: ps[0], docs: pd }, docs, text: personText(ps[0], pd) };
    }
  }

  /* 库存汇总：问"多少种/合计/统计"这类整体口径，数字由 SQL 汇总后给出 */
  if (/(多少种|几种|种类|总数|合计|总共|一共|统计|汇总|盘点)/.test(text) && /(库存|物资|材料|结存|在库)/.test(text)) {
    return { kind: 'agg', docs, text: aggText(user) };
  }

  if (/(待出库|未出库|没出库|还没出|出库了吗)/.test(text)) {
    const pr = pendingOfUsers(user, /(我|俺)/.test(text));
    return { kind: 'pending', data: pr, docs, text: pendingText(pr) };
  }
  if (docs.length) return { kind: 'kb', docs, text: '' };
  if (isOffTopicHint(text)) return { kind: 'offtopic' };
  return { kind: 'unknown' };
}

function fallbackAnswer(r) {
  switch (r.kind) {
    case 'kb': return (r.docs || []).slice(0, 1).map((d) => d.a).join('\n');
    case 'stock': return '查到以下库存：\n' + (r.text || '');
    case 'pending': return '待出库的领料单：\n' + (r.text || '');
    case 'doc': return r.text || '';
    case 'doc-miss': return r.text || '';
    case 'trace': return '物资去向：\n' + (r.text || '');
    case 'choices': return r.text || '';
    case 'person': return r.text || '';
    case 'agg': return '库存汇总：\n' + (r.text || '');
    default: return REFUSE;
  }
}

function buildQuery(r, q) {
  const parts = [];
  if (r.docs && r.docs.length) {
    parts.push('【系统资料】\n' + r.docs.map((d, i) => `${i + 1}. ${d.t}：${d.a}`).join('\n'));
  }
  const today = new Date().toISOString().slice(0, 10);
  parts.push(`【系统时间】${today}`);
  if (r.text) parts.push('【查询结果】\n' + r.text);
  else parts.push('【查询结果】（无）');
  parts.push('【回答要求】只能使用上面【查询结果】里实际出现的数据；单据号、数量、人名、日期一律不得编造或推测。注意区分字段：物资名称、工程名称、人名（经办人/开单人）、领用队伍是四类不同的东西，不要混着说。查询结果里没有的，就直说没查到，并说明可以在哪个页面怎么查。');
  parts.push('【问题】\n' + q);
  return parts.join('\n\n');
}

const stripThink = (s) =>
  String(s || '')
    .replace(/<!--\s*dify-deepseek-reasoning\s*-->/g, '')
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();

/* 熔断：模型服务连不上时，60 秒内直接走降级答案，避免每次都等超时 */
let DOWN_UNTIL = 0;
const breakerOpen = () => Date.now() < DOWN_UNTIL;
const trip = () => { DOWN_UNTIL = Date.now() + 60000; };

async function callDify(query, userName) {
  if (!DIFY_KEY) return { error: '未配置模型密钥' };
  if (breakerOpen()) return { error: '模型服务暂时不可用' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(DIFY_URL + '/v1/chat-messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + DIFY_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: {}, query, response_mode: 'blocking', user: DIFY_APP_USER + '-' + userName }),
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { trip(); return { error: (j && (j.message || j.code)) || 'HTTP ' + res.status }; }
    return { answer: stripThink(j.answer), usage: (j.metadata && j.metadata.usage) || null, convId: j.conversation_id };
  } catch (e) {
    trip();
    return { error: e.name === 'AbortError' ? '模型响应超时' : e.message || '无法连接模型服务' };
  } finally {
    clearTimeout(timer);
  }
}

async function ask(user, question, sid, page) {
  const t0 = Date.now();
  if (sid && !rateOk(sid)) return { ok: false, msg: '提问太频繁，请稍后再试' };
  /* 上一轮列过"匹配到 N 条"，这一句回个序号就直接答那一条 */
  const chosen = sid ? resolveChoice(sid, question) : null;
  const r = chosen ? answerOne(user, chosen) : route(user, question, page);
  if (sid) {
    if (r.kind === 'choices') CHOICES.set(sid, r.data);
    else if (r.kind !== 'empty') CHOICES.delete(sid);
  }
  if (r.kind === 'empty') return { ok: false, msg: '请先输入问题' };
  if (r.kind === 'offtopic') return { ok: true, answer: REFUSE, kind: 'offtopic', ms: Date.now() - t0 };
  if (r.kind === 'unknown') return { ok: true, answer: REFUSE, kind: 'unknown', ms: Date.now() - t0 };

  let query = buildQuery(r, question);
  const hist = sid ? HISTORY.get(sid) || [] : [];
  if (hist.length) {
    const ctxText = hist.slice(-2).map((h) => `问：${h.q}\n答：${String(h.a).slice(0, 200)}`).join('\n');
    query = '【上文】\n' + ctxText + '\n\n' + query;
  }
  const ai = await callDify(query, user.username || String(user.id));
  if (ai.error) {
    return {
      ok: true,
      answer: fallbackAnswer(r) + `\n\n（AI 表述服务暂不可用：${ai.error}，以上为系统直接查询结果）`,
      kind: r.kind,
      degraded: true,
      ms: Date.now() - t0,
    };
  }
  const answer = ai.answer || fallbackAnswer(r);
  if (sid) remember(sid, question, answer);
  return { ok: true, answer, kind: r.kind, usage: ai.usage, ms: Date.now() - t0 };
}

module.exports = { ask, route, forget, REFUSE, DIFY_URL };
