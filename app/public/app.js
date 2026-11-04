(function () {
  var form = document.getElementById('docForm');
  if (!form) return;

  var PRODUCTS = window.__PRODUCTS__ || [];
  var TYPE = window.__DOC_TYPE__ || '';
  var isTake = TYPE === 'stocktake';
  var body = document.getElementById('itemsBody');
  var rowCount = document.getElementById('rowCount');
  var bookMap = {};

  var byId = {};
  PRODUCTS.forEach(function (p) {
    byId[p.id] = p;
  });

  function opts(selected) {
    var html = '<option value="">— 选择商品 —</option>';
    PRODUCTS.forEach(function (p) {
      var label = p.code + ' ' + p.name + (p.spec ? ' / ' + p.spec : '');
      html +=
        '<option value="' + p.id + '"' + (String(selected) === String(p.id) ? ' selected' : '') + '>' + esc(label) + '</option>';
    });
    return html;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renumber() {
    Array.prototype.forEach.call(body.querySelectorAll('tr'), function (tr, i) {
      tr.querySelector('td.idx').textContent = i + 1;
    });
    rowCount.textContent = body.querySelectorAll('tr').length;
  }

  function addRow(pid) {
    var tr = document.createElement('tr');
    var p = pid ? byId[pid] : null;
    var qtyCell;
    if (isTake) {
      qtyCell =
        '<td class="r"><span class="book">' + (p && bookMap[p.id] != null ? bookMap[p.id] : '0') + '</span></td>' +
        '<td class="r"><input name="item_actual" type="number" step="0.01" value="' + (p && bookMap[p.id] != null ? bookMap[p.id] : '') + '"></td>' +
        '<td class="r diff">0</td>';
    } else {
      qtyCell = '<td class="r"><input name="item_qty" type="number" step="0.01" min="0" value=""></td>';
    }
    tr.innerHTML =
      '<td class="idx"></td>' +
      '<td><select name="item_product">' + opts(pid) + '</select></td>' +
      '<td class="spec">' + esc(p ? p.spec || '' : '') + '</td>' +
      '<td class="unit">' + esc(p ? p.unit || '' : '') + '</td>' +
      qtyCell +
      '<td><input name="item_remark" type="text" value=""></td>' +
      '<td><button type="button" class="mini danger" data-del="1">删除</button></td>';
    body.appendChild(tr);
    renumber();
    return tr;
  }

  function fillRow(tr) {
    var pid = tr.querySelector('select[name=item_product]').value;
    var p = byId[pid];
    tr.querySelector('.spec').textContent = p ? p.spec || '' : '';
    tr.querySelector('.unit').textContent = p ? p.unit || '' : '';
    if (isTake) {
      var book = p && bookMap[p.id] != null ? bookMap[p.id] : 0;
      tr.querySelector('.book').textContent = book;
      var inp = tr.querySelector('input[name=item_actual]');
      if (inp && !inp.value) inp.value = book;
      calcDiff(tr);
    }
  }

  function calcDiff(tr) {
    var book = Number(tr.querySelector('.book').textContent || 0);
    var act = Number(tr.querySelector('input[name=item_actual]').value || 0);
    var d = act - book;
    var cell = tr.querySelector('.diff');
    cell.textContent = (d > 0 ? '+' : '') + (Math.round(d * 100) / 100);
    cell.className = 'r diff ' + (d > 0 ? 'in' : d < 0 ? 'out' : '');
  }

  body.addEventListener('change', function (e) {
    var tr = e.target.closest('tr');
    if (!tr) return;
    if (e.target.name === 'item_product') fillRow(tr);
    if (e.target.name === 'item_actual') calcDiff(tr);
  });
  body.addEventListener('input', function (e) {
    if (e.target.name === 'item_actual') calcDiff(e.target.closest('tr'));
  });
  body.addEventListener('click', function (e) {
    if (e.target.dataset.del) {
      e.target.closest('tr').remove();
      renumber();
    }
  });

  document.getElementById('addRow').addEventListener('click', function () {
    addRow();
  });

  var loadBook = document.getElementById('loadBook');
  if (loadBook) {
    loadBook.addEventListener('click', function () {
      var wh = form.querySelector('[name=wh_id]').value;
      var proj = form.querySelector('[name=project_id]') ? form.querySelector('[name=project_id]').value : '';
      if (!wh) {
        alert('请先选择仓库');
        return;
      }
      if (!proj) {
        alert('请先选择归属项目，库存按项目独立核算');
        return;
      }
      loadBook.disabled = true;
      fetch('/api/stock?wh=' + encodeURIComponent(wh) + '&project=' + encodeURIComponent(proj))
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          bookMap = {};
          (j.items || []).forEach(function (it) {
            bookMap[it.product_id] = it.qty;
            if (Number(it.qty) > 0) addRow(it.product_id);
          });
          if (!body.querySelectorAll('tr').length) alert('该仓库当前没有库存');
        })
        .catch(function () {
          alert('读取库存失败');
        })
        .finally(function () {
          loadBook.disabled = false;
        });
    });
  }

  // 至少保留一行
  if (!body.querySelectorAll('tr').length) addRow();

  form.addEventListener('submit', function (e) {
    var rows = body.querySelectorAll('tr');
    var any = false;
    Array.prototype.forEach.call(rows, function (tr) {
      var pid = tr.querySelector('select[name=item_product]').value;
      if (pid) any = true;
    });
    if (!any) {
      e.preventDefault();
      alert('请至少添加一行明细');
    }
  });
})();

