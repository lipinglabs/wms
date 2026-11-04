'use strict';
/* 天气：走 wttr.in 免费接口（无需 key），服务端缓存 30 分钟。
   任何失败都返回 null —— 工作台不显示天气块，绝不影响页面其它部分。 */
const CACHE_MS = 30 * 60 * 1000;
const FAIL_MS = 5 * 60 * 1000;
let cache = { at: 0, data: null };
let failAt = 0;

/* WWO 天气代码 → 中文 */
const CODE_ZH = {
  113: '晴', 116: '多云', 119: '阴', 122: '阴',
  143: '薄雾', 248: '雾', 260: '冻雾',
  176: '局部有雨', 263: '毛毛雨', 266: '毛毛雨',
  293: '小雨', 296: '小雨', 299: '中雨', 302: '中雨', 305: '大雨', 308: '大雨',
  353: '小阵雨', 356: '中阵雨', 359: '大阵雨',
  200: '雷阵雨', 386: '雷阵雨', 389: '强雷阵雨',
  179: '局部有雪', 323: '小雪', 326: '小雪', 329: '中雪', 332: '中雪', 335: '大雪', 338: '大雪',
  368: '小阵雪', 371: '中阵雪', 392: '雷阵雪', 395: '强雷阵雪',
  182: '雨夹雪', 185: '冻雨', 311: '冻雨', 314: '冻雨', 317: '雨夹雪', 320: '雨夹雪',
  281: '冻毛毛雨', 284: '冻毛毛雨', 227: '扬雪', 230: '暴风雪',
  350: '冰粒', 374: '小冰粒', 377: '中冰粒',
};

function iconOf(code) {
  const c = Number(code);
  if (c === 113) return '☀️';
  if ([116, 119, 122].includes(c)) return '⛅';
  if ([143, 248, 260].includes(c)) return '🌫️';
  if ([200, 386, 389, 392, 395].includes(c)) return '⛈️';
  if ((c >= 323 && c <= 338) || [179, 227, 230, 368, 371].includes(c)) return '❄️';
  if ((c >= 293 && c <= 359) || [176, 263, 266, 281, 284, 311, 314, 317, 320].includes(c)) return '🌧️';
  return '🌤️';
}

/* 蒲福风级：按 km/h 上限分档，给出级数与中文名 */
const BEAUFORT = [
  [1, 0, '无风'], [5, 1, '软风'], [11, 2, '轻风'], [19, 3, '微风'], [28, 4, '和风'],
  [38, 5, '清劲风'], [49, 6, '强风'], [61, 7, '疾风'], [74, 8, '大风'], [88, 9, '烈风'],
  [102, 10, '狂风'], [117, 11, '暴风'],
];
function beaufort(kmph) {
  const v = Number(kmph) || 0;
  for (const [max, level, name] of BEAUFORT) if (v <= max) return { level, name };
  return { level: 12, name: '飓风' };
}

const DIR = {
  N: '北', NNE: '东北偏北', NE: '东北', ENE: '东北偏东',
  E: '东', ESE: '东南偏东', SE: '东南', SSE: '东南偏南',
  S: '南', SSW: '西南偏南', SW: '西南', WSW: '西南偏西',
  W: '西', WNW: '西北偏西', NW: '西北', NNW: '西北偏北',
};

async function get(city = 'Longkou', label = '龙口', force = false) {
  const now = Date.now();
  /* 手动刷新也至少间隔 60 秒，避免连点把上游打爆 */
  const minGap = force ? 60 * 1000 : CACHE_MS;
  if (cache.data && now - cache.at < minGap) return cache.data;
  if (!force && failAt && now - failAt < FAIL_MS) return cache.data || null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const c = (j.current_condition || [])[0] || {};
    const days = (j.weather || []).slice(0, 3).map((w, i) => {
      const noon = (w.hourly || [])[4] || {};
      /* 今天这行直接跟实时天气一致，否则会出现"现在晴、今天阴"的割裂 */
      const code = i === 0 ? c.weatherCode || noon.weatherCode || 113 : noon.weatherCode || 113;
      return {
        date: w.date,
        max: w.maxtempC,
        min: w.mintempC,
        code,
        text: CODE_ZH[Number(code)] || '未知',
        icon: iconOf(code),
      };
    });
    const bf = beaufort(c.windspeedKmph);
    const data = {
      city: label,
      temp: c.temp_C,
      feels: c.FeelsLikeC,
      code: c.weatherCode,
      text: CODE_ZH[Number(c.weatherCode)] || '未知',
      icon: iconOf(c.weatherCode),
      wind: c.windspeedKmph,
      windLevel: bf.level,
      windName: bf.name,
      dir: DIR[c.winddir16Point] || c.winddir16Point || '',
      humidity: c.humidity,
      days,
      at: new Date().toLocaleString('sv-SE').slice(0, 16),
    };
    cache = { at: now, data };
    failAt = 0;
    return data;
  } catch {
    failAt = now;
    return cache.data || null;
  }
}

module.exports = { get };
