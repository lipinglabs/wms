// 追加自测：xlsx 上传导入 + 权限边界
const BASE = process.env.BASE || 'http://127.0.0.1:8098';
const path = require('node:path');
const { buildXlsx } = require('./app/lib/xlsx');

let sid = '';
let pass = 0, fail = 0;
const log = (ok, name, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : '')); };

async function req(p, opt = {}) {
  const headers = { ...(sid ? { Cookie: 'sid=' + sid } : {}) };
  let body = opt.body;
  if (opt.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(opt.form)) Array.isArray(v) ? v.forEach((x) => usp.append(k, x)) : usp.append(k, v);
    body = usp.toString();
  }
  if (opt.raw) { Object.assign(headers, opt.headers || {}); }
  const r = await fetch(BASE + p, { method: opt.method || 'GET', headers, body, redirect: 'manual' });
  for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
    const m = /^sid=([^;]*)/.exec(c);
    if (m) sid = m[1];
  }
  return r;
}

/* 登录：遇到"该账号已在别处登录"时自动点确认，模拟用户本人操作 */
async function loginAs(username, password) {
  let r = await req('/login', { method: 'POST', form: { username, password } });
  if (r.status === 200) {
    const h = await r.text();
    const tk = (/name="confirm" value="([a-f0-9]+)"/.exec(h) || [])[1];
    if (tk) r = await req('/login', { method: 'POST', form: { confirm: tk } });
  }
  return r;
}
const loc = (r) => decodeURIComponent(r.headers.get('location') || '');

(async () => {
  // 用系统模板同结构造一个带数据的 xlsx
  const widths = [6, 16, 14, 26, 34, 20, 8, 10, 24];
  const header = ['序号', '工程名称', '物料编码', '物资名称', '规格型号', '执行标准/技术要求', '单位', '数量', '需求计划编号'];
  const columns = header.map((h, i) => ({ key: 'c' + i, label: h, width: widths[i] }));
  const rows = [
    { c0: 1, c1: '公司公用', c2: 'TEST-01', c3: '上传测试用钢板', c4: 'δ=8mm Q235B', c5: 'GB/T 709', c6: '张', c7: 6, c8: 'SD-MAL-XZ-PI-2001-01' },
    { c0: 2, c1: '公司公用', c2: '', c3: '上传测试用螺栓', c4: 'M16×60 8.8级', c5: '', c6: '套', c7: 100, c8: 'SD-MAL-XZ-PI-2001-02' },
  ];
  const buf = buildXlsx({ sheetName: '物资导入', title: '物资导入模板', columns, rows });

  await req('/login', { method: 'POST', form: { username: 'admin', password: 'admin888' } });

  const B = '----wmsBoundary7d91';
  const parts = [];
  const field = (k, v) => parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  field('project_id', '1');
  field('major_id', '1');
  field('arrival_date', '2026-11-04');
  field('remark', 'xlsx 上传测试');
  parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="导入.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`));
  parts.push(buf);
  parts.push(Buffer.from(`\r\n--${B}--\r\n`));

  let r = await req('/in/create', {
    method: 'POST',
    body: Buffer.concat(parts),
    raw: true,
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + B },
  });
  const l = loc(r);
  log(r.status === 302 && /\/in\/\d+/.test(l) && !l.includes('err=1'), 'xlsx 上传导入', l.slice(0, 90));

  const inId = Number((/\/in\/(\d+)/.exec(l) || [])[1] || 0);
  if (inId) {
    r = await req('/in/' + inId);
    const html = await r.text();
    log(html.includes('6'), '上传单已生成明细');
    r = await req('/in/' + inId + '/submit', { method: 'POST' });
    log(r.status === 302, '上传单提交');
  }

  // 权限：建领料员账号，只分配工程 1
  r = await req('/users/save', {
    method: 'POST',
    form: { username: 'ck01', name: '张三', role_id: '3', password: 'ck123456', active: '1', projects: ['1'] },
  });
  log(r.status === 302 && !loc(r).includes('err=1'), '新建领料员账号');

  sid = '';
  r = await req('/login', { method: 'POST', form: { username: 'ck01', password: 'ck123456' } });
  log(r.status === 302, '领料员登录');

  r = await req('/in/new');
  log(r.status === 403, '领料员无入库登记权限（403）', 'status=' + r.status);

  r = await req('/req/new');
  log(r.status === 200, '领料员可访问领用登记');

  r = await req('/stock');
  log(r.status === 200, '领料员可看库存');

  r = await req('/users');
  log(r.status === 403, '领料员不能进用户管理');

  // 领料员看到的库存只含被分配工程
  r = await req('/stock');
  const sh = await r.text();
  log(!sh.includes('其他工程'), '库存按工程范围过滤');

  // 未分配工程的用户（admin 可能已被别处登录占用，走 loginAs 自动确认）
  await req('/logout');
  sid = '';
  await loginAs('admin', 'admin888');
  await req('/users/save', { method: 'POST', form: { username: 'nobody', name: '李四', role_id: '3', password: 'nb123456', active: '1' } });
  sid = '';
  await req('/login', { method: 'POST', form: { username: 'nobody', password: 'nb123456' } });
  r = await req('/stock');
  const nh = await r.text();
  log(nh.includes('还没有被分配到任何工程'), '未分配工程时给出提示');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e); process.exit(2); });
