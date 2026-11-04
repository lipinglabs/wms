'use strict';
const fs = require('fs');
const path = require('path');
const { DOC_TYPES, STATUS } = require('./db');
const { can } = require('./auth');

/* 静态资源版本号：取 app.js / app.css 的最后修改时间，改完前端不用手动改版本号也能刷新缓存 */
const assetVer = () => {
  try {
    const p = path.join(__dirname, '..', 'public');
    return String(Math.floor(Math.max(fs.statSync(path.join(p, 'app.js')).mtimeMs, fs.statSync(path.join(p, 'app.css')).mtimeMs)));
  } catch (e) {
    return '1';
  }
};

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const num = (v) => {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
};

function navItems(user) {
  const items = [
    { href: '/', label: '工作台', icon: '◧' },
    { href: '/in/new', label: '入库登记', icon: '↓', perm: 'in.create' },
    { href: '/in/list', label: '入库查询', icon: '≡', perm: 'in.view' },
    { href: '/in/items', label: '入库明细', icon: '☰', perm: 'in.view' },
    { href: '/req/new', label: '领用登记', icon: '⇤', perm: 'req.create' },
    { href: '/req/list', label: '领用查询', icon: '⌕', perm: 'req.view' },
    { href: '/req/items', label: '领用明细', icon: '☰', perm: 'req.items' },
    { href: '/out/new', label: '出库登记', icon: '↑', perm: 'out.create' },
    { href: '/out/list', label: '出库查询', icon: '↥', perm: 'out.view' },
    { href: '/out/items', label: '出库明细', icon: '☰', perm: 'out.items' },
    { href: '/ret/new', label: '退料登记', icon: '↩', perm: 'ret.create' },
    { href: '/ret/list', label: '退料查询', icon: '↺', perm: 'ret.view' },
    { href: '/ret/items', label: '退库明细', icon: '☰', perm: 'ret.items' },
    { href: '/stock', label: '库存', icon: '▤', perm: 'stock.view' },
    { href: '/projects', label: '工程', icon: '◈', perm: 'base.project' },
    { href: '/majors', label: '专业', icon: '◇', perm: 'base.major' },
    { href: '/teams', label: '施工队伍', icon: '⛃', perm: 'base.team' },
    { href: '/roles', label: '角色权限', icon: '⚿', perm: 'sys.role' },
    { href: '/users', label: '用户', icon: '☺', perm: 'sys.user' },
    { href: '/logs', label: '日志', icon: '☷', perm: 'sys.log' },
  ];
  return items.filter((i) => !i.perm || can(user, i.perm));
}

