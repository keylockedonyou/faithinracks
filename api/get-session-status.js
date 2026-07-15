// /api/get-session-status.js
//
// success.html から session_id を渡して、Stripe Checkout Session の
// 現在の状態(支払い済みか、konbiniの場合は支払いコードなど)を返すエンドポイント。

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      console.error('STRIPE_SECRET_KEYが設定されていません');
      return res.status(500).json({ error: 'サーバー設定エラー' });
    }

    const stripe = Stripe(secretKey);
    const { session_id } = req.query;

    if (!session_id || typeof session_id !== 'string') {
      return res.status(400).json({ error: 'session_idが指定されていません' });
    }

    // payment_intentを展開して、konbiniのバウチャー情報(next_action)も取得
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['payment_intent'],
    });

    const paymentIntent = session.payment_intent;
    const paymentMethodType = paymentIntent?.payment_method_types?.[0] || null;

    const responseData = {
      payment_status: session.payment_status, // 'paid' | 'unpaid' | 'no_payment_required'
      payment_method_type: paymentMethodType, // 'card' | 'konbini' | 'paypay' など
      amount_total: session.amount_total,
      currency: session.currency,
    };

    // konbiniの場合、店頭で支払うためのバウチャー情報を追加
    if (paymentMethodType === 'konbini' && paymentIntent?.next_action?.konbini_display_details) {
      const details = paymentIntent.next_action.konbini_display_details;
      responseData.konbini = {
        expires_at: details.expires_at, // Unixタイムスタンプ
        hosted_voucher_url: details.hosted_voucher_url || null, // Stripeがホストする支払い方法の案内ページ
      };
    }

    return res.status(200).json(responseData);
  } catch (err) {
    console.error('セッション取得エラー:', err.message);
    return res.status(500).json({ error: 'セッション情報の取得に失敗しました' });
  }
};
