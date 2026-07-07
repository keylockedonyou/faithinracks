// UPDATED: 2026-07-07-v2
// UPDATED: 2026-07-07-v2
// /api/admin-products.js
//
// 管理画面向け: 商品×サイズごとの在庫一覧の取得、在庫数の更新。
// GET  -> 商品×サイズの一覧を返す
// PATCH { variant_id, stock } -> 在庫数を絶対値で上書き更新

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
      const variants = await sql`
        SELECT
          v.id AS variant_id,
          v.size,
          v.stock,
          v.updated_at,
          p.id AS product_id,
          p.name AS product_name,
          p.price,
          p.is_active
        FROM product_variants v
        JOIN products p ON p.id = v.product_id
        ORDER BY p.id ASC,
          CASE v.size WHEN 'S' THEN 1 WHEN 'M' THEN 2 WHEN 'L' THEN 3 WHEN 'XL' THEN 4 ELSE 5 END
      `;
      return res.status(200).json({ variants });
    } catch (err) {
      console.error('admin-products GET エラー:', err);
      return res.status(500).json({ error: '在庫一覧の取得に失敗しました。' });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const { variant_id, stock } = req.body || {};

      if (!Number.isInteger(Number(variant_id)) || !Number.isInteger(Number(stock)) || Number(stock) < 0) {
        return res.status(400).json({ error: 'パラメータが不正です。' });
      }

      const result = await sql`
        UPDATE product_variants
        SET stock = ${Number(stock)}, updated_at = now()
        WHERE id = ${Number(variant_id)}
        RETURNING id, stock
      `;

      if (result.length === 0) {
        return res.status(404).json({ error: '該当する在庫項目が見つかりません。' });
      }

      return res.status(200).json({ ok: true, variant: result[0] });
    } catch (err) {
      console.error('admin-products PATCH エラー:', err);
      return res.status(500).json({ error: '在庫更新に失敗しました。' });
    }
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method Not Allowed' });
};
