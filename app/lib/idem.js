'use strict';
/* 表单令牌：防止双击 / 网络重试把同一份表单生成多张单据 */
const crypto = require('node:crypto');
const { one, run } = require('./db');

/** 发一个新令牌（页面渲染时调用） */
const issue = () => crypto.randomBytes(16).toString('hex');

/**
 * 认领令牌：返回 { fresh: true } 表示第一次提交，可创建单据；
 * 返回 { fresh: false, doc_id } 表示这份表单已经提交过，直接跳回已有单据。
 * 先插后写 doc_id：若中途失败，令牌已存在，宁可拦截也不重复建单。
 */
function claim(token) {
  if (!token || String(token).length < 8 || String(token).length > 64) return { fresh: true };
  try {
    run('INSERT INTO form_tokens(token, doc_id, created_at) VALUES(?, NULL, ?)', String(token), new Date().toISOString());
    return { fresh: true };
  } catch {
    const t = one('SELECT doc_id FROM form_tokens WHERE token = ?', String(token));
    return { fresh: false, doc_id: t ? t.doc_id : null };
  }
}

/** 单据建好后把令牌与单据号绑定（供幂等重定向） */
const bind = (token, docId) => {
  if (token && docId) run('UPDATE form_tokens SET doc_id = ? WHERE token = ?', docId, String(token));
};

module.exports = { issue, claim, bind };
