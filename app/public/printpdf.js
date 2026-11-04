'use strict';
/* 领料单导出 PDF：浏览器画布渲染 → JPEG → 组装 PDF（无外部依赖，支持中文与离线使用） */
(function () {
  function dataOf() {
    var el = document.getElementById('pdf-data');
    if (!el) throw new Error('未找到单据数据');
    return JSON.parse(el.textContent);
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* 画一页：ctx 画布上下文，rows 本页数据行，opt 分页信息 */
  function drawPage(ctx, W, H, data, rows, opt) {
    var M = 120; // 左右页边距（约15mm@200dpi）
    var top = 100;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';

    // 标题
    if (opt.page === 0) {
      ctx.font = 'bold 60px "Microsoft YaHei",SimHei,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(data.title || '', W / 2, top + 70);
      ctx.font = '34px "Microsoft YaHei",sans-serif';
      ctx.fillText(data.sub || '', W / 2, top + 130);
    } else {
      ctx.font = 'bold 40px "Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText((data.title || '') + '（续）', W / 2, top + 50);
    }

    // 表头字段
    var y = opt.page === 0 ? top + 190 : top + 90;
    ctx.font = '36px "Microsoft YaHei",sans-serif';
    ctx.textAlign = 'left';
    var colW = (W - M * 2) / 3;
    (data.meta || []).forEach(function (m, i) {
      var col = i % 3;
      var row = Math.floor(i / 3);
      var x = M + col * colW;
      ctx.fillText(m[0] + '：', x, y + row * 54);
      var lw = ctx.measureText(m[0] + '：').width;
      var fit = fitText(ctx, m[1] || '', colW - lw - 10, 36, 20, true);
      ctx.fillText(fit, x + lw, y + row * 54);
      ctx.font = '36px "Microsoft YaHei",sans-serif';
    });
    var metaRows = Math.ceil((data.meta || []).length / 3);
    var ty = y + metaRows * 54 + 30; // 表格起始 y

    // 表格
    var widths = (data.columns || []).map(function (c) { return c[1]; });
    var total = widths.reduce(function (a, b) { return a + b; }, 0) || 1;
    var cols = widths.map(function (w) { return (w / total) * (W - M * 2); });
    var xs = [M];
    cols.forEach(function (c) { xs.push(xs[xs.length - 1] + c); });

    var headH = 58;
    var rowH = 56;
    /* 缩排自适应：优先缩字号（到 minPx），仍放不下才截断加省略号 */
    function fitText(c2, s, maxW, basePx, minPx, bold) {
      s = String(s == null ? '' : s);
      var px = basePx;
      c2.font = (bold ? 'bold ' : '') + px + 'px "Microsoft YaHei",sans-serif';
      while (px > minPx && c2.measureText(s).width > maxW) {
        px -= 2;
        c2.font = (bold ? 'bold ' : '') + px + 'px "Microsoft YaHei",sans-serif';
      }
      if (c2.measureText(s).width > maxW) {
        var t = s;
        while (t.length > 1 && c2.measureText(t + '…').width > maxW) t = t.slice(0, -1);
        s = t + '…';
      }
      return s;
    }
    function cell(x, w, text, align, bold) {
      var pad = 10;
      var fitted = fitText(ctx, text, w - pad * 2, bold ? 30 : 30, 18, bold);
      ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
      var tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w - pad : x + pad;
      ctx.fillText(fitted, tx, 0);
    }

    function drawHead(topY) {
      ctx.fillStyle = '#efefef';
      ctx.fillRect(M, topY, W - M * 2, headH);
      ctx.fillStyle = '#000';
      for (var c = 0; c < (data.columns || []).length; c++) {
        var label = data.columns[c][0];
        var al = data.columns[c][2] || 'left';
        ctx.save();
        ctx.translate(0, topY + headH / 2 + 11);
        cell(xs[c], cols[c], label, al === 'right' ? 'right' : al === 'left' && c === 0 ? 'center' : al, true);
        ctx.restore();
      }
      ctx.lineWidth = 2;
      ctx.strokeRect(M, topY, W - M * 2, headH);
      for (var c2 = 1; c2 < xs.length - 1; c2++) {
        ctx.beginPath(); ctx.moveTo(xs[c2], topY); ctx.lineTo(xs[c2], topY + headH); ctx.stroke();
      }
    }

    drawHead(ty);
    var yy = ty + headH;
    ctx.lineWidth = 2;
    rows.forEach(function (r, ri) {
      for (var c = 0; c < (data.columns || []).length; c++) {
        var al = data.columns[c][2] || 'left';
        ctx.save();
        ctx.translate(0, yy + rowH / 2 + 11);
        cell(xs[c], cols[c], r[c], al, false);
        ctx.restore();
      }
      yy += rowH;
      ctx.beginPath(); ctx.moveTo(M, yy); ctx.lineTo(W - M, yy); ctx.stroke();
    });
    // 竖线
    for (var c3 = 1; c3 < xs.length - 1; c3++) {
      ctx.beginPath(); ctx.moveTo(xs[c3], ty); ctx.lineTo(xs[c3], yy); ctx.stroke();
    }
    ctx.strokeRect(M, ty, W - M * 2, yy - ty);

    // 备注
    if ((data.remark || '') && opt.page === opt.pages - 1) {
      ctx.textAlign = 'left';
      ctx.fillStyle = '#000';
      ctx.fillText(fitText(ctx, '备注：' + data.remark, W - M * 2, 32, 22, false), M, Math.min(yy + 60, H - 320));
    }

    // 签字栏（仅末页）
    if (opt.page === opt.pages - 1) {
      var sy = H - 200;
      var sw = (W - M * 2) / 4;
      ctx.font = '36px "Microsoft YaHei",sans-serif';
      ctx.textAlign = 'left';
      (data.signs || []).forEach(function (s, i) {
        var x = M + i * sw;
        ctx.fillText(s + '：', x, sy);
        var lw = ctx.measureText(s + '：').width;
        ctx.fillRect(x + lw, sy + 6, Math.min(150, sw - lw - 30), 2);
      });
    }

    // 页码
    ctx.font = '26px "Microsoft YaHei",sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#555';
    ctx.fillText('第 ' + (opt.page + 1) + ' 页 / 共 ' + opt.pages + ' 页', W - M, H - 60);
    ctx.textAlign = 'left';
  }

  function buildPdf(pages) {
    var chunks = [];
    var offsets = [];
    var offset = 0;
    var enc = new TextEncoder();
    function pushStr(t) { var b = enc.encode(t); chunks.push(b); offset += b.length; }
    function pushBytes(b) { chunks.push(b); offset += b.length; }
    function obj(id, parts) {
      offsets[id] = offset;
      var head = enc.encode(id + ' 0 obj\n');
      chunks.push(head); offset += head.length;
      for (var i = 0; i < parts.length; i++) {
        if (typeof parts[i] === 'string') pushStr(parts[i]); else pushBytes(parts[i]);
      }
      pushStr('endobj\n');
    }

    pushStr('%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n');
    var n = pages.length;
    obj(1, ['<< /Type /Catalog /Pages 2 0 R >>\n']);
    var kids = [];
    for (var i = 0; i < n; i++) kids.push(3 + i * 3 + ' 0 R');
    obj(2, ['<< /Type /Pages /Count ' + n + ' /Kids [' + kids.join(' ') + '] >>\n']);
    pages.forEach(function (p, i) {
      var pageId = 3 + i * 3, contentId = pageId + 1, imgId = pageId + 2;
      obj(pageId, [
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + p.w.toFixed(2) + ' ' + p.h.toFixed(2) + ']' +
        ' /Resources << /XObject << /Im0 ' + imgId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>\n',
      ]);
      var stream = 'q\n' + p.w.toFixed(2) + ' 0 0 ' + p.h.toFixed(2) + ' 0 0 cm\n/Im0 Do\nQ\n';
      obj(contentId, ['<< /Length ' + stream.length + ' >>\nstream\n', stream, 'endstream\n']);
      obj(imgId, [
        '<< /Type /XObject /Subtype /Image /Width ' + p.px + ' /Height ' + p.pxh +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.bytes.length + ' >>\nstream\n',
        p.bytes,
        '\nendstream\n',
      ]);
    });

    var xref = offset;
    var count = 2 + n * 3; // 编号 1..2+n*3（catalog、pages、每页 page/content/image 各一）
    var lines = 'xref\n0 ' + (count + 1) + '\n0000000000 65535 f \n';
    for (var j = 1; j <= count; j++) {
      lines += (String(offsets[j] || 0).padStart(10, '0')) + ' 00000 n \n';
    }
    pushStr(lines);
    pushStr('trailer\n<< /Size ' + (count + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return new Blob(chunks, { type: 'application/pdf' });
  }

  window.wmsExportPdf = function () {
    var data;
    try { data = dataOf(); } catch (e) { alert('导出失败：' + e.message); return; }
    var btn = document.querySelector('.pdf-btn');
    if (btn) { btn.disabled = true; btn.textContent = '正在生成…'; }
    try {
      var DPI = 200;
      var W = Math.round(210 / 25.4 * DPI);   // 1654
      var H = Math.round(297 / 25.4 * DPI);   // 2339
      var M = 120;
      var headH = 58, rowH = 56;
      var metaRows = Math.ceil((data.meta || []).length / 3);
      var tableTop = 100 + 190 + metaRows * 54 + 30;
      var rowsPerPage = Math.max(6, Math.floor((H - tableTop - 340) / rowH));
      var allRows = (data.rows || []).slice();
      var chunks = [];
      for (var i = 0; i < allRows.length; i += rowsPerPage) chunks.push(allRows.slice(i, i + rowsPerPage));
      if (!chunks.length) chunks.push([]);
      // 空行补足（仅末页，至少补到 8 行的观感）
      var last = chunks[chunks.length - 1];
      var blanks = Math.max(0, (data.blanks || 0) - (chunks.length > 1 ? 0 : allRows.length));
      for (var b = 0; b < blanks; b++) last.push(['', '', '', '', '', '', '']);

      var pageImgs = [];
      for (var pi = 0; pi < chunks.length; pi++) {
        var cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        var ctx = cv.getContext('2d');
        drawPage(ctx, W, H, data, chunks[pi], { page: pi, pages: chunks.length });
        var url = cv.toDataURL('image/jpeg', 0.92);
        pageImgs.push({ bytes: b64ToBytes(url.split(',')[1]), w: 595.28, h: 841.89, px: W, pxh: H });
      }
      var blob = buildPdf(pageImgs);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = data.filename || '领料申请单.pdf';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    } catch (e) {
      alert('导出失败：' + (e && e.message ? e.message : e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '导出 PDF'; }
    }
  };
})();
