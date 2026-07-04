// /api/admin-products.js
//
// 管理画面向け: 商品一覧(在庫数含む)の取得、在庫数の更新。
// GET  -> 商品一覧を返す
// PATCH { product_id, stock } -> 在庫数を絶対値で上書き更新

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { neon } = require('@neondatabase/serverless');
const { isAuthenticated } = require('./_admin_auth');

module.exports = async (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '認証が必要です。' });
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return res.status(500).json({ error: 'サーバー設定エラー' });
  }
  const sql = neon(databaseUrl);

  if (req.method === 'GET') {
    try {
      const products = await sql`
        SELECT id, name, price, stock, is_active, updated_at
        FROM products
        ORDER BY id ASC
      `;
      return res.status(200).json({ products });
    } catch (err) {
      console.error('admin-products GET エラー:', err);
      return res.status(500).json({ error: '商品一覧の取得に失敗しました。' });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const { product_id, stock } = req.body || {};

      if (!Number.isInteger(Number(product_id)) || !Number.isInteger(Number(stock)) || Number(stock) < 0) {
        return res.status(400).json({ error: 'パラメータが不正です。' });
      }

      const result = await sql`
        UPDATE products
        SET stock = ${Number(stock)}, updated_at = now()
        WHERE id = ${Number(product_id)}
        RETURNING id, name, stock
      `;

      if (result.length === 0) {
        return res.status(404).json({ error: '該当する商品が見つかりません。' });
      }

      return res.status(200).json({ ok: true, product: result[0] });
    } catch (err) {
      console.error('admin-products PATCH エラー:', err);
      return res.status(500).json({ error: '在庫更新に失敗しました。' });
    }
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method Not Allowed' });
};
