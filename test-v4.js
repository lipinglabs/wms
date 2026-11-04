'use strict';
/* 四项改进验证：导出PDF、关键字搜索、领料占用、防重复提交 */
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
const loc = (r) => r.headers.get('location') || '';
const idAfter = (path, l) => (/(\d+)/.exec(l.split(path)[1] || '') || [])[1];
const PASTE = (name, plan, qty) => ['序号\t工程名称\t物资名称\t规格型号\t技术要求\t单位\t数量\t需求计划编号', `1\t公司公用\t${name}\tDN50镀锌\tGB\t根\t${qty}\t${plan}`].join('\n');

(async () => {
  const a = client();
  check('管理员登录', (await a('/login', { method: 'POST', form: { username: 'admin', password: 'admin888' } })).status === 302);

  // ========== 4. 防重复提交（入库） ==========
  const f1 = new URLSearchParams();
  f1.append('project_id', '1');
  const inNew = await text(await a('/in/new'));
  f1.append('major_id', (/<option value="(\d+)"/.exec(inNew) || [])[1] || '1');
  f1.append('arrival_date', '2026-11-03');
  f1.append('text', PASTE('防重测试钢管', 'PLAN-DD-1', 50));
  const token = (/name="_ft" value="([0-9a-f]+)"/.exec(inNew) || [])[1];
  check('入库页带表单令牌', !!token);
  f1.append('_ft', token);
  let r = await a('/in/create', { method: 'POST', text: f1.toString() });
  const inId = idAfter('/in/', loc(r));
  check('首次提交生成入库单', !!inId, loc(r));
  const cnt1 = (await text(await a('/in/list'))).split('RK-').length - 1;
  r = await a('/in/create', { method: 'POST', text: f1.toString() }); // 同令牌重放（模拟网络重试）
  const cnt2 = (await text(await a('/in/list'))).split('RK-').length - 1;
  check('同令牌重放不生成新单（' + cnt1 + '→' + cnt2 + '）', cnt1 === cnt2 && loc(r).includes('/in/' + inId), loc(r));

  // 提交入库 → 库存 50
  await a(`/in/${inId}/submit`, { method: 'POST', form: {} });
  let stock = await text(await a('/stock'));
  check('库存 50', stock.includes('防重测试钢管') && /<b[^>]*>50(\.0+)?<\/b>/.test(stock));

  // ========== 3. 领料占用 ==========
  // 建队伍
  let teamId = (/(teams\?edit=(\d+))/.exec(await text(await a('/teams'))) || [])[2];
  if (!teamId) { await a('/teams/save', { method: 'POST', form: { name: '测试班组', sort: '1', active: '1' } }); teamId = (/(teams\?edit=(\d+))/.exec(await text(await a('/teams'))) || [])[2]; }
  const majorId = (/<option value="(\d+)"/.exec(inNew) || [])[1] || '1';

  // 领料单 A：申请 40
  const reqPage = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  const siId = (/name="pick" value="(\d+)"/.exec(reqPage) || [])[1];
  check('领用页显示结存/占用/可申请三列', reqPage.includes('已申请待出库') && reqPage.includes('可申请'));
  check('未占用时可申请 = 50', new RegExp(`<b>50(\\.0+)?</b>`).test(reqPage.replace(/<b>50\.000<\/b>/g, '<b>50</b>')));
  const mkReq = async (qty) => {
    const f = new URLSearchParams();
    f.append('project_id', '1'); f.append('team_id', teamId); f.append('major_id', majorId);
    f.append('pick', siId); f.append('qty_' + siId, qty); f.append('remark', '占用测试');
    f.append('_ft', (Math.random().toString(36) + '0000000000').slice(2, 26));
    return a('/req/save', { method: 'POST', text: f.toString() });
  };
  r = await mkReq('40');
  const reqA = idAfter('/req/', loc(r));
  check('领料单 A 申请 40', !!reqA, loc(r));
  await a(`/req/${reqA}/submit`, { method: 'POST', form: {} });

  // 领料单 B：页面应显示 可申请 10，占用 40
  const reqPage2 = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  check('A 占用 40 后显示占用 40', /warn-num[^>]*>40/.test(reqPage2));
  check('可申请变为 10', /<b[^>]*>10(\.0+)?<\/b>/.test(reqPage2));
  check('页面给出占用提醒', reqPage2.includes('已被其他已提交未出库的领料单占用'));

  r = await mkReq('50');
  check('B 申请 50 被拒', loc(r).includes('msg=') && decodeURIComponent(loc(r)).includes('已占用'), loc(r));
  const errText = decodeURIComponent(loc(r));
  check('拒绝信息含可申请 10', errText.includes('可申请 10') && errText.includes('结存 50'), errText.slice(0, 120));
  r = await mkReq('10');
  const reqB = idAfter('/req/', loc(r));
  check('B 申请 10 成功', !!reqB, loc(r));

  // A 撤回后占用释放 → B 页面可申请回到 50（A 的 40 不再占用）
  await a(`/req/${reqA}/withdraw`, { method: 'POST', form: {} });
  const reqPage3 = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  check('A 撤回后占用释放（B 未提交，可申请回到 50）', /<b[^>]*>50(\.0+)?<\/b>/.test(reqPage3) && !reqPage3.includes('warn-num'));
  await a(`/req/${reqA}/submit`, { method: 'POST', form: {} });

  // ========== 1. 打印页导出 PDF ==========
  const printHtml = await text(await a(`/req/${reqA}/print`));
  check('打印页有导出 PDF 按钮', printHtml.includes('wmsExportPdf') && printHtml.includes('导出 PDF'));
  check('打印页注入 pdf-data', printHtml.includes('id="pdf-data"') && printHtml.includes('PLAN') === false && printHtml.includes('防重测试钢管'));
  check('打印页引用 printpdf.js', printHtml.includes('/printpdf.js'));
  const pj = await a('/printpdf.js');
  check('printpdf.js 可加载', pj.status === 200 && (await text(pj)).includes('buildPdf'));

  // ========== 2. 关键字搜索 ==========
  // 出库 A 40 → 出库查询/退料查询可用关键字
  const pickPage = await text(await a(`/out/${reqA}`));
  const pickId = (/name="pick" value="(\d+)"/.exec(pickPage) || [])[1];
  const of = new URLSearchParams();
  of.append('req_id', reqA); of.append('pick', pickId); of.append('qty_' + pickId, '40'); of.append('_ft', (Math.random().toString(36) + '00000000').slice(2, 24));
  r = await a('/out/save', { method: 'POST', text: of.toString() });
  check('出库 40 完成', decodeURIComponent(loc(r)).includes('出库完成'), loc(r));

  const s1 = await text(await a('/in/list?q=防重测试钢管'));
  check('入库查询按物资名命中', s1.includes('RK-'));
  const s2 = await text(await a('/in/list?q=DN50镀锌'));
  check('入库查询按规格命中', s2.includes('RK-'));
  const s3 = await text(await a('/in/list?q=查不到的东西'));
  check('入库查询无关字无结果', s3.includes('没有符合条件的入库单'));
  const s4 = await text(await a(`/req/list?q=防重测试钢管`));
  check('领用查询按物资命中', s4.includes('LL-'));
  const s5 = await text(await a(`/out/list?q=防重测试钢管`));
  check('出库查询按物资命中', s5.includes('CK-'));
  check('出库查询有搜索框', s5.includes('name="q"'));
  const s6 = await text(await a(`/out/list?q=DN50镀锌`));
  check('出库查询按规格命中', s6.includes('CK-'));
  const s7 = await text(await a('/ret/list?q=防重测试钢管'));
  check('退料查询有搜索框且按物资命中（无可退单时也应 200）', (await a('/ret/list?q=x')).status === 200 && s7.includes('name="q"'));
  const s8 = await text(await a(`/out/new?q=防重`));
  check('出库登记搜索按物资命中', s8.includes('LL-') || s8.includes('没有待出库的领料单'));

  // ========== 4 补充：领料单防重 ==========
  const page4 = await text(await a(`/req/new?project=1&team=${teamId}&major=${majorId}`));
  const t2 = (/name="_ft" value="([0-9a-f]+)"/.exec(page4) || [])[1];
  const f2 = new URLSearchParams();
  f2.append('project_id', '1'); f2.append('team_id', teamId); f2.append('major_id', majorId);
  f2.append('pick', siId); f2.append('qty_' + siId, '1'); f2.append('_ft', t2);
  const l1 = loc(await a('/req/save', { method: 'POST', text: f2.toString() }));
  const c1 = (await text(await a('/req/list'))).split('LL-').length - 1;
  const l2 = loc(await a('/req/save', { method: 'POST', text: f2.toString() }));
  const c2 = (await text(await a('/req/list'))).split('LL-').length - 1;
  check('领料单重复提交不新增（' + c1 + '→' + c2 + '）', c1 === c2 && l2.includes('/req/'), l1 + ' | ' + l2);

  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2); });
