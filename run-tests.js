'use strict';
/* 测试编排：每个套件用全新数据库 + 独立端口跑一遍，跑完即关，避免互相污染与残留进程 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const NODE = process.execPath;
const APP = path.join(__dirname, 'app');
const suites = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['test-v2.js', 'test-v2b.js', 'test-v3.js', 'test-v4.js', 'test-v5.js', 'test-v6.js', 'test-v7.js', 'test-v8.js', 'test-v9.js', 'test-v10.js', 'test-v11.js', 'test-v12.js'];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/login`, { redirect: 'manual' });
    return r.status > 0;
  } catch {
    return false;
  }
}

function run(file, port) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [path.join(__dirname, file)], {
      env: { ...process.env, BASE: `http://127.0.0.1:${port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code, out }));
  });
}

(async () => {
  const summary = [];
  for (let i = 0; i < suites.length; i++) {
    const file = suites[i];
    const port = 8100 + i;
    const dir = path.join(__dirname, 'testdata', 'run' + i);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const srv = spawn(NODE, ['server.js'], {
      cwd: APP,
      env: { ...process.env, WMS_DATA_DIR: dir, WMS_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srvErr = '';
    srv.stderr.on('data', (d) => (srvErr += d));

    let up = false;
    for (let k = 0; k < 40; k++) {
      await wait(250);
      if (await ping(port)) { up = true; break; }
    }
    if (!up) {
      console.log(`!! ${file} 服务未启动\n${srvErr.slice(0, 400)}`);
      srv.kill('SIGKILL');
      summary.push([file, 0, 0, 'server-fail']);
      continue;
    }

    const r = await run(file, port);
    srv.kill('SIGKILL');
    await wait(300);
    const lines = r.out.trim().split('\n');
    const tail = lines.slice(-3).join(' | ');
    console.log(`--- ${file} (exit ${r.code}) --- ${tail}`);
    if (r.code !== 0) console.log(r.out.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
    const m = /通过 (\d+)[，,]\s*失败 (\d+)/.exec(r.out) || /(\d+) 通过 \/ (\d+) 失败/.exec(r.out);
    summary.push([file, m ? Number(m[1]) : 0, m ? Number(m[2]) : (r.code ? 1 : 0), r.code === 0 ? 'ok' : 'fail']);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('\n===== 汇总 =====');
  let tp = 0, tf = 0;
  for (const [f, p, x, st] of summary) { tp += p; tf += x; console.log(`${f.padEnd(14)} 通过 ${String(p).padStart(3)}  失败 ${String(x).padStart(2)}  (${st})`); }
  console.log(`合计 通过 ${tp}，失败 ${tf}`);
  process.exit(tf ? 1 : 0);
})();
