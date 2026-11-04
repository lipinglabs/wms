// 端到端 + 项目隔离自测（全程 UTF-8）
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8099';

let sid = '';
async function req(path, opt = {}) {
  const res = await fetch(BASE + path, {
    method: opt.method || 'GET',
    headers: {
      ...(sid ? { Cookie: 'sid=' + sid } : {}),
      ...(opt.body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' } : {}),
    },
    body: opt.body,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  sc.forEach((c) => {
    const m = c.match(/^sid=([^;]*)/);
    if (m) sid = m[1];
  });
  return res;
}
const results = [];
const check = (n, ok, d) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' | ' + d : ''));
};
const text = async (p) => (await req(p)).text();
const status = async (p) => (await req(p)).status;
const loc = (r) => decodeURIComponent(r.headers.get('location') || '');

(async () => {
  check('登录跳转', (await req('/login', { method: 'POST', body: new URLSearchParams({ username: 'admin', password: 'admin888' }) })).status === 302);

  // 项目 A / B
  const tag = Date.now().toString().slice(-5);
  let r = await req('/projects/save', { method: 'POST', body: new URLSearchParams({ code: 'PA' + tag, name: '甲项目' + tag, active: '1' }) });
  check('创建项目甲', r.status === 302);
  r = await req('/projects/save', { method: 'POST', body: new URLSearchParams({ code: 'PB' + tag, name: '乙项目' + tag, active: '1' }) });
  check('创建项目乙', r.status === 302);

  const projHtml = await text('/projects');
  // 名称首次出现在“上级项目”下拉里，必须定位表格单元格中的那一行
  const idOf = (name) => {
    const re = new RegExp('<td>[^<]*' + name + '[\\s\\S]{0,700}?/projects\\?edit=(\\d+)');
    const m = projHtml.match(re);
    return m ? m[1] : null;
  };
  const projA = idOf('甲项目' + tag);
  const projB = idOf('乙项目' + tag);
  check('解析项目 ID', !!projA && !!projB, `A=${projA} B=${projB}`);

  // 商品
  const code = 'T' + tag;
  await req('/products/save', {
    method: 'POST',
    body: new URLSearchParams({ code, name: '镀锌钢管', spec: 'DN50×3.5', unit_id: '3', min_qty: '20', category_id: '1', active: '1' }),
  });
  const listHtml = await text('/products?q=' + encodeURIComponent(code));
  check('中文名称正确回显', listHtml.includes('镀锌钢管') && listHtml.includes('DN50×3.5'));
  const pid = (listHtml.match(/\/products\?edit=(\d+)/) || [])[1];

  // 未选项目的单据必须被拒
  r = await req('/docs/purchase_in/save', { method: 'POST', body: new URLSearchParams([['doc_date', '2026-11-03'], ['wh_id', '1'], ['item_product', pid], ['item_qty', '10']]) });
  check('未选项目被拒', loc(r).includes('请选择归属项目'), loc(r).split('msg=')[1] || '');

  // 甲项目入库 100
  r = await req('/docs/purchase_in/save', {
    method: 'POST',
    body: new URLSearchParams([
      ['doc_date', '2026-11-03'], ['wh_id', '1'], ['project_id', projA], ['remark', '甲项目入库'],
      ['item_product', pid], ['item_qty', '100'],
    ]),
  });
  const docIn = (loc(r).match(/\/docs\/(\d+)/) || [])[1];
  check('甲项目入库单创建', !!docIn);
  r = await req('/docs/' + docIn + '/approve', { method: 'POST', body: new URLSearchParams('') });
  check('入库审核通过', r.status === 302);

  // 甲项目出库 40 → 允许
  r = await req('/docs/sale_out/save', {
    method: 'POST',
    body: new URLSearchParams([['doc_date', '2026-11-03'], ['wh_id', '1'], ['project_id', projA], ['item_product', pid], ['item_qty', '40']]),
  });
  const docOutA = (loc(r).match(/\/docs\/(\d+)/) || [])[1];
  r = await req('/docs/' + docOutA + '/approve', { method: 'POST', body: new URLSearchParams('') });
  check('甲项目出库 40 成功', r.status === 302 && !loc(r).includes('err=1'));

  // 乙项目出库 10 → 必须拒绝（库存隔离）
  r = await req('/docs/sale_out/save', {
    method: 'POST',
    body: new URLSearchParams([['doc_date', '2026-11-03'], ['wh_id', '1'], ['project_id', projB], ['item_product', pid], ['item_qty', '10']]),
  });
  const docOutB = (loc(r).match(/\/docs\/(\d+)/) || [])[1];
  r = await req('/docs/' + docOutB + '/approve', { method: 'POST', body: new URLSearchParams('') });
  check('乙项目无法使用甲项目库存', loc(r).includes('库存不足'), loc(r).split('msg=')[1] || '');

  // 库存视图：甲 60，乙 0/不可见
  const stock = await text('/stock?q=' + encodeURIComponent(code));
  check('甲项目结存 60', /甲项目[\s\S]{0,400}?<b>60<\/b>/.test(stock), '');
  check('库存页出现项目列', stock.includes('甲项目' + tag));

  // 汇总：期初/入库/出库/期末
  const sum = await text('/reports/summary?from=2026-11-01&to=2026-11-30&q=');
  check('汇总页含项目列', sum.includes('项目'));

  // 导出
  const res = await req('/export?kind=stock&project=' + projA);
  const buf = Buffer.from(await res.arrayBuffer());
  check('导出 xlsx 是 zip', buf.slice(0, 2).toString() === 'PK', buf.length + ' 字节');
  fs.writeFileSync('D:/wms/e2e-export.xlsx', buf);

  // 打印
  const print = await text('/docs/' + docIn + '/print');
  check('打印页含中文与单号', print.includes('采购入库单') && print.includes('镀锌钢管'));

  // 未登录
  sid = '';
  r = await req('/stock');
  check('未登录重定向', r.status === 302 && r.headers.get('location') === '/login');

  const fails = results.filter((x) => !x).length;
  console.log(`\n合计 ${results.length} 项，失败 ${fails} 项`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
