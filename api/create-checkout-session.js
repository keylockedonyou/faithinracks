// /api/create-checkout-session.js
//
// Stripe Checkout Session をサーバー側で作成するエンドポイント。
// - Stripe Secret Key は環境変数からのみ読み込み、フロントには絶対に渡さない。
// - 商品名・価格・画像は products テーブル、在庫は「商品×サイズ」ごとに
//   product_variants テーブルから取得する(改ざん対策・サイズ別在庫管理)。
// - サイズ別在庫が足りない場合、Checkout Session を作らずエラーを返す。
// - 実際に在庫を減らすのは決済完了(webhook.js)のタイミング。

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

    // 商品情報(名前・価格・画像)をまとめて取得
    const ids = items.map((item) => Number(item.id)).filter((id) => Number.isInteger(id));
    if (ids.length === 0) {
      return res.status(400).json({ error: 'カートの内容が不正です。' });
    }

    const products = await sql`
      SELECT id, name, price, is_active, image_url
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
            // 商品画像(image_urlが設定されている場合のみ、Stripeの決済画面に表示される)
            ...(product.image_url ? { images: [product.image_url] } : {}),
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

    // --- 送料の計算(商品合計が15,000円以上なら送料無料) ---
    const FREE_SHIPPING_THRESHOLD = 15000; // 円。この金額以上で送料無料
    const BASE_SHIPPING_FEE = 500; // 円。通常時の送料

    const merchandiseSubtotal = line_items.reduce(
      (sum, li) => sum + li.price_data.unit_amount * li.quantity,
      0
    );
    const shippingFee = merchandiseSubtotal >= FREE_SHIPPING_THRESHOLD ? 0 : BASE_SHIPPING_FEE;
    const shippingLabel =
      shippingFee === 0 ? `送料無料(¥${FREE_SHIPPING_THRESHOLD.toLocaleString()}以上)` : '全国一律配送';

    // konbini決済には ¥120〜¥300,000 の金額制限があるため、
    // 選択された場合に上限を超えていないか事前にチェックする
    const grandTotalForKonbiniCheck = merchandiseSubtotal + shippingFee;
    const KONBINI_MAX_AMOUNT = 300000;
    const KONBINI_MIN_AMOUNT = 120;

    const sessionParams = {
      mode: 'payment',
      payment_method_types: ['card'], // konbini, paypay を追加
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
              amount: shippingFee,
              currency: 'jpy',
            },
            display_name: shippingLabel,
          },
        },
      ],
      phone_number_collection: {
        enabled: true,
      },
      // konbini用の追加設定(支払い期限)
      payment_method_options: {
        konbini: {
          expires_after_days: 3, // 3日以内に店頭で支払いがないと自動失効
        },
      },
      metadata: {
        cart: JSON.stringify(cartForMetadata),
      },
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cancel`,
    };

    // konbiniの金額制限を超えている場合は、konbiniを選択肢から外す
    // (card, paypayは制限が別なのでそのまま残す)
    if (
      grandTotalForKonbiniCheck < KONBINI_MIN_AMOUNT ||
      grandTotalForKonbiniCheck > KONBINI_MAX_AMOUNT
    ) {
      sessionParams.payment_method_types = sessionParams.payment_method_types.filter(
        (type) => type !== 'konbini'
      );
      delete sessionParams.payment_method_options.konbini;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe Checkout Session作成エラー:', err);
    return res.status(500).json({
      error: '決済セッションの作成に失敗しました。時間をおいて再度お試しください。',
    });
  }
};
