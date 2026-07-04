// /api/_admin_auth.js
//
// 管理画面用のシンプルなパスワード認証の共通処理。
// 独立したAPIファイルではなく、他のadmin-*.jsから読み込んで使う内部モジュール。
//
// 仕組み:
//   1. /api/admin-login にパスワードをPOSTする
//   2. 環境変数 ADMIN_PASSWORD と一致すれば、署名付きトークンをCookieにセットする
//      (トークンは「ADMIN_PASSWORD + ADMIN_SESSION_SECRET」のHMACなので、
//       Cookieの値を盗み見てもパスワードそのものはわからない)
//   3. 以降のadmin-*.jsは、そのCookieを検証してから処理を行う

const crypto = require('crypto');

const COOKIE_NAME = 'mv_admin_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7日間

function getExpectedToken() {
  const password = process.env.ADMIN_PASSWORD;
  const sessionSecret = process.env.ADMIN_SESSION_SECRET || 'default-fallback-secret-change-me';
  if (!password) return null;
  return crypto.createHmac('sha256', sessionSecret).update(password).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

// リクエストが認証済みかどうかを返す
function isAuthenticated(req) {
  const expected = getExpectedToken();
  if (!expected) return false; // ADMIN_PASSWORDが未設定なら常に拒否
  const cookies = parseCookies(req);
  return cookies[COOKIE_NAME] === expected;
}

// ログイン成功時にセットするCookieヘッダーの値を返す
function buildLoginCookie() {
  const token = getExpectedToken();
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
}

// ログアウト用(Cookieを即失効させる)
function buildLogoutCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

module.exports = { isAuthenticated, buildLoginCookie, buildLogoutCookie };
