-- ============================================================
-- サイズ別在庫管理への移行
-- Neonの SQL Editor で、上から順番に1つずつ実行してください。
-- ============================================================

-- 1. 商品×サイズ の組み合わせごとに在庫を持つテーブル
CREATE TABLE IF NOT EXISTS product_variants (
  id          SERIAL PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size        TEXT NOT NULL,
  stock       INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, size)
);

-- 2. 初期データを投入
--    サイズはS/M/Lを想定。実際のサイズ展開・在庫数に合わせて書き換えてください。
--    在庫数はいったん仮に20個ずつにしてあります。
INSERT INTO product_variants (product_id, size, stock) VALUES
  (1, 'S', 20), (1, 'M', 20), (1, 'L', 20),
  (2, 'S', 20), (2, 'M', 20), (2, 'L', 20),
  (3, 'S', 20), (3, 'M', 20), (3, 'L', 20)
ON CONFLICT (product_id, size) DO NOTHING;

-- 3. order_items にもサイズごとの紐付けを明確にするため variant_id を追加
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id INTEGER REFERENCES product_variants(id);

-- 4. 旧: products.stock は商品全体の在庫としてはもう使わないため削除
--    (サイズ別在庫 product_variants.stock に一本化)
ALTER TABLE products DROP COLUMN IF EXISTS stock;

-- ============================================================
-- 確認用
-- ============================================================
-- SELECT p.name, v.size, v.stock
-- FROM product_variants v
-- JOIN products p ON p.id = v.product_id
-- ORDER BY p.id, v.size;
