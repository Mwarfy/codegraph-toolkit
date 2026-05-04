-- VIOLATION #13 — SQL schema avec FK sans index + naming violation.
--
-- Détection attendue :
--   - SqlTable ≥ 1
--   - SqlForeignKey ≥ 1
--   - SqlFkWithoutIndex ≥ 1 (FK declared but no index on the FK column)
--   - SqlNamingViolation possible (camelCase column dans projet snake_case)

CREATE TABLE orders (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL,
  totalAmount   NUMERIC(10, 2) NOT NULL,  -- camelCase = naming violation
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
);

-- pas d'index sur user_id → FK lookup va full-scan orders
-- CREATE INDEX idx_orders_user_id ON orders(user_id); -- (volontairement absent)
