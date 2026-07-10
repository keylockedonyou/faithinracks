// /api/webhook.js
//
// Stripeからの通知(Webhook)を受け取るエンドポイント。
// 決済完了時に:
//   1. ordersテーブルに注文情報を保存
//   2. order_itemsテーブルに購入明細(何を・どのサイズを・いくつ)を保存
//   3. product_variantsテーブルの「商品×サイズ」在庫を減算(二重減算・マイナス在庫を防止)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const Stripe = require('stripe');
const { neon } = require('@neondatabase/serverless');

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  return res.status(200).json({ MARKER: 'THIS_IS_THE_NEW_CODE_12345' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ▼ デバッグ用(確認できたら削除): レスポンスに詰める情報をここで管理する
  const debugInfo = {
    orderInserted: null,
    cartRaw: null,
    dbError: null,
  };
  // ▲ デバッグ用ここまで

  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const databaseUrl = process.env.DATABASE_URL;

    if (!secretKey || !webhookSecret || !databaseUrl) {
      console.error('必要な環境変数が設定されていません');
      return res.status(500).json({ error: 'サーバー設定エラー' });
    }

    const stripe = Stripe(secretKey);
    const sql = neon(databaseUrl);
    const sig = req.headers['stripe-signature'];
    const rawBody = await getRawBody(req);

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
      console.error('Webhook署名検証エラー:', err.message);
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }

    console.log('[EVENT] type:', event.type, 'id:', event.id);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('[SESSION] id:', session.id, 'payment_status:', session.payment_status);

      debugInfo.cartRaw = session.metadata?.cart || null;

      const shipping = session.collected_information?.shipping_details || session.shipping_details;
      const address = shipping?.address || {};

      const insertParams = {
        session_id: session.id,
        email: session.customer_details?.email || null,
        phone: session.customer_details?.phone || null,
        shipping_name: shipping?.name || null,
        shipping_zip: address.postal_code || null,
        shipping_state: address.state || null,
        shipping_city: address.city || null,
        shipping_line1: address.line1 || null,
        shipping_line2: address.line2 || null,
        shipping_country: address.country || null,
        amount_total: session.amount_total || null,
        currency: session.currency || null,
        payment_status: session.payment_status || null,
      };

      console.log('[DB] INSERT実行直前のパラメータ:', JSON.stringify(insertParams));

      try {
        console.log('[DB] orders INSERT開始...');

        const orderResult = await sql`
          INSERT INTO orders (
            session_id, email, phone, shipping_name, shipping_zip,
            shipping_state, shipping_city, shipping_line1, shipping_line2,
            shipping_country, amount_total, currency, payment_status
          ) VALUES (
            ${insertParams.session_id}, ${insertParams.email}, ${insertParams.phone},
            ${insertParams.shipping_name}, ${insertParams.shipping_zip}, ${insertParams.shipping_state},
            ${insertParams.shipping_city}, ${insertParams.shipping_line1}, ${insertParams.shipping_line2},
            ${insertParams.shipping_country}, ${insertParams.amount_total}, ${insertParams.currency},
            ${insertParams.payment_status}
          )
          ON CONFLICT (session_id) DO NOTHING
          RETURNING id, session_id
        `;

        console.log('[DB] orders INSERT結果:', JSON.stringify(orderResult));
        debugInfo.orderInserted = !!(orderResult && orderResult.length > 0);

        if (!orderResult || orderResult.length === 0) {
          console.warn('[DB] ⚠️ 既存の注文のため、明細保存・在庫減算はスキップします(重複防止)');
        } else {
          const orderId = orderResult[0].id;
          console.log('[DB] ✅ 注文を保存しました。order_id =', orderId);

          // --- 購入明細(カート内容)を復元 ---
          let cart = [];
          try {
            cart = JSON.parse(session.metadata?.cart || '[]');
          } catch (parseErr) {
            console.error('[CART PARSE ERROR]', parseErr.message, 'raw:', session.metadata?.cart);
          }
          console.log('[CART] 復元したカート内容:', JSON.stringify(cart));

          for (const item of cart) {
            const productId = Number(item.product_id);
            const variantId = Number(item.variant_id);
            const qty = Number(item.qty);
            const size = item.size || null;

            if (!Number.isInteger(productId) || !Number.isInteger(variantId) || !Number.isInteger(qty) || qty < 1) {
              console.warn('[CART] 不正な明細行をスキップ:', JSON.stringify(item));
              continue;
            }

            const productRows = await sql`SELECT id, name, price FROM products WHERE id = ${productId}`;
            const product = productRows[0];

            if (!product) {
              console.warn('[CART] products に存在しない商品ID:', productId);
              continue;
            }

            // --- 注文明細を保存 ---
            await sql`
              INSERT INTO order_items (order_id, product_id, variant_id, product_name, size, quantity, unit_price)
              VALUES (${orderId}, ${product.id}, ${variantId}, ${product.name}, ${size}, ${qty}, ${product.price})
            `;
            console.log(`[ORDER_ITEMS] 保存: product_id=${product.id} size=${size} qty=${qty}`);

            // --- サイズ別在庫を減算(条件付きUPDATEで二重減算・マイナス在庫を防止) ---
            const stockResult = await sql`
              UPDATE product_variants
              SET stock = stock - ${qty}, updated_at = now()
              WHERE id = ${variantId} AND stock >= ${qty}
              RETURNING id, stock
            `;

            if (stockResult.length === 0) {
              console.warn(
                `[STOCK] ⚠️ 在庫不足のため減算できませんでした。variant_id=${variantId} (product_id=${productId}, size=${size}) qty=${qty} → 手動確認が必要です`
              );
            } else {
              console.log(
                `[STOCK] ✅ 在庫を減算しました。variant_id=${variantId} (size=${size}) 残り在庫=${stockResult[0].stock}`
              );
            }
          }
        }
      } catch (dbErr) {
        console.error('[DB ERROR] message:', dbErr.message);
        console.error('[DB ERROR] code:', dbErr.code);
        console.error('[DB ERROR] detail:', dbErr.detail);
        console.error('[DB ERROR] table:', dbErr.table);
        console.error('[DB ERROR] column:', dbErr.column);
        console.error('[DB ERROR] constraint:', dbErr.constraint);
        // ▼ デバッグ用(確認できたら削除)
        debugInfo.dbError = {
          message: dbErr.message,
          code: dbErr.code,
          detail: dbErr.detail,
          table: dbErr.table,
          column: dbErr.column,
          constraint: dbErr.constraint,
        };
        // ▲ デバッグ用ここまで
      }
    } else {
      console.log('[EVENT] 対象外のイベントタイプのためスキップ:', event.type);
    }

    // ▼ デバッグ用(確認できたら元の `return res.status(200).json({ received: true });` に戻す)
    return res.status(200).json({
      received: true,
      debug: debugInfo,
    });
    // ▲ デバッグ用ここまで
  } catch (err) {
    console.error('[FATAL] Webhook処理エラー:', err.message, err.stack);
    return res.status(500).json({ error: 'Webhook処理中にエラーが発生しました' });
  }
};
