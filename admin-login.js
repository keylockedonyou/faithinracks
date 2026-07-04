// /api/admin-login.js
//
// 管理画面のパスワード認証。
// POST { password: "..." } を受け取り、環境変数 ADMIN_PASSWORD と一致すれば
// セッションCookieを発行する。

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { buildLoginCookie, buildLogoutCookie } = require('./_admin_auth');

module.exports = async (req, res) => {
  if (req.method === 'DELETE') {
    // ログアウト
    res.setHeader('Set-Cookie', buildLogoutCookie());
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
      console.error('ADMIN_PASSWORD が設定されていません');
      return res.status(500).json({ error: 'サーバー設定エラー(管理者パスワード未設定)' });
    }

    const { password } = req.body || {};

    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: 'パスワードを入力してください。' });
    }

    // タイミング攻撃対策: 文字列の長さが違うと crypto.timingSafeEqual がエラーになるため
    // 長さを揃えてから比較する
    const a = Buffer.from(password);
    const b = Buffer.from(adminPassword);
    const crypto = require('crypto');
    const isMatch =
      a.length === b.length ? crypto.timingSafeEqual(a, b) : false;

    if (!isMatch) {
      return res.status(401).json({ error: 'パスワードが違います。' });
    }

    res.setHeader('Set-Cookie', buildLoginCookie());
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('admin-login エラー:', err);
    return res.status(500).json({ error: 'ログイン処理中にエラーが発生しました。' });
  }
};
