'use strict';
// 登录失败节流：公网暴露后防止撞库
const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILS = 5;

const store = new Map(); // ip -> { n, first }

function now() {
  return Date.now();
}

function prune() {
  const t = now();
  for (const [ip, v] of store) {
    if (t - v.first > WINDOW_MS) store.delete(ip);
  }
}

function ok(ip) {
  prune();
  const v = store.get(ip);
  if (!v) return true;
  return v.n < MAX_FAILS;
}

function fail(ip) {
  const v = store.get(ip);
  if (!v || now() - v.first > WINDOW_MS) store.set(ip, { n: 1, first: now() });
  else v.n += 1;
}

function reset(ip) {
  store.delete(ip);
}

function remaining(ip) {
  const v = store.get(ip);
  if (!v) return MAX_FAILS;
  return Math.max(0, MAX_FAILS - v.n);
}

module.exports = { ok, fail, reset, remaining, MAX_FAILS, WINDOW_MS };
