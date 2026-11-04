'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { migrate } = require('./lib/db');
const { getUserByToken, destroySession, can } = require('./lib/auth');
const R = require('./lib/routes');
const U = require('./lib/ui');
const throttle = require('./lib/throttle');

function clientIp(req) {
  const x = req.headers['x-forwarded-for'];
  if (x) return String(x).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' blob:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
  );
  if (String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

migrate();

const { db: SQLDB, DATA_DIR } = require('./lib/db');
const backup = require('./lib/backup');
backup.schedule(SQLDB, DATA_DIR, __dirname, (m) => console.log(m));

const PORT = Number(process.env.WMS_PORT || 8099);
const HOST = process.env.WMS_HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
};

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

/* multipart/form-data 解析（单文件 + 普通字段），零依赖 */
function parseMultipart(buf, boundary) {
  const out = {};
  const delim = Buffer.from('--' + boundary);
  let pos = 0;
  while (true) {
    const start = buf.indexOf(delim, pos);
    if (start < 0) break;
    const after = start + delim.length;
    if (buf.slice(after, after + 2).toString() === '--') break;
    const headEnd = buf.indexOf(Buffer.from('\r\n\r\n'), after);
    if (headEnd < 0) break;
    const headerText = buf.slice(after + 2, headEnd).toString('utf8');
    const nextDelim = buf.indexOf(delim, headEnd);
    const bodyEnd = nextDelim < 0 ? buf.length : nextDelim - 2; // 去掉尾部 \r\n
    const body = buf.slice(headEnd + 4, bodyEnd);
    const nameM = /name="([^"]+)"/.exec(headerText);
    const fileM = /filename="([^"]*)"/.exec(headerText);
    if (nameM) {
      const name = nameM[1];
      if (fileM) {
        if (fileM[1]) out.__file = { filename: fileM[1], buffer: body };
      } else {
        out[name] = body.toString('utf8');
      }
    }
    pos = nextDelim < 0 ? buf.length : nextDelim;
  }
  return out;
}

function readRaw(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

async function parseBody(req) {
  const raw = await readRaw(req);
  if (!raw.length) return {};
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('multipart/form-data')) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    if (!m) return {};
    return parseMultipart(raw, (m[1] || m[2]).trim());
  }
  const out = {};
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw.toString('utf8')); } catch { return {}; }
  }
  for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) {
    if (k in out) {
      if (!Array.isArray(out[k])) out[k] = [out[k]];
      out[k].push(v);
    } else out[k] = v;
  }
  return out;
}

