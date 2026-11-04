'use strict';
/* 领用明细页验证：行级展开、筛选、未出库、关键字、导出、权限 */
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

(async () => {
  const a = client();
  check('管理员登录', (await a('/login', { method: 'POST', form: { username: 'admin', password: 'admin888' } })).status === 302);

  // 队伍
  let teamId = (/(teams\?edit=(\d+))/.exec(await text(await a('/teams'))) || [])[2];
  if (!teamId) { await a('/teams/save', { method: 'POST', form: { name: '明细班组', sort: '1', active: '1' } }); teamId = (/(teams\?edit=(\d+))/.exec(await text(await a('/teams'))) || [])[2]; }

  // 入库两种物资
  const inNew = await text(await a('/in/new'));
  const majorId = (/name="major_id"[\s\S]{0,400}?<option value="(\d+)"/.exec(inNew) || [])[1] || '1';
  const paste = ['序号\t工程名称\t物资名称\t规格型号\t技术要求\t单位\t数量\t需求计划编号',
    '1\t公司公用\t明细页测试电缆\tYJV-4×6\tGB\t米\t100\tPLAN-MX-1',
    '2\t公司公用\t明细页测试角钢\t∠50×5\tGB\t根\t40\tPLAN-MX-2'].join('\n');
  const fi = new URLSearchParams();
  fi.append('project_id', '1'); fi.append('major_id', majorId); fi.append('arrival_date', '2026-11-03');
  fi.append('text', paste); fi.append('_ft', 'mx' + Date.now().toString(16));
  const inId = idAfter('/in/', loc(await a('/in/create', { method: 'POST', text: fi.toString() })));
  await a(`/in/${inId}/submit`, { method: 'POST', form: {} });

  // 领料单：电缆 100、角钢 40
  const rp = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  const siIds = [...rp.matchAll(/name="pick" value="(\d+)"/g)].map((m) => m[1]);
  const siMap = {};
  [...rp.matchAll(/<tr><td><input type="checkbox" name="pick" value="(\d+)">([\s\S]*?)<\/tr>/g)].forEach((m) => {
    const name = /明细页测试(\S+?)</.exec(m[2]);
    if (name) siMap[name[1]] = m[1];
  });
  const siCable = siMap['电缆'] || siIds[0];
  const siAngle = siMap['角钢'] || siIds[1];
  check('领用页两行物资', !!siCable && !!siAngle && siCable !== siAngle);

  const f1 = new URLSearchParams();
  f1.append('project_id', '1'); f1.append('team_id', teamId); f1.append('major_id', majorId);
  f1.append('pick', siCable); f1.append('qty_' + siCable, '100');
  f1.append('pick', siAngle); f1.append('qty_' + siAngle, '40');
  f1.append('remark', '明细页测试'); f1.append('_ft', 'mxr' + Date.now().toString(16));
  const reqId = idAfter('/req/', loc(await a('/req/save', { method: 'POST', text: f1.toString() })));
  check('领料单已生成', !!reqId, loc(await a('/req/save', { method: 'POST', text: f1.toString() })));
  await a(`/req/${reqId}/submit`, { method: 'POST', form: {} });

  // 出库：电缆 40（部分）
  const pp = await text(await a(`/out/${reqId}`));
  const lineIds = [...pp.matchAll(/name="pick" value="(\d+)"/g)].map((m) => m[1]);
  const lineCable = (() => {
    for (const m of pp.matchAll(/<tr><td><input type="checkbox" name="pick" value="(\d+)">([\s\S]*?)<\/tr>/g)) {
      if (m[2].includes('电缆')) return m[1];
    }
    return lineIds[0];
  })();
  const fo = new URLSearchParams();
  fo.append('req_id', reqId); fo.append('pick', lineCable); fo.append('qty_' + lineCable, '40');
  fo.append('_ft', 'mxo' + Date.now().toString(16));
  check('电缆出库 40', loc(await a('/out/save', { method: 'POST', text: fo.toString() })).includes('出库完成'));

  // ===== 页面验证 =====
  const dash = await text(await a('/'));
  check('侧栏有「领用明细」', dash.includes('>领用明细</a>'));
  const items = await text(await a('/req/items'));
  check('页面 200 且含两行明细', items.includes('明细页测试电缆') && items.includes('明细页测试角钢'));
  check('列齐全（项目/计划编号/名称/规格/单位/数量/出库数量/制单人）', ['项目', '需求计划编号', '物资名称', '规格型号', '单位', '数量', '出库数量', '制单人'].every((c) => items.includes(c)));
  check('电缆出库数量显示 40', new RegExp('明细页测试电缆[\\s\\S]{0,600}>40(\\.0+)?<').test(items) || />40(\.0+)?<\/b>/.test(items));
  check('筛选器齐全', ['name="project"', 'name="major"', 'name="team"', 'name="maker"', 'name="from"', 'name="to"', 'name="open"', 'name="q"'].every((n) => items.includes(n)));

  // 未出库：电缆待出 60、角钢待出 40 → 两行都在
  let openHtml = await text(await a('/req/items?open=1'));
  check('未出库筛选（部分出库仍显示）', openHtml.includes('明细页测试电缆') && openHtml.includes('明细页测试角钢'));
  // 角钢全部出库 → 未出库只剩电缆
  const lineAngle = lineIds.find((l) => l !== lineCable) || lineIds[1];
  const fo2 = new URLSearchParams();
  fo2.append('req_id', reqId); fo2.append('pick', lineAngle); fo2.append('qty_' + lineAngle, '40');
  fo2.append('_ft', 'mxo2' + Date.now().toString(16));
  check('角钢出库 40', loc(await a('/out/save', { method: 'POST', text: fo2.toString() })).includes('出库完成'));
  openHtml = await text(await a('/req/items?open=1'));
  check('出完后未出库只剩电缆', openHtml.includes('明细页测试电缆') && !openHtml.includes('明细页测试角钢'), '');
  const allHtml = await text(await a('/req/items'));
  check('不筛未出库两行都在', allHtml.includes('明细页测试电缆') && allHtml.includes('明细页测试角钢'));

  // 关键字
  const k1 = await text(await a('/req/items?q=%E7%94%B5%E7%BC%86')); // 电缆
  check('关键字命中名称', k1.includes('明细页测试电缆') && !k1.includes('明细页测试角钢'));
  const k2 = await text(await a('/req/items?q=YJV'));
  check('关键字命中规格', k2.includes('明细页测试电缆'));
  const k3 = await text(await a('/req/items?q=PLAN-MX-2'));
  check('关键字命中计划编号', k3.includes('明细页测试角钢') && !k3.includes('明细页测试电缆'));

  // 制单人 / 日期 / 工程
  const k4 = await text(await a('/req/items?maker=' + encodeURIComponent('管理员')));
  check('制单人筛选命中', k4.includes('明细页测试电缆'));
  const k5 = await text(await a('/req/items?maker=查无人'));
  check('制单人筛选可空', k5.includes('没有符合条件的领用明细'));
  const TODAY = new Date().toLocaleDateString('sv-SE');
  const k6 = await text(await a('/req/items?from=' + TODAY + '&to=' + TODAY));
  check('时间区间命中', k6.includes('明细页测试电缆'));
  const k7 = await text(await a('/req/items?from=2030-01-01'));
  check('时间区间可空', k7.includes('没有符合条件的领用明细'));
  const k8 = await text(await a('/req/items?project=1'));
  check('工程筛选命中', k8.includes('明细页测试电缆'));

  // 导出
  const ex = await a('/export?kind=req_items');
  const buf = Buffer.from(await ex.arrayBuffer());
  check('导出 Excel 有效', ex.status === 200 && buf.slice(0, 2).toString() === 'PK', ex.status);
  const exOpen = await a('/export?kind=req_items&open=1');
  check('导出支持未出库筛选', exOpen.status === 200);

  // 权限：领料员（req.view）可见，仓管员可见；无 req.view 者不可见
  await a('/users/save', { method: 'POST', form: { username: 'mx_picker', name: '明细领料员', role_id: '4', password: 'mx123456', active: '1', projects: '1' } });
  const pk = client();
  await pk('/login', { method: 'POST', form: { username: 'mx_picker', password: 'mx123456' } });
  const pkNav = await text(await pk('/'));
  check('领料员侧栏有「领用明细」', pkNav.includes('>领用明细</a>'));
  check('领料员可访问明细页', (await pk('/req/items')).status === 200);
  const pkDashNoExport = !(await text(await pk('/req/items'))).includes('导出 Excel');
  check('无导出权限者不显示导出按钮', pkDashNoExport);

  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2); });
