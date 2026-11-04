'use strict';
/* 撤回出库验证：库存冲回、领料单状态回退、单据作废、可重新出库、权限限制 */
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

  let teamId = (/(teams\?edit=(\d+))/.exec(await text(await a('/teams'))) || [])[2];
  if (!teamId) { await a('/teams/save', { method: 'POST', form: { name: '撤回测试班组', sort: '1', active: '1' } }); teamId = (/(teams\?edit=(\d+))/.exec(await text(await a('/teams'))) || [])[2]; }
  const inNew = await text(await a('/in/new'));
  const majorId = (/name="major_id"[\s\S]{0,400}?<option value="(\d+)"/.exec(inNew) || [])[1] || '1';

  // 入库 100
  const paste = ['序号\t工程名称\t物资名称\t规格型号\t技术要求\t单位\t数量\t需求计划编号',
    '1\t公司公用\t撤回测试料\tDN50\tGB\t个\t100\tPLAN-CH-1'].join('\n');
  const fi = new URLSearchParams();
  fi.append('project_id', '1'); fi.append('major_id', majorId); fi.append('arrival_date', '2026-11-03');
  fi.append('text', paste); fi.append('_ft', 'ch' + Date.now().toString(16));
  const inId = idAfter('/in/', loc(await a('/in/create', { method: 'POST', text: fi.toString() })));
  await a(`/in/${inId}/submit`, { method: 'POST', form: {} });

  const rp = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  const si = (/<tr><td><input type="checkbox" name="pick" value="(\d+)">([\s\S]*?)<\/tr>/.exec(rp) || [])[1];
  const fr = new URLSearchParams();
  fr.append('project_id', '1'); fr.append('team_id', teamId); fr.append('major_id', majorId);
  fr.append('pick', si); fr.append('qty_' + si, '100');
  fr.append('_ft', 'chr' + Date.now().toString(16));
  const reqId = idAfter('/req/', loc(await a('/req/save', { method: 'POST', text: fr.toString() })));
  await a(`/req/${reqId}/submit`, { method: 'POST', form: {} });

  // 出库 60
  const pickPage = await text(await a(`/out/${reqId}`));
  const lineId = (/name="pick" value="(\d+)"/.exec(pickPage) || [])[1];
  const fo = new URLSearchParams();
  fo.append('req_id', reqId); fo.append('pick', lineId); fo.append('qty_' + lineId, '60');
  fo.append('_ft', 'cho' + Date.now().toString(16));
  check('出库 60 成功', loc(await a('/out/save', { method: 'POST', text: fo.toString() })).includes('出库完成'));

  const outList = await text(await a('/out/list'));
  const outDocId = (/href="\/doc\/(\d+)"/.exec(outList) || [])[1];
  check('出库单已生成', !!outDocId);

  let detail = await text(await a(`/doc/${outDocId}`));
  check('出库单页有「撤回出库」按钮', detail.includes('撤回出库'));
  check('领料单状态为部分出库', (await text(await a(`/req/${reqId}`))).includes('部分出库'));

  // 领料员无权撤回
  const usersHtml = await text(await a('/users'));
  const pickRole = (/<option value="(\d+)"[^>]*>领料员<\/option>/.exec(usersHtml) || [])[1];
  await a('/users/save', { method: 'POST', form: { username: 'ch_picker', name: '撤回领料员', role_id: pickRole, password: 'test1234', active: '1', projects: '1' } });
  const pk = client();
  await pk('/login', { method: 'POST', form: { username: 'ch_picker', password: 'test1234' } });
  const pkDoc = await text(await pk(`/doc/${outDocId}`));
  check('领料员看不到撤回按钮', !pkDoc.includes('撤回出库'));
  check('无权限者看到「联系管理员」提示', pkDoc.includes('如需撤回这张出库单，请联系管理员。'));
  check('领料员强行撤回被拒（403）', (await pk(`/out/${outDocId}/void`, { method: 'POST', form: {} })).status === 403);

  // 管理员撤回
  const voidLoc = loc(await a(`/out/${outDocId}/void`, { method: 'POST', form: {} }));
  check('撤回成功', voidLoc.includes('已撤回'));
  const afterDoc = await text(await a(`/doc/${outDocId}`));
  check('出库单变为已作废', afterDoc.includes('已作废'), voidLoc);
  check('作废后不再显示撤回按钮', !afterDoc.includes('撤回出库'));

  // 库存冲回：看库存页的结存列（<b> 包裹），应为 100
  const stockPage = await text(await a('/stock'));
  check('库存已冲回 100', /<b>100<\/b>/.test(stockPage), '结存应为 100');

  // 领料单回到待出库
  detail = await text(await a(`/req/${reqId}`));
  check('领料单回到已提交', detail.includes('已提交'), detail.includes('部分出库') ? '仍是部分出库' : '');
  check('待出库恢复 100', /待出库[\s\S]*?<b>100<\/b>/.test(detail));

  // 可以重新出库
  const pickPage2 = await text(await a(`/out/${reqId}`));
  const lineId2 = (/name="pick" value="(\d+)"/.exec(pickPage2) || [])[1];
  const fo2 = new URLSearchParams();
  fo2.append('req_id', reqId); fo2.append('pick', lineId2); fo2.append('qty_' + lineId2, '40');
  fo2.append('_ft', 'cho2' + Date.now().toString(16));
  check('可重新出库 40', loc(await a('/out/save', { method: 'POST', text: fo2.toString() })).includes('出库完成'));

  // 出库查询带状态列
  const list2 = await text(await a('/out/list'));
  check('出库查询有状态列', list2.includes('状态'));

  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
