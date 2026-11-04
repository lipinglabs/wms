'use strict';
/* 二级管理员角色验证：权限范围、撤改已提交单据、项目可见性 */
const BASE = process.env.BASE || 'http://127.0.0.1:8097';
let pass = 0, fail = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || extra === undefined ? '' : '  -> ' + extra}`); ok ? pass++ : fail++; };

function client() {
  let sid = '';
  return async function req(p, opt = {}) {
    const headers = {};
    if (sid) headers.Cookie = 'sid=' + sid;
    let body;
    if (opt.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
      body = new URLSearchParams(opt.form).toString();
    } else if (opt.text !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
      body = opt.text;
    }
    const r = await fetch(BASE + p, { method: opt.method || 'GET', headers, body, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of sc) { const m = /^sid=([^;]*)/.exec(c); if (m) sid = m[1]; }
    return r;
  };
}

const text = (r) => r.text();
const code = async (r) => r.status;

(async () => {
  // ---------- admin ----------
  const admin = client();
  let r = await admin('/login', { method: 'POST', form: { username: 'admin', password: 'admin888' } });
  check('管理员登录', r.status === 302, r.status);

  // 角色是否存在
  const rolesHtml = await text(await admin('/roles'));
  check('角色列表出现「二级管理员」', rolesHtml.includes('二级管理员'));
  const seg = rolesHtml.slice(rolesHtml.indexOf('二级管理员'));
  const m = /roles\?edit=(\d+)/.exec(seg);
  const secRoleId = m ? m[1] : null;
  check('能定位二级管理员角色 id', !!secRoleId, secRoleId);

  // 角色权限数量：收发存 13 + doc.admin + scope.all = 15，加 out.items/ret.items 后为 16
  const permHtml = await text(await admin('/roles?edit=' + secRoleId));
  const checked = (permHtml.match(/name="perms" value="[^"]+" checked/g) || []).length;
  check('二级管理员权限点为 16 个', checked === 16, checked);
  for (const k of ['base.project', 'base.major', 'base.team', 'sys.role', 'sys.user']) {
    const has = new RegExp(`name="perms" value="${k.replace('.', '\\.')}" checked`).test(permHtml);
    check(`不含 ${k}`, !has);
  }

  // 建临时二级管理员账号
  let teamId = '1';
  const teamsHtml = await text(await admin('/teams'));
  const tm = /teams\?edit=(\d+)/.exec(teamsHtml);
  if (tm) teamId = tm[1];
  else {
    await admin('/teams/save', { method: 'POST', form: { name: '测试队伍', sort: '1', active: '1' } });
    const t2 = await text(await admin('/teams'));
    const t2m = /teams\?edit=(\d+)/.exec(t2);
    teamId = t2m ? t2m[1] : '1';
  }
  r = await admin('/users/save', {
    method: 'POST',
    form: { username: 'sec_test', name: '二级管理员测试', role_id: secRoleId, password: 'sec123456', active: '1', password2: '' },
  });
  check('创建二级管理员账号', r.status === 302, r.status);

  // ---------- 二级管理员 ----------
  const sec = client();
  r = await sec('/login', { method: 'POST', form: { username: 'sec_test', password: 'sec123456' } });
  check('二级管理员登录', r.status === 302, r.status);

  const dash = await text(await sec('/'));
  for (const label of ['入库登记', '领用登记', '出库登记', '退料登记', '库存']) {
    check(`侧栏有「${label}」`, dash.includes('>' + label + '</a>'));
  }
  for (const label of ['工程管理', '专业管理', '施工队伍', '角色权限', '用户']) {
    check(`侧栏无「${label}」`, !dash.includes('>' + label + '</a>'));
  }

  for (const p of ['/in/new', '/in/list', '/in/items', '/req/new', '/req/list', '/out/new', '/out/list', '/ret/new', '/ret/list', '/stock']) {
    check('可访问 ' + p, (await sec(p)).status === 200);
  }
  for (const p of ['/projects', '/majors', '/teams', '/roles', '/users']) {
    check('拒绝访问 ' + p, (await sec(p)).status === 403, (await sec(p)).status);
  }

  // 项目可见性：未被分配到任何工程，仍应看到全部
  const inNew = await text(await sec('/in/new'));
  const projCount = (inNew.match(/<option value="\d+"/g) || []).length;
  check('未分配工程也能看到工程下拉（scope.all）', projCount >= 1, projCount);

  // ---------- 入库 → 提交 → 作废 ----------
  const paste = ['序号\t工程名称\t物料编码\t物资名称\t规格型号\t执行标准/技术要求\t单位\t数量\t需求计划编号',
    '1\t公司公用\tSEC-01\t二级管理员测试料\tDN50\tGB/T 1\t根\t10\tPLAN-SEC-1'].join('\n');
  const inForm = new URLSearchParams();
  inForm.append('project_id', '1');
  const majorOpt = /<option value="(\d+)"/.exec(inNew);
  inForm.append('major_id', majorOpt ? majorOpt[1] : '1');
  inForm.append('arrival_date', '2026-11-03');
  inForm.append('text', paste);
  r = await sec('/in/create', { method: 'POST', text: inForm.toString() });
  check('二级管理员可建入库单', r.status === 302, r.status);
  const inLoc = r.headers.get('location') || '';
  const inId = (/(\d+)/.exec(inLoc.split('/in/')[1] || '') || [])[1];
  check('入库单已生成', !!inId, inLoc);

  r = await sec(`/in/${inId}/submit`, { method: 'POST', form: {} });
  check('二级管理员可提交入库单', r.status === 302, r.status);
  let stock = await text(await sec('/stock'));
  check('库存出现 10', /<b[^>]*>10(\.0+)?<\/b>/.test(stock) || stock.includes('>10<'));

  // ---------- 领料申请 → 提交 → 撤回 ----------
  const itemId = (/name="pick" value="(\d+)"/.exec(await text(await sec('/req/new?project=1&team=' + teamId + '&major=' + (majorOpt ? majorOpt[1] : '1')))) || [])[1];
  check('领用页列出现存物资', !!itemId, itemId);
  const reqForm = new URLSearchParams();
  reqForm.append('project_id', '1');
  reqForm.append('team_id', teamId);
  reqForm.append('major_id', majorOpt ? majorOpt[1] : '1');
  reqForm.append('pick', itemId);
  reqForm.append('qty_' + itemId, '3');
  reqForm.append('remark', '撤回测试');
  r = await sec('/req/save', { method: 'POST', text: reqForm.toString() });
  check('二级管理员可建领料单', r.status === 302, r.status);
  const reqId = (/(\d+)/.exec((r.headers.get('location') || '').split('/req/')[1] || '') || [])[1];
  check('领料单已生成', !!reqId);
  r = await sec(`/req/${reqId}/submit`, { method: 'POST', form: {} });
  check('二级管理员可提交领料单', r.status === 302, r.status);
  r = await sec(`/req/${reqId}/withdraw`, { method: 'POST', form: {} });
  check('二级管理员可撤回已提交领料单（doc.admin）', r.status === 302, r.status);

  // ---------- 作废入库 ----------
  r = await sec(`/in/${inId}/void`, { method: 'POST', form: {} });
  check('二级管理员可作废已提交入库单（doc.admin）', r.status === 302, r.status);
  stock = await text(await sec('/stock'));
  check('作废后库存不再列出该物资', !stock.includes('二级管理员测试料'));
  const inDetail = await text(await sec('/in/' + inId));
  check('入库单状态变为已作废', inDetail.includes('已作废'));

  // ---------- 对照：仓管员仍不能撤改 ----------
  await admin('/users/save', { method: 'POST', form: { username: 'kp_test', name: '仓管测试', role_id: '2', password: 'kp123456', active: '1', projects: '1' } });
  const kp = client();
  await kp('/login', { method: 'POST', form: { username: 'kp_test', password: 'kp123456' } });
  const kpIn = await text(await kp('/in/new'));
  const kpForm = new URLSearchParams();
  kpForm.append('project_id', '1');
  kpForm.append('major_id', majorOpt ? majorOpt[1] : '1');
  kpForm.append('arrival_date', '2026-11-03');
  kpForm.append('text', ['序号\t工程名称\t物资名称\t单位\t数量\t需求计划编号', '1\t公司公用\t仓管测试料\t个\t5\tPLAN-KP-1'].join('\n'));
  r = await kp('/in/create', { method: 'POST', text: kpForm.toString() });
  const kpInId = (/(\d+)/.exec((r.headers.get('location') || '').split('/in/')[1] || '') || [])[1];
  await kp(`/in/${kpInId}/submit`, { method: 'POST', form: {} });
  const kpDetail = await kp(`/in/${kpInId}`);
  const kpHtml = await text(kpDetail);
  check('仓管员能看到该入库单', kpDetail.status === 200, kpDetail.status);
  check('仓管员看不到作废按钮', !kpHtml.includes('/void'));
  r = await kp(`/in/${kpInId}/void`, { method: 'POST', form: {} });
  check('仓管员越权作废被拒（重定向到错误提示）', r.status === 302 && /err|msg/.test(r.headers.get('location') || ''), r.headers.get('location'));

  /* ---------- 用户自行修改密码 ---------- */
  const loc = (resp) => decodeURIComponent(resp.headers.get('location') || '');
  const navHtml = await text(await kp('/'));
  check('侧栏有「修改密码」入口', navHtml.includes('href="/password"'));
  check('普通用户可打开修改密码页', (await kp('/password')).status === 200);

  const wrongOld = await kp('/password', { method: 'POST', form: { old: 'wrong-old', new1: 'newpass123', new2: 'newpass123' } });
  check('旧密码错误被拒', loc(wrongOld).includes('当前密码不正确'), loc(wrongOld));
  const shortPw = await kp('/password', { method: 'POST', form: { old: 'kp123456', new1: '123', new2: '123' } });
  check('新密码少于 6 位被拒', loc(shortPw).includes('至少 6 位'), loc(shortPw));
  const mismatch = await kp('/password', { method: 'POST', form: { old: 'kp123456', new1: 'newpass123', new2: 'newpass999' } });
  check('两次新密码不一致被拒', loc(mismatch).includes('不一致'), loc(mismatch));
  const okPw = await kp('/password', { method: 'POST', form: { old: 'kp123456', new1: 'newpass123', new2: 'newpass123' } });
  check('修改密码成功', loc(okPw).includes('密码已修改'), loc(okPw));

  const kpOld = client();
  check('旧密码不能再登录', (await kpOld('/login', { method: 'POST', form: { username: 'kp_test', password: 'kp123456' } })).status !== 302);
  check('改密后当前会话仍有效', (await kp('/')).status === 200);
  await kp('/logout');
  const kpNew = client();
  check('新密码可以登录', (await kpNew('/login', { method: 'POST', form: { username: 'kp_test', password: 'newpass123' } })).status === 302);

  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2); });
