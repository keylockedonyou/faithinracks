// /api/create-checkout-session.js
//
// Stripe Checkout Session をサーバー側で作成するエンドポイント。
// - Stripe Secret Key は環境変数からのみ読み込み、フロントには絶対に渡さない。
// - フロントから送られてくる価格はそのまま信用せず、サーバー側の商品マスタ(PRODUCTS)で
//   商品ID -> 正しい価格・商品名 に変換してからStripeへ送る(改ざん対策)。
// - 配送先住所は、自作サイト側ではなく、Stripeの決済ページ上で入力してもらう。
//   (郵便番号フォーマットの検証等をStripe側に任せることで、セキュリティ・正確性を高める)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const Stripe = require('stripe');

// --- サーバー側の商品マスタ ---------------------------------
// フロント(index.html)の PRODS と id を合わせること。
// price は「円」単位の整数(JPYは小数点なし)。
// price が 0 や未設定の商品(デモ用ダミー価格)は、ここで実価格を必ず設定してください。
const PRODUCTS = {
  1: { name: 'Hear No Evil', price: 16000 },
  2: { name: 'Speak No Evil', price: 16000 },
  3: { name: 'See No Evil', price: 16000 },
  // 商品を追加する場合はここに追記してください
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      console.error('STRIPE_SECRET_KEY is not set');
      return res.status(500).json({ error: 'サーバー設定エラーが発生しました。' });
    }
    const stripe = Stripe(secretKey);

    const { items, email } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'カートが空です。' });
    }

    // フロントから受け取った items を、サーバー側マスタで検証・変換
    const line_items = [];
    for (const item of items) {
      const product = PRODUCTS[item.id];
      const qty = Number(item.qty);

      if (!product) {
        return res.status(400).json({ error: `不明な商品が含まれています (id: ${item.id})` });
      }
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
        return res.status(400).json({ error: '数量が不正です。' });
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
    }

    const origin =
      process.env.PUBLIC_BASE_URL ||
      (req.headers.origin ? req.headers.origin : `https://${req.headers.host}`);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      // メールアドレスはフロントの入力欄からあらかじめ渡しておくと、
      // Stripeの決済画面で再入力させず、レシート送付先として使われる。
      ...(email ? { customer_email: email } : {}),
      // 配送先住所をStripeの決済ページで収集する。
      // 日本国内発送のみを想定し、配送先の国を日本に限定。
      // 海外発送にも対応する場合は allowed_countries に追加してください。
      shipping_address_collection: {
        allowed_countries: ['JP'],
      },
      // 配送業者からの連絡(不在時の再配達連絡等)のため、電話番号も収集する。
      phone_number_collection: {
        enabled: true,
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
