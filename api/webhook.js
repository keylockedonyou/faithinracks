// /api/webhook.js
//
// Stripeからの通知(Webhook)を受け取るエンドポイント。
// 「決済が完了しました」というイベントを、Stripe側からサーバーへPUSHしてもらう仕組み。
//
// 【フェーズ1の目的】
// まずは「通知が正しく届くこと」を確認するため、受け取った注文情報を
// ログに出力するだけにしています。保存(データベース等)は次のフェーズで追加します。
//
// 【重要】このエンドポイントは誰でもアクセスできるURLなので、
// 本当にStripeから送られたものかを「署名検証」で確認します。
// この検証には、Stripeダッシュボードで発行する別の鍵(STRIPE_WEBHOOK_SECRET)が必要です。

const Stripe = require('stripe');

// Vercel(Next.js系)のAPI Routesは、デフォルトでリクエストボディを
// 自動的にJSONへ変換(パース)してしまう。
// しかしWebhookの署名検証には「パースされる前の生データ」が必須なため、
// この自動パースを無効化する。
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

// リクエストボディを生のBuffer(パース前のバイト列)として読み取るための処理
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
    require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

    const secretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secretKey || !webhookSecret) {
      console.error('STRIPE_SECRET_KEY または STRIPE_WEBHOOK_SECRET が設定されていません');
      return res.status(500).json({ error: 'サーバー設定エラー' });
    }

    const stripe = Stripe(secretKey);
    const sig = req.headers['stripe-signature'];
    const rawBody = await getRawBody(req);

    let event;
    try {
      // 署名を検証し、本当にStripeから送られたリクエストかを確認する。
      // これに通らない場合、改ざんされた/偽のリクエストとして拒否する。
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
      console.error('Webhook署名検証エラー:', err.message);
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }

    // 「決済が完了した」イベントだけを処理する
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // 【フェーズ1】まずはログに出力するだけ。
      // 次のフェーズで、ここをデータベースへの保存処理に置き換える。
      console.log('=== 注文が完了しました ===');
      console.log('Session ID:', session.id);
      console.log('金額(合計):', session.amount_total, session.currency);
      console.log('支払い状況:', session.payment_status);
      console.log('購入者メール:', session.customer_details?.email);
      console.log('==========================');

      // 必要であれば、line_itemsの詳細を取得することもできる(今は省略)
      // const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
    }

    // Stripeへ「正常に受信しました」と返す(200を返さないとStripeが再送し続ける)
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook処理エラー:', err);
    return res.status(500).json({ error: 'Webhook処理中にエラーが発生しました' });
  }
};
