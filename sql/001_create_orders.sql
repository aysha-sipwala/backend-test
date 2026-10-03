-- Same schema in every shard (Section 8). IF NOT EXISTS makes it safe to re-run.

CREATE TABLE IF NOT EXISTS orders (
  order_id      text NOT NULL,
  seller_id     text NOT NULL,
  marketplace   text NOT NULL CHECK (marketplace IN ('amazon', 'flipkart', 'meesho', 'myntra')),
  sku           text NOT NULL,
  quantity      integer NOT NULL CHECK (quantity >= 1),
  customer_id   text NOT NULL,
  order_date    timestamptz NOT NULL,
  order_amount  numeric(12,2) NOT NULL CHECK (order_amount >= 0),
  status        text NOT NULL CHECK (status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned')),
  source_file   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- order_id alone is not unique: two sellers or marketplaces can reuse a number.
  -- seller_id leads the key because it is the shard key, so duplicates are always
  -- detected inside the one shard the row belongs to.
  PRIMARY KEY (seller_id, marketplace, order_id)
);

-- Serves GET /orders?sellerId= (one seller's orders, newest first).
CREATE INDEX IF NOT EXISTS idx_orders_seller_date
  ON orders (seller_id, order_date DESC);