function layout({ title, user, active, body, wide, topRight }) {
  const nav = user
    ? navItems(user)
        .map((i) => `<a class="nav-item${active === i.href ? ' active' : ''}" href="${i.href}"><span class="nav-ico">${i.icon}</span>${esc(i.label)}</a>`)
        .join('')
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 龙口海工项目部</title>
<link rel="icon" href="/logo.png">
<link rel="stylesheet" href="/app.css?v=${assetVer()}">
</head><body>
<div class="shell${wide ? ' wide' : ''}">
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark"><img src="/logo.png" alt="龙口海工项目部"></span><div><b>龙口海工项目部</b><small>收发存管理系统</small></div></div>
    <nav>${nav}</nav>
    ${user ? `<div class="me"><div class="me-name">${esc(user.name)}</div><div class="me-role">${esc(roleName(user))}</div><div class="me-links"><a href="/password">修改密码</a><a href="/logout">退出登录</a></div></div>` : ''}
  </aside>
  <main class="main"><header class="topbar"><h1>${esc(title)}</h1><div class="topbar-right"><span class="wx" id="wx-slot" role="button" tabindex="0" hidden></span>${topRight ? `<span class="top-extra">${topRight}</span>` : ''}${user ? `<span class="top-user">${esc(user.name)} · ${esc(roleName(user))}</span>` : ''}</div></header>
  <div class="content"><div class="wm" aria-hidden="true"><span>富强　民主　文明　和谐</span><span>自由　平等　公正　法治</span><span>爱国　敬业　诚信　友善</span></div>${body}</div></main>
</div>
${user ? aiWidget() : ''}
<script src="/app.js?v=${assetVer()}"></script>
</body></html>`;
}

/* 右下角 AI 悬浮球与对话面板（登录后显示） */
function aiWidget() {
  return `
<div class="ai-root">
  <button type="button" class="ai-ball" id="ai-ball" aria-label="打开 AI 助手"><span class="ai-txt"><i>A</i><i>I</i></span></button>
  <section class="ai-panel" id="ai-panel" hidden aria-label="AI 助手">
    <header class="ai-head">
      <div><b>物资系统助手</b><small>只回答本系统内的收发存问题</small></div>
      <button type="button" class="ai-close" id="ai-close" aria-label="关闭">×</button>
    </header>
    <div class="ai-ctx" id="ai-ctx" hidden></div>
    <div class="ai-log" id="ai-log">
      <div class="ai-msg bot">
        <div class="ai-bubble">你好，我可以回答本系统的库存、在途领用、单据状态和操作规则。你可以直接问，比如“赵东工程还剩多少跨接线”。</div>
      </div>
      <div class="ai-chips" id="ai-chips">
        <button type="button">还剩多少库存</button>
        <button type="button">我的领料单出库了吗</button>
        <button type="button">领料单提交后能改吗</button>
        <button type="button">退库怎么操作</button>
      </div>
    </div>
    <form class="ai-input" id="ai-form">
      <textarea id="ai-text" rows="1" placeholder="问本系统的收发存问题…" maxlength="300"></textarea>
      <button type="submit" id="ai-send">发送</button>
    </form>
  </section>
</div>`;
}

function roleName(u) {
  if (!u) return '';
  if (typeof u === 'string') return { admin: '管理员', keeper: '仓管员', picker: '领料员', viewer: '只读' }[u] || u;
  return u.role_name || u.role || '';
}

function docTypeName(t) {
  return (DOC_TYPES[t] && DOC_TYPES[t].name) || t;
}

function statusBadge(s) {
  const m = STATUS[s] || { name: s, cls: 'draft' };
  return `<span class="badge ${m.cls}">${esc(m.name)}</span>`;
}

function table(headers, rows, opt = {}) {
  const th = headers
    .map((h) => {
      const label = typeof h === 'string' ? h : h.label || '';
      const cls = h && h.align ? ` class="${h.align}"` : '';
      const w = h && h.width ? ` style="width:${h.width}"` : '';
      return `<th${cls}${w}>${esc(label)}</th>`;
    })
    .join('');
  const tb = rows
    .map(
      (r) =>
        '<tr>' +
        r
          .map((c, i) => {
            const align = headers[i] && headers[i].align ? ' class="' + headers[i].align + '"' : '';
            return `<td${align}>${c == null ? '' : c}</td>`;
          })
          .join('') +
        '</tr>'
    )
    .join('');
  const empty = rows.length === 0 ? `<tr><td colspan="${headers.length}" class="empty">${esc(opt.empty || '暂无数据')}</td></tr>` : '';
  return `<div class="table-wrap"><table class="grid"><thead><tr>${th}</tr></thead><tbody>${tb}${empty}</tbody></table></div>`;
}

function flash(msg, type) {
  if (!msg) return '';
  return `<div class="flash ${type || 'ok'}">${esc(msg)}</div>`;
}

function field(label, inner, opt = {}) {
  return `<label class="field${opt.full ? ' full' : ''}"><span>${esc(label)}${opt.req ? '<i>*</i>' : ''}</span>${inner}</label>`;
}

function input(name, value, opt = {}) {
  const attrs = [
    `name="${name}"`,
    `value="${esc(value == null ? '' : value)}"`,
    opt.type ? `type="${opt.type}"` : '',
    opt.required ? 'required' : '',
    opt.placeholder ? `placeholder="${esc(opt.placeholder)}"` : '',
    opt.step ? `step="${opt.step}"` : '',
    opt.min != null ? `min="${opt.min}"` : '',
    opt.readonly ? 'readonly' : '',
    opt.cls ? `class="${opt.cls}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<input ${attrs}>`;
}

function select(name, options, value, opt = {}) {
  const opts = options
    .map((o) => {
      const v = typeof o === 'object' ? o.value : o;
      const l = typeof o === 'object' ? o.label : o;
      return `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`;
    })
    .join('');
  return `<select name="${name}"${opt.required ? ' required' : ''}>${opt.placeholder ? `<option value="">${esc(opt.placeholder)}</option>` : ''}${opts}</select>`;
}

module.exports = { esc, num, layout, table, flash, field, input, select, roleName, docTypeName, statusBadge, navItems };
