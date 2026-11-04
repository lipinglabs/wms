'use strict';
/* 部分出库「了结剩余」验证：行级了结、状态流转、占用量释放、撤销恢复 */
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
  if (!teamId) { await a('/teams/save', { method: 'POST', form: { name: '了结测试班组', sort: '1', active: '1' } }); teamId = (/(teams\?edit=(\d+))/.exec(await text(await a('/teams'))) || [])[2]; }
  const inNew = await text(await a('/in/new'));
  const majorId = (/name="major_id"[\s\S]{0,400}?<option value="(\d+)"/.exec(inNew) || [])[1] || '1';

  // 入库 100
  const paste = ['序号\t工程名称\t物资名称\t规格型号\t技术要求\t单位\t数量\t需求计划编号',
    '1\t公司公用\t了结测试料\tDN40\tGB\t个\t100\tPLAN-JJ-1'].join('\n');
  const fi = new URLSearchParams();
  fi.append('project_id', '1'); fi.append('major_id', majorId); fi.append('arrival_date', '2026-11-03');
  fi.append('text', paste); fi.append('_ft', 'jj' + Date.now().toString(16));
  const inId = idAfter('/in/', loc(await a('/in/create', { method: 'POST', text: fi.toString() })));
  await a(`/in/${inId}/submit`, { method: 'POST', form: {} });

  const rp = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  const si = (/<tr><td><input type="checkbox" name="pick" value="(\d+)">([\s\S]*?)<\/tr>/.exec(rp) || [])[1];
  check('领用页有该物资', !!si);

  // 申请 100
  const fr = new URLSearchParams();
  fr.append('project_id', '1'); fr.append('team_id', teamId); fr.append('major_id', majorId);
  fr.append('pick', si); fr.append('qty_' + si, '100');
  fr.append('_ft', 'jjr' + Date.now().toString(16));
  const reqId = idAfter('/req/', loc(await a('/req/save', { method: 'POST', text: fr.toString() })));
  await a(`/req/${reqId}/submit`, { method: 'POST', form: {} });

  // 出库 90
  const pickPage = await text(await a(`/out/${reqId}`));
  const lineId = (/name="pick" value="(\d+)"/.exec(pickPage) || [])[1];
  const fo = new URLSearchParams();
  fo.append('req_id', reqId); fo.append('pick', lineId); fo.append('qty_' + lineId, '90');
  fo.append('_ft', 'jjo' + Date.now().toString(16));
  check('出库 90 成功', loc(await a('/out/save', { method: 'POST', text: fo.toString() })).includes('出库完成'));

  let detail = await text(await a(`/req/${reqId}`));
  check('状态变为部分出库', detail.includes('部分出库'));
  check('明细显示待出 10', /待出库[\s\S]*?<b>10<\/b>/.test(detail));
  check('出现「放弃领用」按钮', detail.includes('/close-line'));

  // 结存剩 10，但仍被这张单占着 → 可申请 0
  let stockPage = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  check('未了结时可申请被占满（0）', /<b>0<\/b>/.test(stockPage), '可申请应被占用');

  // 了结剩余
  check('放弃领用成功', loc(await a(`/req/${reqId}/close-line`, { method: 'POST', form: { item_id: si } })).includes('已放弃领用'));
  detail = await text(await a(`/req/${reqId}`));
  check('全部了结后状态为该单已结束', detail.includes('已出库'), detail.includes('部分出库') ? '仍是部分出库' : '');
  check('待出库归零', /待出库[\s\S]*?<b>0<\/b>/.test(detail));
  check('出现放弃领用记录', detail.includes('放弃领用记录'));

  // 占用量释放：可申请恢复为 10（库存剩 10，无人占用）
  stockPage = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  check('了结后占用释放（可申请 10）', /<b>10<\/b>/.test(stockPage));

  // 不能再出库
  const outAgain = await a(`/out/${reqId}`);
  check('已了结的单不能再出库', outAgain.status === 302 || loc(outAgain).includes('不可出库'));

  // 撤销了结
  const cid = (/name="closure_id" value="(\d+)"/.exec(detail) || [])[1];
  check('有撤销入口', !!cid);
  check('撤销成功', loc(await a(`/req/${reqId}/unclose`, { method: 'POST', form: { closure_id: cid } })).includes('已撤销'));
  detail = await text(await a(`/req/${reqId}`));
  check('撤销后回到部分出库', detail.includes('部分出库'));
  check('撤销后待出恢复 10', /待出库[\s\S]*?<b>10<\/b>/.test(detail));

  // ===== 权限：领料员可了结（不限于制单人），仓管员不行 =====
  const usersHtml = await text(await a('/users'));
  const rid = (label) => {
    const m = new RegExp('<option value="(\\d+)"[^>]*>' + label + '</option>').exec(usersHtml);
    return m ? m[1] : '';
  };
  const pickerRole = rid('领料员');
  const keeperRole = rid('仓管员');
  check('能解析领料员/仓管员角色', !!pickerRole && !!keeperRole, pickerRole + '/' + keeperRole);

  await a('/users/save', { method: 'POST', form: { username: 'jj_picker', name: '了结领料员', role_id: pickerRole, password: 'test1234', active: '1', projects: '1' } });
  await a('/users/save', { method: 'POST', form: { username: 'jj_keeper', name: '了结仓管员', role_id: keeperRole, password: 'test1234', active: '1', projects: '1' } });

  const pk = client();
  const kp = client();
  await pk('/login', { method: 'POST', form: { username: 'jj_picker', password: 'test1234' } });
  await kp('/login', { method: 'POST', form: { username: 'jj_keeper', password: 'test1234' } });

  const kpDetail = await kp(`/req/${reqId}`);
  const kpBody = await text(kpDetail);
  check('仓管员能打开单据详情', kpDetail.status === 200);
  check('仓管员看不到「放弃领用」按钮', !kpBody.includes('/close-line'));
  check('仓管员强行了结被拒（403）', (await kp(`/req/${reqId}/close-line`, { method: 'POST', form: { item_id: si } })).status === 403);
  check('被拒后单据仍是部分出库', (await text(await kp(`/req/${reqId}`))).includes('部分出库'));

  const pkDetail = await text(await pk(`/req/${reqId}`));
  check('领料员看得到「放弃领用」按钮', pkDetail.includes('/close-line'));
  check('领料员能放弃领用（非制单人也可）', loc(await pk(`/req/${reqId}/close-line`, { method: 'POST', form: { item_id: si } })).includes('已放弃领用'));
  check('了结后单据结束', (await text(await pk(`/req/${reqId}`))).includes('已出库'));

  // 领用明细页（按行展开）也必须按「减已了结」口径，否则会一直挂着待出
  const itemsPage = await text(await a('/req/items?q=了结测试料'));
  check('领用明细有「放弃领用」列', itemsPage.includes('放弃领用'));
  check('领用明细待出合计归零', /待出库合计 0(\.0+)?/.test(itemsPage), (itemsPage.match(/待出库合计\s*([\d.]+)/) || [])[1]);

  // 列表页：部分出库按钮 + 待出列
  const list = await text(await a('/req/list'));
  check('列表有「部分出库」按钮', list.includes('name="status"') && list.includes('部分出库'));
  check('列表有「待出库」列', list.includes('待出库'));
  const partList = await text(await a('/req/list?status=part'));
  check('筛选后只含部分出库单', partList.includes('部分出库') && !/badge done/.test(partList));

  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
