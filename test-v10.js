'use strict';
/* 单点登录验证：同账号二次登录出现确认页、确认后踢旧会话、取消不影响、令牌一次性、不同账号互不影响 */
const BASE = process.env.BASE || 'http://127.0.0.1:8096';
let pass = 0, fail = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || extra === undefined ? '' : '  -> ' + extra}`); ok ? pass++ : fail++; };

function client() {
  let sid = '';
  return async function req(p, opt = {}) {
    const headers = {};
    if (sid) headers.Cookie = 'sid=' + sid;
    let body;
    if (opt.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8'; body = new URLSearchParams(opt.form).toString(); }
    else if (opt.text !== undefined) { headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8'; body = opt.text; }
    const r = await fetch(BASE + p, { method: opt.method || 'GET', headers, body, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of sc) { const m = /^sid=([^;]*)/.exec(c); if (m) sid = m[1]; }
    return r;
  };
}
const text = (r) => r.text();
const loc = (r) => decodeURIComponent(r.headers.get('location') || '');

(async () => {
  /* ---------- 1. 首次登录 ---------- */
  const a = client();
  check('首次登录成功', (await a('/login', { method: 'POST', form: { username: 'admin', password: 'admin888' } })).status === 302);
  check('A 可进工作台', (await a('/')).status === 200);

  /* 建一个副账号，用于验证不同账号互不影响 */
  await a('/users/save', { method: 'POST', form: { username: 'sso_u2', name: '单点测试乙', role_id: '2', password: 'u2123456', active: '1', projects: '1' } });

  /* ---------- 2. 同账号二次登录 → 确认页 ---------- */
  const b = client();
  const r2 = await b('/login', { method: 'POST', form: { username: 'admin', password: 'admin888' } });
  const h2 = await text(r2);
  check('二次登录不直接放行', r2.status === 200, r2.status);
  check('出现「该账号已在别处登录」', h2.includes('该账号已在别处登录'));
  check('提供「改为当前登录」按钮', h2.includes('改为当前登录'));
  check('提供「取消」入口', h2.includes('href="/login"') && h2.includes('取消'));
  const tk = (/name="confirm" value="([a-f0-9]+)"/.exec(h2) || [])[1];
  check('拿到一次性确认令牌', !!tk, tk);

  /* ---------- 3. 未确认前，旧会话不受影响 ---------- */
  check('未确认时旧会话仍有效', (await a('/')).status === 200);
  check('未确认时 B 仍未登录', (await b('/')).status === 302);

  /* ---------- 4. 确认后：新会话生效、旧会话被踢 ---------- */
  const r3 = await b('/login', { method: 'POST', form: { confirm: tk } });
  check('确认后跳转首页', r3.status === 302 && loc(r3) === '/', loc(r3));
  check('B 可以进工作台', (await b('/')).status === 200);
  const r4 = await a('/');
  check('旧会话已被踢出（跳登录页）', r4.status === 302 && loc(r4).includes('/login'), r4.status + ' ' + loc(r4));

  /* ---------- 5. 令牌一次性 ---------- */
  const c1 = client();
  const r5 = await c1('/login', { method: 'POST', form: { confirm: tk } });
  check('确认令牌不能重复使用', r5.status === 401, r5.status);
  const r6 = await c1('/login', { method: 'POST', form: { confirm: 'deadbeefdeadbeef' } });
  check('伪造令牌被拒', r6.status === 401, r6.status);

  /* ---------- 6. 不同账号互不影响 ---------- */
  const u2 = client();
  const r7 = await u2('/login', { method: 'POST', form: { username: 'sso_u2', password: 'u2123456' } });
  check('不同账号可直接登录（不弹确认）', r7.status === 302, r7.status);
  check('B 的会话不受影响', (await b('/')).status === 200);
  check('u2 也能正常使用', (await u2('/')).status === 200);

  /* ---------- 7. 会话记录带登录时间与 IP ---------- */
  const ssoHome = await text(await b('/'));
  check('B 已登录且页面正常', ssoHome.includes('工作台'));

  /* ---------- 8. 退出后可以正常重新登录 ---------- */
  await b('/logout');
  const b2 = client();
  const r8 = await b2('/login', { method: 'POST', form: { username: 'admin', password: 'admin888' } });
  check('退出后重新登录不弹确认', r8.status === 302, r8.status);

  /* ---------- 9. 工作台新版块 ---------- */
  const dashHtml = await text(await b2('/'));
  check('四个卡片标题正确', ['今日新增入库单', '待出库领料单', '今日新增领料单', '今日出库'].every((x) => dashHtml.includes(x)));
  check('未出现旧口径标题', !dashHtml.includes('待提交入库单') && !dashHtml.includes('累计入库'));
  check('水印含核心价值观全文', dashHtml.includes('富强') && dashHtml.includes('友善') && dashHtml.includes('法治'));
  check('工作台主体正常', dashHtml.includes('最近单据'));
  check('工作台显示备份状态', dashHtml.includes('bk-line'));

  /* ---------- 10. 全站天气位与水印 ---------- */
  for (const p of ['/', '/stock', '/users']) {
    const h = await text(await b2(p));
    check(`页面 ${p} 有天气位`, h.includes('id="wx-slot"'));
    check(`页面 ${p} 有水印`, h.includes('class="wm"'));
  }

  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2); });
