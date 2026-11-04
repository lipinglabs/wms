'use strict';
/* 库存升级验证：0 数量展示、单项出库明细页、领用明细权限点 */
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

  // 数据：入库两种物资，一张领料单，分两次出库清空其中一种
  let teamId = (/(teams\?edit=(\d+))/.exec(await text(await a('/teams'))) || [])[2];
  if (!teamId) { await a('/teams/save', { method: 'POST', form: { name: '库存升级班组', sort: '1', active: '1' } }); teamId = (/(teams\?edit=(\d+))/.exec(await text(await a('/teams'))) || [])[2]; }
  const inNew = await text(await a('/in/new'));
  const majorId = (/name="major_id"[\s\S]{0,400}?<option value="(\d+)"/.exec(inNew) || [])[1] || '1';
  const paste = ['序号\t工程名称\t物资名称\t规格型号\t技术要求\t单位\t数量\t需求计划编号',
    '1\t公司公用\t升级测试清空料\tDN20\tGB\t个\t60\tPLAN-KC-1',
    '2\t公司公用\t升级测试留存料\tDN25\tGB\t个\t80\tPLAN-KC-2'].join('\n');
  const fi = new URLSearchParams();
  fi.append('project_id', '1'); fi.append('major_id', majorId); fi.append('arrival_date', '2026-11-03');
  fi.append('text', paste); fi.append('_ft', 'kc' + Date.now().toString(16));
  const inId = idAfter('/in/', loc(await a('/in/create', { method: 'POST', text: fi.toString() })));
  await a(`/in/${inId}/submit`, { method: 'POST', form: {} });

  const rp = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  const siMap = {};
  [...rp.matchAll(/<tr><td><input type="checkbox" name="pick" value="(\d+)">([\s\S]*?)<\/tr>/g)].forEach((m) => {
    const nm = /升级测试(\S+?)</.exec(m[2]);
    if (nm) siMap[nm[1]] = m[1];
  });
  const siClear = siMap['清空料'], siKeep = siMap['留存料'];
  check('领用页两行物资', !!siClear && !!siKeep && siClear !== siKeep);
  const fr = new URLSearchParams();
  fr.append('project_id', '1'); fr.append('team_id', teamId); fr.append('major_id', majorId);
  fr.append('pick', siClear); fr.append('qty_' + siClear, '60');
  fr.append('pick', siKeep); fr.append('qty_' + siKeep, '20');
  fr.append('_ft', 'kcr' + Date.now().toString(16));
  const reqId = idAfter('/req/', loc(await a('/req/save', { method: 'POST', text: fr.toString() })));
  await a(`/req/${reqId}/submit`, { method: 'POST', form: {} });

  // 两次出库清空料（25 + 35），留存料出 20
  const pickLine = async (siName, qty) => {
    const pp = await text(await a(`/out/${reqId}`));
    let line = null;
    for (const m of pp.matchAll(/<tr><td><input type="checkbox" name="pick" value="(\d+)">([\s\S]*?)<\/tr>/g)) {
      if (m[2].includes(siName)) line = m[1];
    }
    const f = new URLSearchParams();
    f.append('req_id', reqId); f.append('pick', line); f.append('qty_' + line, qty);
    f.append('_ft', 'kco' + Math.random().toString(36).slice(2, 14));
    return loc(await a('/out/save', { method: 'POST', text: f.toString() }));
  };
  check('第一次出库 25', (await pickLine('清空料', '25')).includes('出库完成'));
  check('第二次出库 35', (await pickLine('清空料', '35')).includes('出库完成'));
  check('留存料出库 20', (await pickLine('留存料', '20')).includes('出库完成'));

  // ===== 1. 0 数量展示 =====
  const stockDefault = await text(await a('/stock'));
  check('默认不显示 0 数量物资', !stockDefault.includes('升级测试清空料'));
  const stockZero = await text(await a('/stock?zero=1'));
  check('勾选后显示 0 数量物资', stockZero.includes('升级测试清空料'));
  check('勾选框文案为「显示 0 数量物资」', stockZero.includes('显示 0 数量物资'));
  const stockZeroQ = await text(await a('/stock?zero=1&q=%E5%8D%87%E7%BA%A7%E6%B5%8B%E8%AF%95'));
  check('0 数量 + 关键字可叠加', stockZeroQ.includes('升级测试清空料') && stockZeroQ.includes('升级测试留存料'));

  // ===== 2. 出库明细按钮与页面 =====
  check('默认页每行有「出库明细」按钮', (stockDefault.match(/出库明细<\/a>/g) || []).length >= 1);
  check('0 数量页按钮数与行数一致', (stockZero.match(/出库明细<\/a>/g) || []).length >= 2);
  const outs = await text(await a(`/stock/${siClear}/outs`));
  check('出库明细页 200', !!outs && outs.includes('出库 / 退库记录'));
  check('两次领用都列出（-25 与 -35）', />-25(\.0+)?<\/span>/.test(outs) && />-35(\.0+)?<\/span>/.test(outs));
  check('显示领料队伍', outs.includes('库存升级班组'));
  check('显示领料单号', outs.includes('LL-'));
  check('显示出库人', outs.includes('领料单制单人') && outs.includes('管理员'));
  check('显示领料单制单人', outs.includes('领料单制单人'));
  check('页头有当前结存 0', new RegExp('当前结存[\\s\\S]{0,80}>0(\\.0+)?').test(outs));
  check('累计出库 60', /累计出库[\s\S]{0,80}60/.test(outs));
  const outKeep = await text(await a(`/stock/${siKeep}/outs`));
  check('另一物资只列自己的出库（-20）', outKeep.includes('升级测试留存料') && />-20(\.0+)?<\/span>/.test(outKeep) && !/>-25(\.0+)?<\/span>/.test(outKeep));

  // ===== 3. 领用明细权限点 =====
  const roleEditPage = await text(await a('/roles?edit=1'));
  check('角色授权页出现「领用明细」权限', roleEditPage.includes('领用明细（按物资行查领用记录）'));
  const adminRoleHtml = await text(await a('/roles?edit=1'));
  check('管理员角色已勾选领用明细', /name="perms" value="req\.items" checked/.test(adminRoleHtml));
  const keeperHtml = await text(await a('/roles?edit=2'));
  check('仓管员角色自动补授领用明细', /name="perms" value="req\.items" checked/.test(keeperHtml));

  // 建一个只有 stock.view 的角色 → 无领用明细
  await a('/roles/create', { method: 'POST', form: { name: '仅库存查看', note: '' } });
  const rl = await text(await a('/roles'));
  const onlyStockRoleId = (/仅库存查看[\s\S]{0,200}?roles\?edit=(\d+)/.exec(rl) || [])[1];
  await a('/roles/save', { method: 'POST', form: { id: onlyStockRoleId, perms: ['stock.view'] } });
  await a('/users/save', { method: 'POST', form: { username: 'kc_viewer', name: '仅库存人', role_id: onlyStockRoleId, password: 'kc123456', active: '1', projects: '1' } });
  const v = client();
  await v('/login', { method: 'POST', form: { username: 'kc_viewer', password: 'kc123456' } });
  const vNav = await text(await v('/'));
  check('无权限者侧栏无「领用明细」', !vNav.includes('>领用明细</a>'));
  check('无权限者访问明细页 403', (await v('/req/items')).status === 403);
  check('有 stock.view 仍可看出库明细页', (await v(`/stock/${siClear}/outs`)).status === 200);

  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2); });
