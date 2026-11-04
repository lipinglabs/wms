'use strict';
/* 系统日志：菜单与权限、登录记录、操作记录、失败与越权记录、历史补录 */
const BASE = process.env.BASE || 'http://127.0.0.1:8113';
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
  const a = client();
  const bad = client();

  check('管理员登录', (await a('/login', { method: 'POST', form: { username: 'admin', password: 'admin888' } })).status === 302);

  const dash = await text(await a('/'));
  check('主菜单出现「日志」', /<a class="nav-item[^"]*" href="\/logs">/.test(dash) && dash.includes('日志'));

  const logs = await a('/logs');
  const logsHtml = await text(logs);
  check('日志页可打开', logs.status === 200);
  check('日志页显示登录记录', logsHtml.includes('登录') && logsHtml.includes('登录系统'));
  check('日志页标记补录来源', logsHtml.includes('补录'));
  check('日志页有筛选栏', logsHtml.includes('action="/logs"') && logsHtml.includes('全部类别'));

  /* 一次真实操作 → 应被记录 */
  const tname = '日志测试班组' + Date.now().toString(36).slice(-4);
  check('新建施工队伍', loc(await a('/teams/save', { method: 'POST', form: { name: tname, sort: '9', active: '1' } })).includes('已保存'));

  const after = await text(await a('/logs'));
  check('操作被记入日志', after.includes('保存施工队伍') && after.includes(tname));

  /* 登录失败 → 失败记录 */
  await bad('/login', { method: 'POST', form: { username: 'admin', password: 'wrong-pass' } });
  const failLog = await text(await a('/logs?cat=auth&st=fail'));
  check('登录失败被记录', failLog.includes('登录失败'));
  check('失败记录带 IP', /登录失败[\s\S]{0,400}?127\.0\.0\.1|登录失败[\s\S]{0,400}?::1/.test(failLog));

  /* 非管理员：看不到入口，也打不开页面 */
  const roles = await text(await a('/users'));
  const keeperRole = (/<option value="(\d+)"[^>]*>仓管员/.exec(roles) || [])[1];
  const uname = 'logtest' + Date.now().toString(36).slice(-4);
  await a('/users/save', { method: 'POST', form: { username: uname, name: '日志测试员', role_id: keeperRole, password: 'test1234', active: '1', projects: '1' } });

  const k = client();
  check('仓管员登录', (await k('/login', { method: 'POST', form: { username: uname, password: 'test1234' } })).status === 302);
  const kDash = await text(await k('/'));
  check('仓管员看不到「日志」菜单', !kDash.includes('href="/logs"'));
  const kLogs = await k('/logs');
  check('仓管员打不开日志页', kLogs.status === 403);

  const deny = await text(await a('/logs?st=fail'));
  check('越权访问被记录', deny.includes('无权限操作') || deny.includes('越权尝试'));

  /* 筛选：类别过滤生效 */
  const onlyOp = await text(await a('/logs?cat=op'));
  check('按类别筛选（只显示操作）', onlyOp.includes('操作') && !onlyOp.includes('登录系统'));

  /* 关键字筛选 */
  const kw = await text(await a('/logs?q=' + encodeURIComponent(tname)));
  check('关键字筛选命中', kw.includes(tname));

  /* 补录：初始化时建的账号应有记录 */
  const backfill = await text(await a('/logs?cat=op&q=' + encodeURIComponent('admin')));
  check('历史补录含账号创建', backfill.includes('新建账号'));

  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
