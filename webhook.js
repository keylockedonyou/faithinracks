// /api/webhook.js
//
// Stripeからの通知(Webhook)を受け取るエンドポイント。
// 決済完了時に注文情報をNeon Postgresのordersテーブルに保存する。

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

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // 配送先住所を取得
      const shipping = session.shipping_details;
      const address = shipping?.address || {};

      try {
        // ordersテーブルに注文情報を保存
        await sql`
          INSERT INTO orders (
            session_id,
            email,
            phone,
            shipping_name,
            shipping_zip,
            shipping_state,
            shipping_city,
            shipping_line1,
            shipping_line2,
            shipping_country,
            amount_total,
            currency,
            payment_status
          ) VALUES (
            ${session.id},
            ${session.customer_details?.email || null},
            ${session.customer_details?.phone || null},
            ${shipping?.name || null},
            ${address.postal_code || null},
            ${address.state || null},
            ${address.city || null},
            ${address.line1 || null},
            ${address.line2 || null},
            ${address.country || null},
            ${session.amount_total || null},
            ${session.currency || null},
            ${session.payment_status || null}
          )
          ON CONFLICT (session_id) DO NOTHING
        `;

        console.log('注文を保存しました:', session.id);
      } catch (dbErr) {
        console.error('DB保存エラー:', dbErr);
        // DB保存に失敗してもStripeへは200を返す（再送防止）
        // ただしログにエラーを記録する
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook処理エラー:', err);
    return res.status(500).json({ error: 'Webhook処理中にエラーが発生しました' });
  }
};
