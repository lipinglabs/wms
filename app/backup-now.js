'use strict';
// 手动立刻备份一次：docker exec wms node backup-now.js
const path = require('node:path');
const { db, DATA_DIR, migrate } = require('./lib/db');
const { runFullBackup, pushRemote } = require('./lib/backup');

migrate();
const appDir = path.join(__dirname);
const r = runFullBackup(db, DATA_DIR, appDir);
console.log(`backup ok -> ${r.path} | ${Math.round(r.bytes / 1024)}KB | 保留 ${r.kept} 份`);
const off = pushRemote(r.path);
if (off.ok) console.log(`异地备份 ok -> 腾讯云，远端 ${off.kept} 份`);
else if (off.error) console.log(`异地备份失败: ${off.error}`);
else console.log('异地备份未配置');
