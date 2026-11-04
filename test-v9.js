'use strict';
/* 出库明细 / 退库明细页验证：建单造数、列展开、筛选、导出、权限 */
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

  /* ---------- 造数据：入库 100 → 领用 60 → 出库 60 → 退库 20 ---------- */
  await a('/teams/save', { method: 'POST', form: { name: '明细测试班组', sort: '1', active: '1' } });
  const teamId = (/(teams\?edit=(\d+))/.exec(await text(await a('/teams'))) || [])[2];
  const inNew = await text(await a('/in/new'));
  const majorId = (/name="major_id"[\s\S]{0,400}?<option value="(\d+)"/.exec(inNew) || [])[1] || '1';

  const fi = new URLSearchParams();
  fi.append('project_id', '1'); fi.append('major_id', majorId); fi.append('arrival_date', '2026-11-04');
  fi.append('text', ['序号\t工程名称\t物资名称\t规格型号\t技术要求\t单位\t数量\t需求计划编号',
    '1\t公司公用\t明细页测试角钢\t50×5\tGB/T 9787\t根\t100\tPLAN-MX-1'].join('\n'));
  fi.append('_ft', 'mx' + Date.now().toString(16));
  const inId = idAfter('/in/', loc(await a('/in/create', { method: 'POST', text: fi.toString() })));
  await a(`/in/${inId}/submit`, { method: 'POST', form: {} });

  const rp = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  const siId = (/name="pick" value="(\d+)"/.exec(rp) || [])[1];
  const fr = new URLSearchParams();
  fr.append('project_id', '1'); fr.append('team_id', teamId); fr.append('major_id', majorId);
  fr.append('pick', siId); fr.append('qty_' + siId, '60'); fr.append('_ft', 'mxr' + Date.now().toString(16));
  const reqId = idAfter('/req/', loc(await a('/req/save', { method: 'POST', text: fr.toString() })));
  await a(`/req/${reqId}/submit`, { method: 'POST', form: {} });

  const pp = await text(await a(`/out/${reqId}`));
  const lineId = (/name="pick" value="(\d+)"/.exec(pp) || [])[1];
  const fo = new URLSearchParams();
  fo.append('req_id', reqId); fo.append('pick', lineId); fo.append('qty_' + lineId, '60'); fo.append('_ft', 'mxo' + Date.now().toString(16));
  check('造出库单', loc(await a('/out/save', { method: 'POST', text: fo.toString() })).includes('出库完成'));

  const rtp = await text(await a(`/ret/${reqId}`));
  const retLine = (/name="pick" value="(\d+)"/.exec(rtp) || [])[1];
  const ft = new URLSearchParams();
  ft.append('req_id', reqId); ft.append('pick', retLine); ft.append('qty_' + retLine, '20');
  ft.append('remark', '明细页测试退料'); ft.append('_ft', 'mxt' + Date.now().toString(16));
  check('造退库单', loc(await a('/ret/save', { method: 'POST', text: ft.toString() })).includes('退料完成'));

  /* ---------- 1. 出库明细 ---------- */
  const nav = await text(await a('/'));
  check('侧栏有「出库明细」', nav.includes('>出库明细</a>'));
  check('侧栏有「退库明细」', nav.includes('>退库明细</a>'));

  const out = await a('/out/items');
  const outHtml = await text(out);
  check('出库明细页可访问', out.status === 200);
  check('列头含「出库单号」', outHtml.includes('出库单号'));
  check('列头含「领料单号」', outHtml.includes('领料单号'));
  check('列出测试物资行', outHtml.includes('明细页测试角钢'));
  check('显示数量 60', />60(\.0+)?</.test(outHtml));
  check('显示行数统计', /共 \d+ 行/.test(outHtml));

  const outQ = await text(await a('/out/items?q=' + encodeURIComponent('角钢')));
  check('按物资关键字命中', outQ.includes('明细页测试角钢'));
  const outEmpty = await text(await a('/out/items?q=' + encodeURIComponent('不存在的物资XYZ')));
  check('关键字无结果给空提示', outEmpty.includes('没有符合条件的出库明细'));
  const outTeam = await text(await a('/out/items?team=' + teamId));
  check('按施工队伍筛选命中', outTeam.includes('明细页测试角钢'));
  const outDate = await text(await a('/out/items?from=2030-01-01'));
  check('日期区间筛选生效', outDate.includes('没有符合条件的出库明细'));

  /* ---------- 2. 退库明细 ---------- */
  const ret = await a('/ret/items');
  const retHtml = await text(ret);
  check('退库明细页可访问', ret.status === 200);
  check('列头含「退料单号」', retHtml.includes('退料单号'));
  check('列出测试物资行', retHtml.includes('明细页测试角钢'));
  check('显示退库数量 20', />20(\.0+)?</.test(retHtml));

  /* ---------- 3. 导出 ---------- */
  const exOut = await a('/export?kind=out');
  const bufOut = Buffer.from(await exOut.arrayBuffer());
  check('导出出库明细为 xlsx', exOut.status === 200 && bufOut.slice(0, 2).toString() === 'PK');
  const exRet = await a('/export?kind=ret');
  const bufRet = Buffer.from(await exRet.arrayBuffer());
  check('导出退库明细为 xlsx', exRet.status === 200 && bufRet.slice(0, 2).toString() === 'PK');

  /* ---------- 4. 权限 ---------- */
  const rolesHtml = await text(await a('/roles'));
  const keeperId = (() => {
    const trs = rolesHtml.match(/<tr[\s\S]*?<\/tr>/g) || [];
    const tr = trs.find((x) => x.includes('仓管员'));
    return tr ? (/edit=(\d+)/.exec(tr) || [])[1] : '';
  })();
  check('仓管员角色存在', !!keeperId, keeperId);

  await a('/users/save', { method: 'POST', form: { username: 'mx_keeper', name: '明细仓管员', role_id: String(keeperId), password: 'mx123456', active: '1', projects: '1' } });
  const k = client();
  await k('/login', { method: 'POST', form: { username: 'mx_keeper', password: 'mx123456' } });
  check('仓管员可进出库明细', (await k('/out/items')).status === 200);
  check('仓管员可进退库明细', (await k('/ret/items')).status === 200);

  const cr = await a('/roles/create', { method: 'POST', form: { name: '明细测试无权限角色', note: '' } });
  const noPermRole = (/edit=(\d+)/.exec(loc(cr)) || [])[1];
  await a('/users/save', { method: 'POST', form: { username: 'mx_none', name: '明细无权限员', role_id: String(noPermRole), password: 'mx654321', active: '1', projects: '1' } });
  const n = client();
  await n('/login', { method: 'POST', form: { username: 'mx_none', password: 'mx654321' } });
  check('无权限账号访问出库明细被拒', (await n('/out/items')).status === 403);
  check('无权限账号访问退库明细被拒', (await n('/ret/items')).status === 403);

  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2); });
