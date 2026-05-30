-- ══════════════════════════════════════════════
-- RLS النهائي — خدمات الشاطر
-- يعتمد على JWT الصادر من telegram-auth
-- ══════════════════════════════════════════════

-- دالة تقرأ telegram_id من JWT (لا يمكن تزويرها)
CREATE OR REPLACE FUNCTION public.get_my_telegram_id()
RETURNS TEXT LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT auth.jwt() -> 'user_metadata' ->> 'telegram_user_id';
$$;

-- ══ ORDERS ══════════════════════════════════
DROP POLICY IF EXISTS "orders_public_read"    ON public.orders;
DROP POLICY IF EXISTS "orders_public_insert"  ON public.orders;
DROP POLICY IF EXISTS "orders_auth_insert"    ON public.orders;
DROP POLICY IF EXISTS "orders_staff_manage"   ON public.orders;
DROP POLICY IF EXISTS "orders_own_read"       ON public.orders;
DROP POLICY IF EXISTS "orders_staff_update"   ON public.orders;

CREATE POLICY "orders_own_read" ON public.orders FOR SELECT TO public
USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR public.check_is_order_manager(auth.uid()));

CREATE POLICY "orders_auth_insert" ON public.orders FOR INSERT TO public
WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "orders_staff_update" ON public.orders FOR UPDATE TO public
USING (public.check_is_order_manager(auth.uid()));

-- ══ USERS ═══════════════════════════════════
DROP POLICY IF EXISTS "users_public_read"    ON public.users;
DROP POLICY IF EXISTS "users_public_insert"  ON public.users;
DROP POLICY IF EXISTS "users_public_update"  ON public.users;
DROP POLICY IF EXISTS "users_staff_manage"   ON public.users;

CREATE POLICY "users_own_read" ON public.users
FOR SELECT TO authenticated
USING (
  id = public.get_my_telegram_id()
  OR public.check_is_operator_or_admin(auth.uid())
);

CREATE POLICY "users_auth_insert" ON public.users
FOR INSERT TO authenticated
WITH CHECK (id = public.get_my_telegram_id());

CREATE POLICY "users_own_update" ON public.users
FOR UPDATE TO authenticated
USING (id = public.get_my_telegram_id())
WITH CHECK (id = public.get_my_telegram_id());

-- ══ RESEARCH ════════════════════════════════
DROP POLICY IF EXISTS "research_public_read"   ON public.research_requests;
DROP POLICY IF EXISTS "research_public_insert" ON public.research_requests;
DROP POLICY IF EXISTS "research_staff_manage"  ON public.research_requests;
DROP POLICY IF EXISTS "research_own_read"       ON public.research_requests;
DROP POLICY IF EXISTS "research_auth_insert"    ON public.research_requests;

CREATE POLICY "research_own_read" ON public.research_requests FOR SELECT TO public
USING (user_id::text = (current_setting('request.jwt.claims', true)::json->>'sub') OR public.check_is_operator_or_admin(auth.uid()));

CREATE POLICY "research_auth_insert" ON public.research_requests FOR INSERT TO public
WITH CHECK (user_id::text = (current_setting('request.jwt.claims', true)::json->>'sub'));

CREATE POLICY "research_staff_manage" ON public.research_requests FOR ALL TO public
USING (public.check_is_operator_or_admin(auth.uid()));

-- ══ MARKET PRODUCTS (كتالوج عام) ════════════
DROP POLICY IF EXISTS "market_public_read"  ON public.market_products;
DROP POLICY IF EXISTS "market_staff_write"  ON public.market_products;

CREATE POLICY "market_public_read" ON public.market_products
FOR SELECT TO anon, authenticated
USING (active = true AND stock > 0);

CREATE POLICY "market_staff_write" ON public.market_products
FOR ALL TO authenticated
USING (public.check_is_operator_or_admin(auth.uid()));

-- ══ COUPONS ══════════════════════════════════
DROP POLICY IF EXISTS "coupons_public_read"         ON public.coupons;
DROP POLICY IF EXISTS "coupons_public_update_count" ON public.coupons;
DROP POLICY IF EXISTS "coupons_staff_manage"        ON public.coupons;
DROP POLICY IF EXISTS "coupons_admin_manage"        ON public.coupons;

CREATE POLICY "coupons_auth_read" ON public.coupons
FOR SELECT TO authenticated USING (active = true);

CREATE POLICY "coupons_auth_update" ON public.coupons
FOR UPDATE TO authenticated USING (true);

CREATE POLICY "coupons_admin_manage" ON public.coupons
FOR ALL TO authenticated
USING (public.check_is_admin(auth.uid()));

-- ══ RATE LIMITING TRIGGER ═════════════════════
CREATE OR REPLACE FUNCTION public.check_order_cooldown()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.orders
    WHERE user_id = NEW.user_id
      AND created_at > (now() - interval '60 seconds')
  ) THEN
    RAISE EXCEPTION 'يرجى الانتظار 60 ثانية قبل إرسال طلب جديد';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_check_order_cooldown ON public.orders;
CREATE TRIGGER trg_check_order_cooldown
BEFORE INSERT ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.check_order_cooldown();
