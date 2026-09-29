-- ⚡ Performance Indexes for Al Shater
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- 1. Index for customer order listing (most frequent query)
CREATE INDEX IF NOT EXISTS idx_orders_user_created 
  ON orders(user_id, created_at DESC);

-- 2. Index for admin order filtering by status
CREATE INDEX IF NOT EXISTS idx_orders_status 
  ON orders(status);

-- 3. Index for admin order listing (created_at sort)
CREATE INDEX IF NOT EXISTS idx_orders_created_at 
  ON orders(created_at DESC);

-- 4. Index for active market products (customer storefront)
CREATE INDEX IF NOT EXISTS idx_market_products_active 
  ON market_products(active, stock) WHERE active = true AND stock > 0;

-- 5. Index for research requests by user
CREATE INDEX IF NOT EXISTS idx_research_user 
  ON research_requests(user_id, created_at DESC);
