'use strict';
// 读取导入文件：xlsx（零依赖，自解析 zip + xml）与 csv/制表符文本
const zlib = require('node:zlib');

/* ---------- ZIP ---------- */
function readZip(buf) {
  const files = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（找不到 zip 结构）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    const lhNameLen = buf.readUInt16LE(off + 26);
    const lhExtraLen = buf.readUInt16LE(off + 28);
    const dataStart = off + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + csize);
    if (/sharedStrings\.xml$|worksheets\/sheet1\.xml$|workbook\.xml$/.test(name)) {
      files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unxml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXlsx(buf) {
  const files = readZip(buf);
  const sheet = files.get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('xlsx 中找不到第一个工作表');

  let shared = [];
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) {
    const xml = ss.toString('utf8');
    shared = [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unxml(x[1])).join('')
    );
  }

  const xml = sheet.toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] || '';
      const refM = /r="([A-Z]+\d+)"/.exec(attrs);
      const idx = refM ? colIndex(refM[1]) : cells.length;
      const isShared = /t="s"/.test(attrs);
      const isInline = /t="inlineStr"/.test(attrs);
      let val = '';
      if (isShared) {
        const v = /<v>(\d+)<\/v>/.exec(body);
        val = v ? shared[Number(v[1])] || '' : '';
      } else if (isInline) {
        val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unxml(x[1])).join('');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        val = v ? unxml(v[1]) : '';
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = String(val).trim();
    }
    rows.push(cells);
  }
  return rows;
}

function parseDelimited(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  return lines.map((line) => {
    if (line.includes('\t')) return line.split('\t').map((s) => s.trim());
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  });
}

/** 统一入口：返回 [{序号, 工程名称, 物料编码, 物资名称, 规格型号, 技术要求, 单位, 数量, 需求计划编号}] */
function parseImport(buf, filename) {
  const name = String(filename || '').toLowerCase();
  let rows;
  if (name.endsWith('.xlsx') || (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50)) rows = parseXlsx(buf);
  else rows = parseDelimited(buf.toString('utf8'));

  if (!rows.length) throw new Error('文件是空的');
  let header = rows[0].map((h) => String(h).replace(/\s/g, ''));
  const need = ['工程名称', '物资名称', '单位', '数量'];
  const missing = (h) => need.filter((k) => !h.some((x) => x.includes(k)));
  // 允许不带表头直接粘贴：首列是数字时按模板列序处理
  if (missing(header).length && /^\d+$/.test(String(rows[0][0] ?? '').trim())) {
    header = TEMPLATE_HEADER.slice();
    rows = [header, ...rows];
  }
  const miss = missing(header);
  if (miss.length) throw new Error('表头缺少列：' + miss.join('、') + '（请连同表头一起复制，或使用系统模板）');

  const find = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const idx = {
    project: find('工程名称', '项目名称'),
    code: find('物料编码', '物资编码'),
    name: find('物资名称', '物料名称'),
    spec: find('规格型号', '规格'),
    tech: find('技术要求', '执行标准'),
    unit: find('单位'),
    qty: find('数量'),
    plan: find('需求计划编号', '计划编号'),
  };

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => !String(c || '').trim())) continue;
    const qtyRaw = String(r[idx.qty] ?? '').replace(/,/g, '').trim();
    out.push({
      row: i + 1,
      project: String(r[idx.project] ?? '').trim(),
      code: idx.code >= 0 ? String(r[idx.code] ?? '').trim() : '',
      name: String(r[idx.name] ?? '').trim(),
      spec: idx.spec >= 0 ? String(r[idx.spec] ?? '').trim() : '',
      tech: idx.tech >= 0 ? String(r[idx.tech] ?? '').trim() : '',
      unit: String(r[idx.unit] ?? '').trim(),
      qty: qtyRaw === '' ? null : Number(qtyRaw),
      qtyRaw,
      plan: idx.plan >= 0 ? String(r[idx.plan] ?? '').trim() : '',
    });
  }
  return out;
}

const TEMPLATE_HEADER = ['序号', '工程名称', '物料编码', '物资名称', '规格型号', '执行标准/技术要求', '单位', '数量', '需求计划编号'];

module.exports = { parseImport, parseXlsx, parseDelimited, TEMPLATE_HEADER };
