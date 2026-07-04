// /api/admin-orders.js
//
// 管理画面向け: 注文一覧の取得、発送ステータスの更新。
// GET   -> 注文一覧(明細つき)を返す
// PATCH { order_id, fulfillment_status } -> 発送ステータスを更新

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
      const orders = await sql`
        SELECT id, session_id, email, phone, shipping_name, shipping_zip,
               shipping_state, shipping_city, shipping_line1, shipping_line2,
               shipping_country, amount_total, currency, payment_status,
               fulfillment_status, created_at
        FROM orders
        ORDER BY id DESC
        LIMIT 200
      `;

      const orderIds = orders.map((o) => o.id);
      const items = orderIds.length
        ? await sql`
            SELECT id, order_id, product_id, product_name, size, quantity, unit_price
            FROM order_items
            WHERE order_id = ANY(${orderIds})
          `
        : [];

      const itemsByOrder = {};
      for (const item of items) {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      }

      const result = orders.map((o) => ({
        ...o,
        items: itemsByOrder[o.id] || [],
      }));

      return res.status(200).json({ orders: result });
    } catch (err) {
      console.error('admin-orders GET エラー:', err);
      return res.status(500).json({ error: '注文一覧の取得に失敗しました。' });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const { order_id, fulfillment_status } = req.body || {};
      const allowed = ['unfulfilled', 'fulfilled', 'cancelled'];

      if (!Number.isInteger(Number(order_id)) || !allowed.includes(fulfillment_status)) {
        return res.status(400).json({ error: 'パラメータが不正です。' });
      }

      const result = await sql`
        UPDATE orders
        SET fulfillment_status = ${fulfillment_status}
        WHERE id = ${Number(order_id)}
        RETURNING id, fulfillment_status
      `;

      if (result.length === 0) {
        return res.status(404).json({ error: '該当する注文が見つかりません。' });
      }

      return res.status(200).json({ ok: true, order: result[0] });
    } catch (err) {
      console.error('admin-orders PATCH エラー:', err);
      return res.status(500).json({ error: 'ステータス更新に失敗しました。' });
    }
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method Not Allowed' });
};
