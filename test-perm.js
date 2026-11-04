// 权限链路自测：建角色 → 授权 → 建用户 → 以该用户登录验证边界
const BASE = 'http://127.0.0.1:8099';
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

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' | ' + d : ''));
};
const login = async (u, p) => {
  sid = '';
  const r = await req('/login', { method: 'POST', body: new URLSearchParams({ username: u, password: p }) });
  return r.status === 302;
};

(async () => {
  check('管理员登录', await login('admin', 'admin888'));

  // 1 建角色
  const roleName = '领料测试' + Date.now().toString().slice(-4);
  let r = await req('/roles/create', { method: 'POST', body: new URLSearchParams({ name: roleName, note: '仅领料与查询' }) });
  const editLoc = r.headers.get('location') || '';
  const roleId = (editLoc.match(/edit=(\d+)/) || [])[1];
  check('创建角色', r.status === 302 && !!roleId, 'roleId=' + roleId);

  // 2 授权：只给领料 + 查询
  r = await req('/roles/save', {
    method: 'POST',
    body: new URLSearchParams([
      ['id', roleId],
      ['name', roleName],
      ['note', '仅领料与查询'],
      ['perms', 'doc.create.requisition'],
      ['perms', 'report.view'],
    ]),
  });
  check('保存授权', r.status === 302);

  // 3 建用户
  const uname = 'pick' + Date.now().toString().slice(-5);
  r = await req('/users/save', {
    method: 'POST',
    body: new URLSearchParams({ username: uname, name: '测试领料员', role_id: roleId, password: 'test1234', active: '1' }),
  });
  check('创建用户', r.status === 302);

  // 4 以该用户登录
  check('领料员登录', await login(uname, 'test1234'));

  const nav = await (await req('/')).text();
  check('工作台可访问', nav.includes('工作台'));
  check('侧栏显示领料出库', nav.includes('领料出库'));
  check('侧栏没有采购入库入口', !nav.includes('href="/docs/purchase_in"'));
  check('侧栏隐藏用户管理', !nav.includes('用户管理'));

  const code = async (p) => (await req(p)).status;
  check('领料单列表可访问', (await code('/docs/requisition')) === 200);
  check('领料单可新建', (await code('/docs/requisition/new')) === 200);
  check('采购入库被拒', (await code('/docs/purchase_in')) === 403);
  check('采购入库新建被拒', (await code('/docs/purchase_in/new')) === 403);
  check('项目管理被拒', (await code('/projects')) === 403);
  check('角色管理被拒', (await code('/roles')) === 403);
  check('用户管理被拒', (await code('/users')) === 403);
  check('库存查询可访问', (await code('/stock')) === 200);
  check('未授权导出被拒', (await code('/export?kind=stock')) === 403);

  // 5 领料单提交后不能审单
  r = await req('/docs/requisition/save', {
    method: 'POST',
    body: new URLSearchParams([['doc_date', '2026-11-03'], ['wh_id', '1'], ['project_id', '1'], ['item_product', '1'], ['item_qty', '3'], ['reason', '现场领用']]),
  });
  const docLoc = r.headers.get('location') || '';
  const docId = (docLoc.match(/\/docs\/(\d+)/) || [])[1];
  check('提交领料单', r.status === 302 && !!docId, 'docId=' + docId);
  r = await req('/docs/' + docId + '/approve', { method: 'POST', body: new URLSearchParams('') });
  check('无审核权限被拒', r.status === 403);

  const fails = out.filter((x) => !x).length;
  console.log(`\n合计 ${out.length} 项，失败 ${fails} 项`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e);
  process.exit(1);
});
