// /api/create-checkout-session.js
//
// Stripe Checkout Session をサーバー側で作成するエンドポイント。
// - Stripe Secret Key は環境変数からのみ読み込み、フロントには絶対に渡さない。
// - 商品名・価格は products テーブル、在庫は「商品×サイズ」ごとに
//   product_variants テーブルから取得する(改ざん対策・サイズ別在庫管理)。
// - サイズ別在庫が足りない場合、Checkout Session を作らずエラーを返す。
// - 実際に在庫を減らすのは決済完了(webhook.js)のタイミング。

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const Stripe = require('stripe');
const { neon } = require('@neondatabase/serverless');

module.exports = async (req, res) => {
  return res.status(200).json({ MARKER_CCS: 'ABC999' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const databaseUrl = process.env.DATABASE_URL;

    if (!secretKey || !databaseUrl) {
      console.error('必要な環境変数が設定されていません');
      return res.status(500).json({ error: 'サーバー設定エラーが発生しました。' });
    }

    const stripe = Stripe(secretKey);
    const sql = neon(databaseUrl);

    const { items, email } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'カートが空です。' });
    }

    // 商品情報(名前・価格)をまとめて取得
    const ids = items.map((item) => Number(item.id)).filter((id) => Number.isInteger(id));
    if (ids.length === 0) {
      return res.status(400).json({ error: 'カートの内容が不正です。' });
    }

    const products = await sql`
      SELECT id, name, price, is_active
      FROM products
      WHERE id = ANY(${ids})
    `;
    const productMap = new Map(products.map((p) => [p.id, p]));

    const line_items = [];
    const cartForMetadata = [];

    for (const item of items) {
      const product = productMap.get(Number(item.id));
      const qty = Number(item.qty);
      const size = (item.size || '').trim();

      if (!product || !product.is_active) {
        return res.status(400).json({ error: `取り扱いのない商品が含まれています (id: ${item.id})` });
      }
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
        return res.status(400).json({ error: '数量が不正です。' });
      }
      if (!size) {
        return res.status(400).json({ error: `「${product.name}」のサイズを選択してください。` });
      }

      // サイズ別在庫を確認
      const variantRows = await sql`
        SELECT id, stock FROM product_variants
        WHERE product_id = ${product.id} AND size = ${size}
      `;
      const variant = variantRows[0];

      if (!variant) {
        return res.status(400).json({ error: `「${product.name}」に${size}サイズはありません。` });
      }
      if (variant.stock < qty) {
        return res.status(409).json({
          error: `「${product.name}」(${size})の在庫が不足しています(残り${variant.stock}点)。`,
        });
      }

      line_items.push({
        price_data: {
          currency: 'jpy',
          product_data: {
            name: product.name,
            description: `Size: ${size}`,
          },
          unit_amount: product.price,
        },
        quantity: qty,
      });

      // webhook側で注文明細の保存・在庫減算に使うため、variant_idを含めて持たせる
      cartForMetadata.push({
        product_id: product.id,
        variant_id: variant.id,
        size,
        qty,
      });
    }

    const origin =
      process.env.PUBLIC_BASE_URL ||
      (req.headers.origin ? req.headers.origin : `https://${req.headers.host}`);

    // ここで実際にStripeへ渡すパラメータを、一度変数に入れてから使う
    const sessionParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      ...(email ? { customer_email: email } : {}),
      shipping_address_collection: {
        allowed_countries: ['JP'],
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: {
              amount: 500,
              currency: 'jpy',
            },
            display_name: 'テスト目印99999',
          },
        },
      ],
      phone_number_collection: {
        enabled: true,
      },
      metadata: {
        cart: JSON.stringify(cartForMetadata),
      },
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cancel`,
    };

    // ▼ デバッグ用(確認できたら削除): 実際にStripeへ送る直前のパラメータをそのまま返す
    if (req.headers['x-debug-shipping'] === '1') {
      return res.status(200).json({ debug: true, sessionParams });
    }
    // ▲ デバッグ用ここまで

    const session = await stripe.checkout.sessions.create(sessionParams);

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe Checkout Session作成エラー:', err);
    return res.status(500).json({
      error: '決済セッションの作成に失敗しました。時間をおいて再度お試しください。',
    });
  }
};
