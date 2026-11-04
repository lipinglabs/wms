'use strict';
// 整机备份：数据库一致性快照 + 应用代码，打包成单个 tar.gz
// 每天 00:00 执行一次，保留 30 份；恢复用宿主机上的 restore.sh
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const KEEP = 30;

/** 把当天的包复制一份到腾讯云（异地备份），并在远端保留 30 份 */
function pushRemote(localFile) {
  const host = process.env.WMS_BACKUP_REMOTE;
  const dir = process.env.WMS_BACKUP_REMOTE_DIR || '/home/ubuntu/wms-backup';
  const key = process.env.WMS_BACKUP_KEY || '/home/node/.ssh/id_backup';
  if (!host) return { skipped: true, reason: '未配置 WMS_BACKUP_REMOTE' };

  // known_hosts 位于只读挂载中，写入会失败，直接禁用校验（密钥已固定，风险可控）
  const common = ['-i', key, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR'];
  const up = spawnSync('scp', [...common, localFile, `${host}:${dir}/`], { encoding: 'utf8' });
  if (up.status !== 0) return { error: (up.stderr || up.stdout || 'scp 失败').slice(0, 200) };

  const pr = spawnSync(
    'ssh',
    [...common, host, `cd ${dir} 2>/dev/null && ls -1t full-*.tar.gz 2>/dev/null | tail -n +${KEEP + 1} | xargs -r rm -f; ls -1 ${dir}/full-*.tar.gz 2>/dev/null | wc -l`],
    { encoding: 'utf8' }
  );
  const kept = pr.status === 0 ? String(pr.stdout).trim() : '?';
  return { ok: true, kept };
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * @param {object} db  node:sqlite DatabaseSync
 * @param {string} dataDir /data
 * @param {string} appDir  /app
 */
function runFullBackup(db, dataDir, appDir) {
  const dir = path.join(dataDir, 'backup');
  fs.mkdirSync(dir, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(dir, '.tmp-'));
  const target = path.join(dir, `full-${stamp()}.tar.gz`);

  try {
    // 1) 数据库一致性快照（WAL 模式下安全）
    const dbSnap = path.join(tmp, 'wms.db');
    db.exec(`VACUUM INTO '${dbSnap.replace(/'/g, "''")}'`);

    // 2) 清单
    fs.writeFileSync(
      path.join(tmp, 'manifest.json'),
      JSON.stringify(
        {
          createdAt: new Date().toLocaleString('sv-SE'),
          app: appDir,
          data: dataDir,
          files: fs.readdirSync(appDir),
          dbBytes: fs.statSync(dbSnap).size,
        },
        null,
        2
      )
    );

    // 3) 暂存 app 副本（busybox tar 只认一个 -C，必须先把内容归拢到同一目录）
    fs.cpSync(appDir, path.join(tmp, 'app'), { recursive: true });

    // 4) 打包：wms.db + manifest + app
    if (fs.existsSync(target)) fs.unlinkSync(target);
    const r = spawnSync('tar', ['-czf', target, '-C', tmp, '.'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('tar 失败: ' + (r.stderr || r.stdout || '').slice(0, 300));

    // 5) 轮转
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^full-\d{8}\.tar\.gz$/.test(f))
      .sort();
    while (files.length > KEEP) {
      const old = files.shift();
      try {
        fs.unlinkSync(path.join(dir, old));
      } catch {}
    }

    return { path: target, bytes: fs.statSync(target).size, kept: files.length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 每天 00:00 执行 */
function schedule(db, dataDir, appDir, log = console.log) {
  const tick = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(0, 0, 5, 0); // 00:00:05，避开整点任务
    if (next <= now) next.setDate(next.getDate() + 1);
    log(`[backup] 下次整机备份: ${next.toLocaleString('sv-SE')}`);
    const t = setTimeout(() => {
      try {
        const r = runFullBackup(db, dataDir, appDir);
        log(`[backup] ${r.path} (${Math.round(r.bytes / 1024)}KB) 保留 ${r.kept} 份`);
        const off = pushRemote(r.path);
        if (off.ok) log(`[backup] 已上传腾讯云，远端 ${off.kept} 份`);
        else if (off.error) log(`[backup] 异地备份失败: ${off.error}`);
      } catch (e) {
        log('[backup] 失败: ' + e.message);
      }
      tick();
    }, next - now);
    if (t.unref) t.unref();
  };
  tick();
}

/** 备份状态（只读目录，不触发任何备份动作），给工作台显示用 */
function status() {
  const dataDir = process.env.WMS_DATA_DIR || path.join(__dirname, '..', 'data');
  const dir = path.join(dataDir, 'backup');
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /^full-\d{8}\.tar\.gz$/.test(f))
      .sort();
  } catch {
    files = [];
  }
  if (!files.length) return { empty: true, ok: false, count: 0 };
  const last = files[files.length - 1];
  let st;
  try {
    st = fs.statSync(path.join(dir, last));
  } catch {
    return { empty: true, ok: false, count: files.length };
  }
  const ageHours = (Date.now() - st.mtimeMs) / 36e5;
  return {
    empty: false,
    ok: ageHours < 36,
    file: last,
    at: new Date(st.mtimeMs).toLocaleString('sv-SE').slice(0, 16),
    size: st.size,
    count: files.length,
    ageHours: Math.round(ageHours),
  };
}

module.exports = { runFullBackup, schedule, pushRemote, status, KEEP };
