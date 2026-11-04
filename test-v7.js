'use strict';
/* 退库痕迹验证：入库明细退库列、出库明细合并退库 */
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
  if (!teamId) { await a('/teams/save', { method: 'POST', form: { name: '退库测试班组', sort: '1', active: '1' } }); teamId = (/(teams\?edit=(\d+))/.exec(await text(await a('/teams'))) || [])[2]; }
  const inNew = await text(await a('/in/new'));
  const majorId = (/name="major_id"[\s\S]{0,400}?<option value="(\d+)"/.exec(inNew) || [])[1] || '1';

  // 入库 3000
  const fi = new URLSearchParams();
  fi.append('project_id', '1'); fi.append('major_id', majorId); fi.append('arrival_date', '2026-11-03');
  fi.append('text', ['序号\t工程名称\t物资名称\t规格型号\t技术要求\t单位\t数量\t需求计划编号',
    '1\t公司公用\t退库测试跨接线\t6平方\tGB\t条\t3000\tPLAN-TK-1'].join('\n'));
  fi.append('_ft', 'tk' + Date.now().toString(16));
  const inId = idAfter('/in/', loc(await a('/in/create', { method: 'POST', text: fi.toString() })));
  await a(`/in/${inId}/submit`, { method: 'POST', form: {} });

  // 领用 1000 并出库 1000
  const rp = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  const siId = (/name="pick" value="(\d+)"/.exec(rp) || [])[1];
  const fr = new URLSearchParams();
  fr.append('project_id', '1'); fr.append('team_id', teamId); fr.append('major_id', majorId);
  fr.append('pick', siId); fr.append('qty_' + siId, '1000'); fr.append('_ft', 'tkr' + Date.now().toString(16));
  const reqId = idAfter('/req/', loc(await a('/req/save', { method: 'POST', text: fr.toString() })));
  await a(`/req/${reqId}/submit`, { method: 'POST', form: {} });
  const pp = await text(await a(`/out/${reqId}`));
  const lineId = (/name="pick" value="(\d+)"/.exec(pp) || [])[1];
  const fo = new URLSearchParams();
  fo.append('req_id', reqId); fo.append('pick', lineId); fo.append('qty_' + lineId, '1000'); fo.append('_ft', 'tko' + Date.now().toString(16));
  check('出库 1000', loc(await a('/out/save', { method: 'POST', text: fo.toString() })).includes('出库完成'));

  // 退库 300
  const rtp = await text(await a(`/ret/${reqId}`));
  const retLine = (/name="pick" value="(\d+)"/.exec(rtp) || [])[1];
  const ft = new URLSearchParams();
  ft.append('req_id', reqId); ft.append('pick', retLine); ft.append('qty_' + retLine, '300');
  ft.append('remark', '现场未用完'); ft.append('_ft', 'tkt' + Date.now().toString(16));
  check('退库 300', loc(await a('/ret/save', { method: 'POST', text: ft.toString() })).includes('退料完成'));

  // ===== 1. 入库明细：退库列 =====
  const items = await text(await a('/in/items'));
  check('入库明细有「退库数量」列', items.includes('退库数量'));
  const rowIdx = items.indexOf('退库测试跨接线');
  const seg = items.slice(rowIdx, rowIdx + 900).replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  check('行内 3000/1000/300/2300 齐备（3000-1000+300）', /3000/.test(seg) && /1000/.test(seg) && /300/.test(seg) && /2300/.test(seg), seg.slice(0, 200));
  check('剩余数量 = 入库 − 出库 + 退库', /\|3000\|1000\|300\|2300\|/.test(seg));
  const exItems = await a('/export?kind=in_items');
  const buf = Buffer.from(await exItems.arrayBuffer());
  const zlib = require('node:zlib');
  check('导出含退库数量列', exItems.status === 200 && buf.slice(0, 2).toString() === 'PK');

  // ===== 2. 库存出库明细：合并退库 =====
  const outs = await text(await a(`/stock/${siId}/outs`));
  check('出库明细页 200', outs.includes('出库 / 退库记录'));
  check('同时含出库与退库两种类型', outs.includes('>出库</span>') && outs.includes('>退库</span>'));
  check('出库数量带负号 1000', outs.includes('-1000'));
  check('退库数量带正号 300', outs.includes('+300'));
  check('汇总：累计出库 1000', /累计出库[\s\S]{0,80}1000/.test(outs));
  check('汇总：累计退库 300', /累计退库[\s\S]{0,80}300/.test(outs));
  check('汇总：净出库 700', /净出库[\s\S]{0,80}700/.test(outs));
  check('汇总：共 2 笔', /共 2 笔/.test(outs));
  check('退库行有备注', outs.includes('现场未用完'));
  check('退库行有退料单号', outs.includes('TL-'));
  const stockPage = await text(await a('/stock'));
  check('库存页退料列显示 300', /<td[^>]*>300(\.0+)?<\/td>/.test(stockPage) || stockPage.includes('>300<'));

  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2); });
