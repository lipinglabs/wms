// 端到端自测：入库 → 领用 → 出库 → 退料 → 库存
const BASE = process.env.BASE || 'http://127.0.0.1:8098';
let sid = '';
let pass = 0;
let fail = 0;
const log = (ok, name, extra) => {
  if (ok) pass++;
  else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''));
};

async function req(p, opt = {}) {
  const headers = { ...(sid ? { Cookie: 'sid=' + sid } : {}), ...(opt.headers || {}) };
  let body = opt.body;
  if (opt.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(opt.form)) {
      if (Array.isArray(v)) v.forEach((x) => usp.append(k, x));
      else usp.append(k, v);
    }
    body = usp.toString();
  }
  const r = await fetch(BASE + p, { method: opt.method || 'GET', headers, body, redirect: 'manual' });
  const setc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of setc) {
    const m = /^sid=([^;]*)/.exec(c);
    if (m) sid = m[1];
  }
  return r;
}
const text = (r) => r.text();
const loc = (r) => decodeURIComponent(r.headers.get('location') || '');

(async () => {
  let r = await req('/login', { method: 'POST', form: { username: 'admin', password: 'admin888' } });
  log(r.status === 302, '登录', 'status=' + r.status);

  r = await req('/teams/save', { method: 'POST', form: { name: '管道一班', sort: 1, active: 1 } });
  log(r.status === 302 && !loc(r).includes('err=1'), '新建施工队伍');

  // 入库：粘贴导入，3 行
  const rows = [
    ['1', '公司公用', '', '6.4不锈钢管', '3/4" PE,316L Ф26.7X3.91mm', '', '支', '10', 'SD-MAL-HG-LQ-PI-1015-03'],
    ['2', '公司公用', 'WD-002', '镀锌角钢', 'L50×5', 'GB/T 706', '根', '20', 'SD-MAL-HG-LQ-PI-1015-03'],
    ['3', '公司公用', '', '不锈钢焊条', 'A102 Φ3.2', '', '公斤', '5', 'SD-MAL-HG-LQ-PI-1016-01'],
  ];
  const paste = rows.map((r2) => r2.join('\t')).join('\n');
  r = await req('/in/create', {
    method: 'POST',
    form: { project_id: 1, major_id: 1, arrival_date: '2026-11-03', remark: '首批到货', text: paste },
  });
  const inLoc = loc(r);
  log(r.status === 302 && /\/in\/\d+/.test(inLoc), '导入生成入库单', inLoc);

  const inId = Number((/\/in\/(\d+)/.exec(inLoc) || [])[1] || 0);
  r = await req('/in/' + inId);
  let html = await text(r);
  log(r.status === 200 && html.includes('SD-MAL-HG-LQ-PI-1015-03'), '入库单详情含计划编号');
  log(html.includes('不锈钢焊条'), '明细 3 行已落库');

  r = await req('/in/' + inId + '/submit', { method: 'POST' });
  log(r.status === 302, '提交入库', loc(r));
  r = await req('/stock');
  html = await text(r);
  log(html.includes('6.4不锈钢管') && html.includes('镀锌角钢'), '库存出现 3 条');

  // 重复导入应被拒
  r = await req('/in/create', {
    method: 'POST',
    form: { project_id: 1, major_id: 1, arrival_date: '2026-11-03', text: paste },
  });
  html = await text(r);
  log(r.status === 200 && html.includes('不能重复导入'), '重复导入被拦截');

  // 领用
  r = await req('/req/new?project=1&team=1&major=1');
  html = await text(r);
  log(r.status === 200 && html.includes('6.4不锈钢管'), '领用页列出现存物资');
  const ids = [...html.matchAll(/name="pick" value="(\d+)"/g)].map((m) => m[1]);
  log(ids.length >= 2, '可勾选物资条数', String(ids.length));

  r = await req('/req/save', {
    method: 'POST',
    form: { project_id: 1, team_id: 1, major_id: 1, pick: [ids[0], ids[1]], ['qty_' + ids[0]]: '4', ['qty_' + ids[1]]: '2', remark: '现场领用' },
  });
  const reqLoc = loc(r);
  log(r.status === 302 && /\/req\/\d+/.test(reqLoc), '生成领料申请单', reqLoc);
  const reqId = Number((/\/req\/(\d+)/.exec(reqLoc) || [])[1] || 0);

  r = await req('/req/' + reqId + '/submit', { method: 'POST' });
  log(r.status === 302, '提交领料申请');

  r = await req('/req/' + reqId + '/print');
  html = await text(r);
  log(r.status === 200 && html.includes('领料申请单') && html.includes('发料'), '领料单打印页');

  // 出库（第一行全出）
  r = await req('/out/' + reqId);
  html = await text(r);
  const lineIds = [...html.matchAll(/name="pick" value="(\d+)"/g)].map((m) => m[1]);
  log(r.status === 200 && lineIds.length === 2, '出库页待出 2 行');

  r = await req('/out/save', { method: 'POST', form: { req_id: reqId, pick: lineIds[0], ['qty_' + lineIds[0]]: '4' } });
  log(r.status === 302 && !loc(r).includes('err=1'), '出库第一行', loc(r));

  r = await req('/req/' + reqId);
  html = await text(r);
  log(html.includes('部分出库'), '领料单变为部分出库');

  r = await req('/out/save', { method: 'POST', form: { req_id: reqId, pick: lineIds[1], ['qty_' + lineIds[1]]: '2' } });
  r = await req('/req/' + reqId);
  html = await text(r);
  log(html.includes('已出库'), '领料单变为已出库');

  // 退料 1 支
  r = await req('/ret/' + reqId);
  html = await text(r);
  const retIds = [...html.matchAll(/name="pick" value="(\d+)"/g)].map((m) => m[1]);
  log(r.status === 200 && retIds.length >= 1, '退料页列出可退物资');

  r = await req('/ret/save', { method: 'POST', form: { req_id: reqId, pick: retIds[0], ['qty_' + retIds[0]]: '1' } });
  log(r.status === 302 && !loc(r).includes('err=1'), '退料入库', loc(r));

  // 库存核对：第一行 10 - 4 + 1 = 7
  r = await req('/stock');
  html = await text(r);
  const tb = (html.match(/6\.4不锈钢管[\s\S]{0,600}?<\/tr>/) || [''])[0];
  log(/<b>7<\/b>/.test(tb), '库存结存 10-4+1=7', (tb.match(/<b>[\d.]+<\/b>/) || [''])[0]);

  // 超领拦截
  r = await req('/req/new?project=1&team=1&major=1');
  html = await text(r);
  const ids2 = [...html.matchAll(/name="pick" value="(\d+)"/g)].map((m) => m[1]);
  if (ids2.length) {
    r = await req('/req/save', { method: 'POST', form: { project_id: 1, team_id: 1, major_id: 1, pick: ids2[0], ['qty_' + ids2[0]]: '999' } });
    log(loc(r).includes('err=1'), '超领被拦截', loc(r).slice(0, 80));
  } else {
    log(false, '超领测试前置失败');
  }

  // 出库查询 / 退料查询 / 入库明细 / 导出
  for (const p of ['/in/list', '/in/items', '/req/list', '/out/list', '/ret/list']) {
    r = await req(p);
    log(r.status === 200, '页面 ' + p);
  }
  r = await req('/export?kind=stock');
  const buf = Buffer.from(await r.arrayBuffer());
  log(r.status === 200 && buf.slice(0, 2).toString() === 'PK' && buf.length > 2000, '导出库存 xlsx', buf.length + 'B');

  r = await req('/export?kind=in_items');
  const buf2 = Buffer.from(await r.arrayBuffer());
  log(buf2.slice(0, 2).toString() === 'PK', '导出入库明细 xlsx', buf2.length + 'B');

  r = await req('/in/template');
  const buf3 = Buffer.from(await r.arrayBuffer());
  log(buf3.slice(0, 2).toString() === 'PK', '下载导入模板', buf3.length + 'B');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(2);
});