const ROUTES = [
  { m: 'GET', p: /^\/login$/, h: (c) => c.html(R.loginPage(c)), open: true },
  { m: 'POST', p: /^\/login$/, h: R.handleLogin, open: true },
  { m: 'GET', p: /^\/logout$/, h: (c) => c.logout(), open: true },

  { m: 'GET', p: /^\/$/, h: R.dashboard },
  { m: 'GET', p: /^\/password$/, h: R.passwordPage },
  { m: 'POST', p: /^\/password$/, h: R.savePassword },

  { m: 'GET', p: /^\/in$/, h: (c) => c.redirect('/in/list') },
  { m: 'GET', p: /^\/in\/new$/, h: R.inNewPage, perm: 'in.create' },
  { m: 'POST', p: /^\/in\/create$/, h: R.inCreate, perm: 'in.create' },
  { m: 'GET', p: /^\/in\/template$/, h: R.inTemplate, perm: 'in.create' },
  { m: 'GET', p: /^\/in\/list$/, h: R.inList, perm: 'in.view' },
  { m: 'GET', p: /^\/in\/items$/, h: R.inItemsPage, perm: 'in.view' },
  { m: 'GET', p: /^\/in\/(\d+)$/, h: (c, m) => R.inDetail(c, Number(m[1])), perm: 'in.view' },
  { m: 'POST', p: /^\/in\/(\d+)\/submit$/, h: (c, m) => R.inSubmit(c, Number(m[1])), perm: 'in.create' },
  { m: 'POST', p: /^\/in\/(\d+)\/void$/, h: (c, m) => R.inVoid(c, Number(m[1])), perm: 'in.view' },

  { m: 'GET', p: /^\/req\/new$/, h: R.reqNewPage, perm: 'req.create' },
  { m: 'POST', p: /^\/req\/save$/, h: R.reqSave, perm: 'req.create' },
  { m: 'GET', p: /^\/req\/list$/, h: R.reqList, perm: 'req.view' },
  { m: 'GET', p: /^\/req\/items$/, h: R.reqItemsPage, perm: 'req.items' },
  { m: 'GET', p: /^\/req\/(\d+)$/, h: (c, m) => R.reqDetail(c, Number(m[1])), perm: 'req.view' },
  { m: 'POST', p: /^\/req\/(\d+)\/submit$/, h: (c, m) => R.reqSubmit(c, Number(m[1])), perm: 'req.create' },
  { m: 'POST', p: /^\/req\/(\d+)\/withdraw$/, h: (c, m) => R.reqWithdraw(c, Number(m[1])), perm: 'req.view' },
  { m: 'POST', p: /^\/req\/(\d+)\/close-line$/, h: (c, m) => R.reqCloseLine(c, Number(m[1])), perm: ['doc.admin', 'req.create'] },
  { m: 'POST', p: /^\/req\/(\d+)\/close-rest$/, h: (c, m) => R.reqCloseRest(c, Number(m[1])), perm: ['doc.admin', 'req.create'] },
  { m: 'POST', p: /^\/req\/(\d+)\/unclose$/, h: (c, m) => R.reqUnclose(c, Number(m[1])), perm: ['doc.admin', 'req.create'] },
  { m: 'GET', p: /^\/req\/(\d+)\/print$/, h: (c, m) => R.reqPrint(c, Number(m[1])), perm: 'req.print' },

  { m: 'GET', p: /^\/out\/new$/, h: R.outNewPage, perm: 'out.create' },
  { m: 'POST', p: /^\/out\/save$/, h: R.outSave, perm: 'out.create' },
  { m: 'GET', p: /^\/out\/list$/, h: R.outList, perm: 'out.view' },
  { m: 'GET', p: /^\/out\/items$/, h: R.outItemsPage, perm: 'out.items' },
  { m: 'GET', p: /^\/out\/(\d+)$/, h: (c, m) => R.outPickPage(c, Number(m[1])), perm: 'out.create' },
  { m: 'POST', p: /^\/out\/(\d+)\/void$/, h: (c, m) => R.outVoid(c, Number(m[1])), perm: 'doc.admin' },

  { m: 'GET', p: /^\/ret\/new$/, h: R.retNewPage, perm: 'ret.create' },
  { m: 'POST', p: /^\/ret\/save$/, h: R.retSave, perm: 'ret.create' },
  { m: 'GET', p: /^\/ret\/list$/, h: R.retList, perm: 'ret.view' },
  { m: 'GET', p: /^\/ret\/items$/, h: R.retItemsPage, perm: 'ret.items' },
  { m: 'GET', p: /^\/ret\/(\d+)$/, h: (c, m) => R.retPickPage(c, Number(m[1])), perm: 'ret.create' },

  { m: 'GET', p: /^\/stock$/, h: R.stockPage, perm: 'stock.view' },
  { m: 'GET', p: /^\/stock\/(\d+)\/outs$/, h: (c, m) => R.stockOutPage(c, Number(m[1])), perm: 'stock.view' },
  { m: 'GET', p: /^\/doc\/(\d+)$/, h: (c, m) => R.docView(c, Number(m[1])) },
  { m: 'POST', p: /^\/api\/ai\/chat$/, h: R.aiChat },
  { m: 'GET', p: /^\/api\/weather$/, h: R.apiWeather },
  { m: 'GET', p: /^\/export$/, h: R.exportXlsx, perm: 'export.xlsx' },

  { m: 'POST', p: /^\/base\/delete$/, h: R.deleteBase },
  { m: 'GET', p: /^\/projects$/, h: R.projectsPage, perm: 'base.project' },
  { m: 'POST', p: /^\/projects\/save$/, h: R.saveProject, perm: 'base.project' },
  { m: 'GET', p: /^\/majors$/, h: R.majorsPage, perm: 'base.major' },
  { m: 'POST', p: /^\/majors\/save$/, h: R.saveMajor, perm: 'base.major' },
  { m: 'GET', p: /^\/teams$/, h: R.teamsPage, perm: 'base.team' },
  { m: 'POST', p: /^\/teams\/save$/, h: R.saveTeam, perm: 'base.team' },
  { m: 'GET', p: /^\/roles$/, h: R.rolesPage, perm: 'sys.role' },
  { m: 'POST', p: /^\/roles\/create$/, h: R.createRole, perm: 'sys.role' },
  { m: 'POST', p: /^\/roles\/save$/, h: R.saveRole, perm: 'sys.role' },
  { m: 'GET', p: /^\/users$/, h: R.usersPage, perm: 'sys.user' },
  { m: 'POST', p: /^\/users\/save$/, h: R.saveUser, perm: 'sys.user' },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  securityHeaders(req, res);

  if (pathname.startsWith('/')) {
    const file = path.join(PUBLIC, pathname.replace(/^\/+/, ''));
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }
  }

  const cookies = parseCookies(req);
  const user = getUserByToken(cookies.sid);

  const ctx = {
    req,
    res,
    ip: clientIp(req),
    throttle,
    query: Object.fromEntries(url.searchParams),
    user,
    body: {},
    setCookie(name, value, opt = {}) {
      const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
      if (opt.httpOnly !== false) parts.push('HttpOnly');
      parts.push('SameSite=' + (opt.sameSite || 'Lax'));
      if (opt.maxAge) parts.push(`Max-Age=${opt.maxAge}`);
      const fwd = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
      if (fwd === 'https') parts.push('Secure');
      res.setHeader('Set-Cookie', parts.join('; '));
    },
    json(obj, status = 200) {
      const buf = Buffer.from(JSON.stringify(obj), 'utf8');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      res.end(buf);
    },
    html(body, status = 200) {
      const buf = Buffer.from(body, 'utf8');
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      res.end(buf);
    },
    redirect(loc) {
      res.writeHead(302, { Location: loc, 'Cache-Control': 'no-store' });
      res.end();
    },
    flash(loc, msg, type) {
      const sep = loc.includes('?') ? '&' : '?';
      const target = loc + sep + 'msg=' + encodeURIComponent(msg || '') + (type === 'err' ? '&err=1' : '');
      return ctx.redirect(target);
    },
    logout() {
      try { require('./lib/ai').forget(cookies.sid); } catch {}
      destroySession(cookies.sid);
      res.writeHead(302, { Location: '/login', 'Set-Cookie': 'sid=; Path=/; Max-Age=0; HttpOnly' });
      res.end();
    },
  };

  try {
    for (const r of ROUTES) {
      if (r.m !== req.method) continue;
      const m = pathname.match(r.p);
      if (!m) continue;
      if (!r.open && !user) {
        if (req.method === 'GET') return ctx.redirect('/login');
        return ctx.html('未登录', 401);
      }
      if (r.perm) {
        const ok = Array.isArray(r.perm) ? r.perm.some((p) => can(user, p)) : can(user, r.perm);
        if (!ok) {
          return ctx.html(U.layout({ title: '无权限', user, body: '<section class="panel">你没有访问该页面的权限。</section>' }), 403);
        }
      }
      if (req.method === 'POST') ctx.body = await parseBody(req);
      return await r.h(ctx, m);
    }
    ctx.html(U.layout({ title: '页面不存在', user, body: '<section class="panel">页面不存在。<a href="/">返回工作台</a></section>' }), 404);
  } catch (e) {
    console.error('[error]', req.method, pathname, e && e.stack ? e.stack : e);
    if (!res.headersSent) ctx.html(U.layout({ title: '出错', user, body: `<section class="panel">服务器错误：${U.esc(e.message)}</section>` }), 500);
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WMS ready on http://${HOST}:${PORT}`);
});