/* ---- 防重复提交：提交后按钮短暂锁定（服务端另有表单令牌兜底） ---- */
(function () {
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!(f instanceof HTMLFormElement) || f.method !== 'post') return;
    var btn = f.querySelector('button:not([type]), button[type="submit"]');
    if (!btn) return;
    setTimeout(function () {
      btn.disabled = true;
      btn.dataset.lockText = btn.textContent;
      btn.textContent = '处理中…';
      setTimeout(function () {
        btn.disabled = false;
        btn.textContent = btn.dataset.lockText || btn.textContent;
      }, 3000);
    }, 0);
  }, true);
})();

/* ---- AI 悬浮球对话 ---- */
(function () {
  var ball = document.getElementById('ai-ball');
  if (!ball) return;
  var panel = document.getElementById('ai-panel');
  var log = document.getElementById('ai-log');
  var form = document.getElementById('ai-form');
  var input = document.getElementById('ai-text');
  var send = document.getElementById('ai-send');
  var chips = document.getElementById('ai-chips');
  var busy = false;

  /* ---- 玻璃球可拖动：位置记在本机，未发生拖动时点击才打开面板 ---- */
  var root = ball.parentNode;
  var POS_KEY = 'ai_ball_pos';
  var moved = false;
  var drag = null;

  function applyPos(x, y) {
    var w = ball.offsetWidth || 58;
    var h = ball.offsetHeight || 58;
    x = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8));
    y = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - h - 8));
    root.style.left = x + 'px';
    root.style.top = y + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  (function restorePos() {
    try {
      var p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (p && typeof p.x === 'number' && typeof p.y === 'number') applyPos(p.x, p.y);
    } catch (e) {}
  })();

  /* 面板跟着球走：球在右半边就从右侧展开，靠近顶边就往下翻 */
  function placePanel() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var r = ball.getBoundingClientRect();
    var pw = panel.offsetWidth || 372;
    var ph = panel.offsetHeight || Math.min(520, vh * 0.72);
    var left = r.left + r.width / 2 > vw / 2 ? r.right - pw : r.left;
    left = Math.min(Math.max(12, left), Math.max(12, vw - pw - 12));
    var top = r.top - ph - 12;
    if (top < 12) top = r.bottom + 12;
    if (top + ph > vh - 12) top = Math.max(12, vh - ph - 12);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  ball.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var r = root.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, id: e.pointerId };
    moved = false;
    root.classList.add('dragging');
    try { ball.setPointerCapture(e.pointerId); } catch (err) {}
  });
  ball.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.sx;
    var dy = e.clientY - drag.sy;
    if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    moved = true;
    applyPos(drag.ox + dx, drag.oy + dy);
  });
  function endDrag() {
    if (!drag) return;
    root.classList.remove('dragging');
    try { ball.releasePointerCapture(drag.id); } catch (err) {}
    if (moved) {
      var r = root.getBoundingClientRect();
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
      } catch (err) {}
      /* 拖拽松手后紧接着会有一次“幽灵点击”，先吞掉再复位，避免下次真点击打不开 */
      setTimeout(function () { moved = false; }, 0);
    }
    drag = null;
  }
  ball.addEventListener('pointerup', endDrag);
  ball.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', function () {
    if (drag) return;
    if (root.style.left) {
      var r = root.getBoundingClientRect();
      applyPos(r.left, r.top);
    }
    if (!panel.hidden) placePanel();
  });

  function open() {
    panel.hidden = false;
    placePanel();
    ball.style.display = 'none';
    if (window.innerWidth > 640) input.focus();
    var bar = document.getElementById('ai-ctx');
    if (bar) {
      var c = pageCtx();
      var h1 = document.querySelector('.topbar h1');
      var name = h1 ? h1.textContent.replace(/^[^·]*·\s*/, '').trim() : '';
      if (c && name) {
        bar.textContent = '已关联当前页面：' + name;
        bar.hidden = false;
      } else {
        bar.hidden = true;
      }
    }
  }
  function close() {
    panel.hidden = true;
    ball.style.display = '';
  }
  ball.addEventListener('click', function (e) {
    if (moved) { moved = false; e.preventDefault(); e.stopPropagation(); return; }
    open();
  });
  document.getElementById('ai-close').addEventListener('click', close);

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /* 模型返回的文字偶尔带 **加粗** / `代码` / - 列表，先转义再还原这三种，避免 XSS */
  function richHtml(el, text) {
    var h = escHtml(text)
      .replace(/`([^`\n]{1,120})`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]{1,80})\*\*/g, '<strong>$1</strong>')
      .replace(/^[ \t]*[-*•][ \t]+/gm, '· ');
    el.innerHTML = h;
  }

  function bubble(text, cls) {
    var wrap = document.createElement('div');
    wrap.className = 'ai-msg ' + (cls || 'bot');
    var b = document.createElement('div');
    b.className = 'ai-bubble';
    if (!cls || cls === 'bot') richHtml(b, text);
    else b.textContent = text;
    wrap.appendChild(b);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  /* 把当前页面告诉 AI：站在某个物资的「出库明细」页时，问"它去哪了"也能答 */
  function pageCtx() {
    var m = /^\/stock\/(\d+)\/outs/.exec(location.pathname);
    return m ? { item_id: Number(m[1]) } : null;
  }

  function ask(q) {
    if (busy || !q.trim()) return;
    busy = true;
    send.disabled = true;
    chips.style.display = 'none';
    bubble(q, 'me');
    var pending = bubble('正在查系统…', 'bot');
    pending.parentNode.classList.add('pending');
    var t0 = Date.now();
    fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: q, ctx: pageCtx() })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        pending.parentNode.remove();
        if (!j || j.ok === false) {
          bubble((j && j.msg) || '请求失败，请稍后再试', 'tip');
        } else {
          bubble(j.answer || '（没有内容）', 'bot');
          if (j.degraded) bubble('提示：模型表述服务暂时不可用，以上是系统直接查询的结果。', 'tip');
        }
      })
      .catch(function () {
        pending.parentNode.remove();
        bubble('网络异常，请稍后再试', 'tip');
      })
      .then(function () {
        busy = false;
        send.disabled = false;
        input.focus();
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value;
    input.value = '';
    input.style.height = '';
    ask(q);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(92, input.scrollHeight) + 'px';
  });
  chips.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b) ask(b.textContent);
  });
})();

/* 领用登记：按关键字筛选物资行（已勾选的行始终保留，避免筛完看不见却仍在提交） */
(function () {
  var kw = document.getElementById('kw');
  if (!kw) return;
  var scope = kw.closest('form') || document;
  var hint = document.getElementById('kw-hint');
  var trs = [].slice.call(scope.querySelectorAll('table.grid tbody tr'));
  if (!trs.length) return;
  function apply() {
    var s = kw.value.trim().toLowerCase();
    var n = 0;
    trs.forEach(function (tr) {
      var cb = tr.querySelector('input[name="pick"]');
      var picked = cb && cb.checked;
      var found = tr.textContent.toLowerCase().indexOf(s) >= 0;
      var hit = !s || picked || found;
      tr.style.display = hit ? '' : 'none';
      if (found) n++;
    });
    if (hint) hint.textContent = s ? '匹配 ' + n + ' / ' + trs.length + ' 条' : '';
  }
  kw.addEventListener('input', apply);
  kw.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') e.preventDefault();
  });
  apply();
})();

/* 天气：全站顶栏都有。进入页面静默填充（本地缓存 5 分钟），点击弹出未来三天预报 */
(function () {
  var btn = document.getElementById('wx-slot');
  if (!btn) return;
  var pop = document.createElement('div');
  pop.className = 'wx-pop';
  pop.hidden = true;
  document.body.appendChild(pop);
  var loading = false;
  var CACHE_KEY = 'wx_v2'; /* 结构变化时改版本号，避免读到旧缓存 */
  var FRESH_MS = 5 * 60 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function dayLabel(d) {
    var today = new Date().toLocaleDateString('sv-SE');
    if (d === today) return '今天 ' + String(d).slice(5);
    var dt = new Date(d + 'T00:00:00');
    var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getDay()];
    return wd + ' ' + String(d).slice(5);
  }
  function place() {
    var r = btn.getBoundingClientRect();
    var w = pop.offsetWidth || 400;
    pop.style.top = r.bottom + 10 + 'px';
    pop.style.left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12)) + 'px';
  }
  function paint(d) {
    btn.innerHTML =
      '<span class="wx-ico">' + d.icon + '</span>' +
      '<span class="wx-main"><b>' + d.temp + '<i>℃</i></b><em>' + esc(d.city) + ' · ' + esc(d.text) + '</em></span>' +
      '<span class="wx-wind"><b>' + esc(d.dir) + '风</b><em>' + (d.windLevel == null ? '-' : d.windLevel + ' 级') + (d.windName ? '·' + esc(d.windName) : '') + '</em></span>';
    btn.hidden = false;
    btn.title = (d.dir ? d.dir + '风 ' : '') + (d.windLevel == null ? '' : d.windLevel + ' 级') + (d.windName ? '（' + d.windName + '）' : '') + (d.wind ? '，' + d.wind + ' km/h' : '') + '　点击查看未来三天预报';
  }
  function render(d) {
    if (!d) {
      pop.innerHTML = '<div class="wp-load">天气服务暂时不可用<span>请稍后再试</span></div>';
      return;
    }
    var list = d.days || [];
    var lo = Infinity, hi = -Infinity;
    list.forEach(function (x) {
      lo = Math.min(lo, Number(x.min));
      hi = Math.max(hi, Number(x.max));
    });
    var span = Math.max(1, hi - lo);

    var days = list
      .map(function (x, i) {
        var a = Number(x.min), b = Number(x.max);
        var left = Math.max(0, Math.min(100, ((a - lo) / span) * 100));
        var wide = Math.max(6, Math.min(100 - left, ((b - a) / span) * 100));
        return (
          '<div class="wp-row' + (i === 0 ? ' today' : '') + '">' +
          '<span class="d">' + dayLabel(x.date) + '</span>' +
          '<span class="t"><i>' + x.icon + '</i>' + esc(x.text) + '</span>' +
          '<span class="bar"><b style="left:' + left.toFixed(1) + '%;width:' + wide.toFixed(1) + '%"></b></span>' +
          '<span class="deg">' + x.min + '° ~ ' + x.max + '°</span>' +
          '</div>'
        );
      })
      .join('');
    pop.innerHTML =
      '<div class="wp-hero">' +
        '<span class="ico">' + d.icon + '</span>' +
        '<div class="now">' +
          '<div class="temp">' + d.temp + '<span>℃</span></div>' +
          '<div class="desc">' + esc(d.text) + '　体感 ' + d.feels + '℃</div>' +
        '</div>' +
        '<div class="meta">' + esc(d.dir) + '风 ' + (d.windLevel == null ? '-' : d.windLevel + ' 级') + (d.windName ? '（' + esc(d.windName) + '）' : '') + '<br>湿度 ' + d.humidity + '%</div>' +
      '</div>' +
      '<div class="wp-head"><b>' + esc(d.city) + ' · 未来三天</b><span>' + esc(d.at) + ' 更新</span></div>' +
      '<div class="wp-days">' + days + '</div>' +
      '<div class="wp-foot">数据来源 wttr.in</div>';
  }
  function readCache() {
    try {
      var o = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (o && o.ts && Date.now() - o.ts < FRESH_MS && o.data) return o.data;
    } catch (e) {}
    return null;
  }
  function writeCache(d) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: d })); } catch (e) {}
  }
  function fetchWx(force) {
    return fetch('/api/weather' + (force ? '?force=1' : ''), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok && j.data) {
          paint(j.data);
          writeCache(j.data);
          return j.data;
        }
        return null;
      })
      .catch(function () { return null; });
  }

  /* 进页面时静默填一次，不阻塞渲染 */
  var cached = readCache();
  if (cached) paint(cached);
  else fetchWx(false);

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!pop.hidden) { pop.hidden = true; return; }
    place();
    pop.hidden = false;
    if (loading) return;
    loading = true;
    pop.innerHTML = '<div class="wp-load">正在更新<span>稍等一下</span></div>';
    fetchWx(true).then(function (d) {
      render(d);
      loading = false;
    });
  });
  document.addEventListener('click', function (e) {
    if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true;
  });
  window.addEventListener('scroll', function () { pop.hidden = true; }, { passive: true });
  window.addEventListener('resize', function () { if (!pop.hidden) place(); });
})();
