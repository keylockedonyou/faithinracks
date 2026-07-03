// /api/webhook.js

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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const databaseUrl = process.env.DATABASE_URL;

    // ★ 追加: DATABASE_URLの接続先をマスクして確認(値そのものは出さない)
    console.log('[ENV CHECK] STRIPE_SECRET_KEY exists:', !!secretKey);
    console.log('[ENV CHECK] STRIPE_WEBHOOK_SECRET exists:', !!webhookSecret);
    console.log('[ENV CHECK] DATABASE_URL exists:', !!databaseUrl);
    if (databaseUrl) {
      try {
        const u = new URL(databaseUrl);
        console.log('[ENV CHECK] DB host:', u.hostname);
        console.log('[ENV CHECK] DB name:', u.pathname);
        console.log('[ENV CHECK] sslmode param:', u.searchParams.get('sslmode'));
      } catch (e) {
        console.error('[ENV CHECK] DATABASE_URL parse失敗 → 値が不正な形式:', e.message);
      }
    }

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

      const shipping = session.shipping_details;
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

      // ★ 追加: INSERT直前にパラメータを全出力
      console.log('[DB] INSERT実行直前のパラメータ:', JSON.stringify(insertParams));

      try {
        console.log('[DB] INSERT開始...');

        const result = await sql`
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

        // ★ 追加: RETURNINGで実際にINSERTされた行を確認
        console.log('[DB] INSERT結果 rows:', JSON.stringify(result));
        if (!result || result.length === 0) {
          console.warn('[DB] ⚠️ INSERTは実行されたが0件 → ON CONFLICTで弾かれた(重複)か、対象UNIQUE制約が無い可能性あり');
        } else {
          console.log('[DB] ✅ 注文を保存しました:', result[0]);
        }
      } catch (dbErr) {
        // ★ 修正: エラーの中身を全部出す
        console.error('[DB ERROR] message:', dbErr.message);
        console.error('[DB ERROR] code:', dbErr.code);
        console.error('[DB ERROR] detail:', dbErr.detail);
        console.error('[DB ERROR] table:', dbErr.table);
        console.error('[DB ERROR] column:', dbErr.column);
        console.error('[DB ERROR] constraint:', dbErr.constraint);
        console.error('[DB ERROR] full:', dbErr);
      }
    } else {
      console.log('[EVENT] 対象外のイベントタイプのためスキップ:', event.type);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[FATAL] Webhook処理エラー:', err.message, err.stack);
    return res.status(500).json({ error: 'Webhook処理中にエラーが発生しました' });
  }
};