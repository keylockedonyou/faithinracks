// /api/create-checkout-session.js
//
// Stripe Checkout Session をサーバー側で作成するエンドポイント。
// - Stripe Secret Key は環境変数からのみ読み込み、フロントには絶対に渡さない。
// - 商品名・価格・在庫数は Neon の products テーブルから取得する
//   (フロントから送られてくる価格はそのまま信用しない改ざん対策)。
// - 在庫が足りない商品があれば、Checkout Session を作らずエラーを返す。
// - 実際に在庫を減らすのは決済完了(webhook.js)のタイミング。
//   (ここではまだお金が支払われていないため減らさない)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const Stripe = require('stripe');
const { neon } = require('@neondatabase/serverless');

module.exports = async (req, res) => {
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

    // --- 商品IDの一覧をDBに問い合わせて、価格・在庫を取得 ---
    const ids = items.map((item) => Number(item.id)).filter((id) => Number.isInteger(id));
    if (ids.length === 0) {
      return res.status(400).json({ error: 'カートの内容が不正です。' });
    }

    const products = await sql`
      SELECT id, name, price, stock, is_active
      FROM products
      WHERE id = ANY(${ids})
    `;
    const productMap = new Map(products.map((p) => [p.id, p]));

    // --- 検証: 商品の存在チェック・数量チェック・在庫チェック ---
    const line_items = [];
    const cartForMetadata = [];

    for (const item of items) {
      const product = productMap.get(Number(item.id));
      const qty = Number(item.qty);

      if (!product || !product.is_active) {
        return res.status(400).json({ error: `取り扱いのない商品が含まれています (id: ${item.id})` });
      }
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
        return res.status(400).json({ error: '数量が不正です。' });
      }
      if (product.stock < qty) {
        return res.status(409).json({
          error: `「${product.name}」の在庫が不足しています(残り${product.stock}点)。`,
        });
      }

      line_items.push({
        price_data: {
          currency: 'jpy',
          product_data: {
            name: product.name,
            ...(item.size ? { description: `Size: ${item.size}` } : {}),
          },
          unit_amount: product.price,
        },
        quantity: qty,
      });

      // webhook側で注文明細の保存・在庫減算に使うため、最小限の情報だけ持たせる
      cartForMetadata.push({
        id: product.id,
        qty,
        size: item.size || null,
      });
    }

    const origin =
      process.env.PUBLIC_BASE_URL ||
      (req.headers.origin ? req.headers.origin : `https://${req.headers.host}`);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      ...(email ? { customer_email: email } : {}),
      shipping_address_collection: {
        allowed_countries: ['JP'],
      },
      phone_number_collection: {
        enabled: true,
      },
      // 決済完了webhookで「何が何個売れたか」を復元するためのメタデータ
      // Stripeのmetadata値は1つあたり500文字までのため、コンパクトなJSONにする
      metadata: {
        cart: JSON.stringify(cartForMetadata),
      },
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cancel`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe Checkout Session作成エラー:', err);
    return res.status(500).json({
      error: '決済セッションの作成に失敗しました。時間をおいて再度お試しください。',
    });
  }
};
