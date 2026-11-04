'use strict';
/* 基础档案删除验证：引用拦截、权限拦截、自删拦截、空档案真删 */
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
const idAfter = (path, l) => (/(\d+)/.exec(l.split(path)[1] || '') || [])[1];
const del = (c, kind, id) => c('/base/delete', { method: 'POST', form: { kind, id: String(id) } });

/* 从列表 HTML 里按名称定位所在行的 edit id（只在表格行内找，避免命中导航或提示文字） */
const rowOf = (html, name) => {
  const trs = html.match(/<tr[\s\S]*?<\/tr>/g) || [];
  return trs.find((tr) => tr.includes(name) && /edit=\d+/.test(tr)) || '';
};
const idOf = (row) => ((/edit=(\d+)/.exec(row || '') || [])[1] || '');

(async () => {
  const a = client();
  check('管理员登录', (await a('/login', { method: 'POST', form: { username: 'admin', password: 'admin888' } })).status === 302);

  /* ---------- 1. 空工程可以真删 ---------- */
  await a('/projects/save', { method: 'POST', form: { name: '删除测试空工程', code: 'DEL1', sort: '9', active: '1' } });
  const pjList = await text(await a('/projects'));
  check('列表出现删除按钮', pjList.includes('action="/base/delete"') && pjList.includes('name="kind" value="project"'));
  check('删除按钮带二次确认', pjList.includes('return confirm('));

  const p1 = idOf(rowOf(pjList, '删除测试空工程'));
  check('取到空工程 id', !!p1, p1);
  const d1 = await del(a, 'project', p1);
  check('空工程可删除', d1.status === 302 && loc(d1).includes('已删除'), loc(d1));
  check('删除后列表不再出现', !(await text(await a('/projects'))).includes('删除测试空工程'));

  /* ---------- 2. 有业务数据的工程 / 专业会被拦 ---------- */
  await a('/projects/save', { method: 'POST', form: { name: '删除测试有单工程', code: 'DEL2', sort: '9', active: '1' } });
  await a('/majors/save', { method: 'POST', form: { name: '删除测试专业', code: 'DM', sort: '9', active: '1' } });
  await a('/teams/save', { method: 'POST', form: { name: '删除测试空队伍', sort: '9', active: '1' } });

  const p2 = idOf(rowOf(await text(await a('/projects')), '删除测试有单工程'));
  const m1 = idOf(rowOf(await text(await a('/majors')), '删除测试专业'));
  const t1 = idOf(rowOf(await text(await a('/teams')), '删除测试空队伍'));

  const fi = new URLSearchParams();
  fi.append('project_id', String(p2));
  fi.append('major_id', String(m1));
  fi.append('arrival_date', '2026-11-03');
  fi.append('text', ['序号\t工程名称\t物资名称\t规格型号\t技术要求\t单位\t数量\t需求计划编号',
    '1\t删除测试有单工程\t删除测试物资\tD1\tGB\t件\t10\tPLAN-DEL-1'].join('\n'));
  fi.append('_ft', 'dl' + Date.now().toString(16));
  const inId = idAfter('/in/', loc(await a('/in/create', { method: 'POST', text: fi.toString() })));
  check('造入库单成功', !!inId, inId);
  await a(`/in/${inId}/submit`, { method: 'POST', form: {} });

  const d2 = await del(a, 'project', p2);
  check('有库存的工程拒绝删除', loc(d2).includes('无法删除'), loc(d2));
  check('拒绝原因点名库存条目', loc(d2).includes('库存条目'), loc(d2));

  const d3 = await del(a, 'major', m1);
  check('有库存的专业拒绝删除', loc(d3).includes('无法删除'), loc(d3));

  const d4 = await del(a, 'team', t1);
  check('未被引用的队伍可删除', loc(d4).includes('已删除'), loc(d4));

  /* ---------- 3. 有单据的队伍不能删 ---------- */
  await a('/teams/save', { method: 'POST', form: { name: '删除测试有单队伍', sort: '9', active: '1' } });
  const t2 = idOf(rowOf(await text(await a('/teams')), '删除测试有单队伍'));
  const rp = await text(await a(`/req/new?project=${p2}&team=${t2}&major=${m1}`));
  const siId = (/name="pick" value="(\d+)"/.exec(rp) || [])[1];
  const fr = new URLSearchParams();
  fr.append('project_id', String(p2));
  fr.append('team_id', String(t2));
  fr.append('major_id', String(m1));
  fr.append('pick', siId);
  fr.append('qty_' + siId, '1');
  fr.append('_ft', 'dt' + Date.now().toString(16));
  const reqId = idAfter('/req/', loc(await a('/req/save', { method: 'POST', text: fr.toString() })));
  check('造领料单成功', !!reqId, reqId);

  const d5 = await del(a, 'team', t2);
  check('有单据的队伍拒绝删除', loc(d5).includes('无法删除') && loc(d5).includes('单据'), loc(d5));

  /* ---------- 4. 用户删除 ---------- */
  const rolesHtml = await text(await a('/roles'));
  const keeperRoleId = idOf(rowOf(rolesHtml, '仓管员'));
  check('取到仓管员角色 id', !!keeperRoleId, keeperRoleId);

  await a('/users/save', { method: 'POST', form: { username: 'del_user1', name: '删除测试员甲', role_id: String(keeperRoleId), password: 'del123456', active: '1' } });
  const uHtml = await text(await a('/users'));
  check('列表出现用户删除按钮', uHtml.includes('name="kind" value="user"'));
  check('参与工程列显示工程名/全部工程', uHtml.includes('cell-badges') || uHtml.includes('全部工程'));
  const uid1 = idOf(rowOf(uHtml, '删除测试员甲'));
  const d6 = await del(a, 'user', uid1);
  check('无业务记录的用户可删除', loc(d6).includes('已删除'), loc(d6));

  const d7 = await del(a, 'user', 1);
  check('不能删除当前登录账号', loc(d7).includes('当前正在登录'), loc(d7));

  /* ---------- 5. 角色删除 ---------- */
  const adminRoleId = idOf(rowOf(rolesHtml, '管理员'));
  const d8 = await del(a, 'role', adminRoleId);
  check('管理员角色不能删除', loc(d8).includes('不能删除'), loc(d8));
  check('管理员角色行无删除按钮', !rowOf(rolesHtml, '管理员').includes('value="role"'));

  await a('/users/save', { method: 'POST', form: { username: 'del_keeper1', name: '占位仓管员', role_id: String(keeperRoleId), password: 'kp123456', active: '1' } });
  const d9 = await del(a, 'role', keeperRoleId);
  check('被用户占用的角色拒绝删除', loc(d9).includes('无法删除'), loc(d9));

  const cr = await a('/roles/create', { method: 'POST', form: { name: '删除测试空角色', note: 'tmp' } });
  const newRoleId = idAfter('/roles?edit=', loc(cr));
  check('新角色创建', !!newRoleId, loc(cr));
  const d10 = await del(a, 'role', newRoleId);
  check('空角色可删除', loc(d10).includes('已删除'), loc(d10));

  /* ---------- 6. 无权限账号不能删 ---------- */
  const cr2 = await a('/roles/create', { method: 'POST', form: { name: '删除测试受限角色', note: 'no perm' } });
  const limitedRoleId = idAfter('/roles?edit=', loc(cr2));
  await a('/users/save', { method: 'POST', form: { username: 'del_limited', name: '受限测试员', role_id: String(limitedRoleId), password: 'lim123456', active: '1' } });

  await a('/projects/save', { method: 'POST', form: { name: '删除测试越权工程', code: 'DEL3', sort: '9', active: '1' } });
  const p3 = idOf(rowOf(await text(await a('/projects')), '删除测试越权工程'));

  const b = client();
  check('受限账号登录', (await b('/login', { method: 'POST', form: { username: 'del_limited', password: 'lim123456' } })).status === 302);
  const d11 = await del(b, 'project', p3);
  check('无权限账号删除被拒', loc(d11).includes('没有删除该档案的权限'), loc(d11));
  check('越权删除未生效', (await text(await a('/projects'))).includes('删除测试越权工程'));

  /* ---------- 7. 边界情况 ---------- */
  const d12 = await del(a, 'project', 999999);
  check('删除不存在的记录有提示', loc(d12).includes('不存在'), loc(d12));
  const d13 = await del(a, 'nonsense', 1);
  check('非法类型被拒', loc(d13).includes('不支持'), loc(d13));

  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
