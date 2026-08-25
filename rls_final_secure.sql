-- ==========================================================
--  rls_final_secure.sql — النسخة النهائية المصححة والعاملة
--  آخر تحديث: 2026-06-10
--  يعتمد على JWT الصادر من telegram-auth
-- ==========================================================

-- ----------------------------------------------------------
-- تنظيف: حذف كل السياسات القديمة (لضمان عدم التعارض)
-- ----------------------------------------------------------
DROP POLICY IF EXISTS "orders_public_read"          ON public.orders;
DROP POLICY IF EXISTS "orders_public_insert"        ON public.orders;
DROP POLICY IF EXISTS "orders_auth_insert"          ON public.orders;
DROP POLICY IF EXISTS "orders_staff_manage"         ON public.orders;
DROP POLICY IF EXISTS "orders_own_read"             ON public.orders;
DROP POLICY IF EXISTS "orders_staff_update"         ON public.orders;
DROP POLICY IF EXISTS "orders_driver_update"        ON public.orders;
DROP POLICY IF EXISTS "orders_preparer_read"        ON public.orders;
DROP POLICY IF EXISTS "orders_insert_owner"         ON public.orders;
DROP POLICY IF EXISTS "orders_select_owner"         ON public.orders;
DROP POLICY IF EXISTS "orders_update_owner"         ON public.orders;
DROP POLICY IF EXISTS "orders_full_operator_admin"  ON public.orders;

DROP POLICY IF EXISTS "users_public_read"     ON public.users;
DROP POLICY IF EXISTS "users_public_insert"   ON public.users;
DROP POLICY IF EXISTS "users_public_update"   ON public.users;
DROP POLICY IF EXISTS "users_staff_manage"    ON public.users;
DROP POLICY IF EXISTS "users_own_read"        ON public.users;
DROP POLICY IF EXISTS "users_auth_insert"     ON public.users;
DROP POLICY IF EXISTS "users_own_update"      ON public.users;
DROP POLICY IF EXISTS "users_self_select"     ON public.users;
DROP POLICY IF EXISTS "users_self_update"     ON public.users;
DROP POLICY IF EXISTS "users_insert_self"     ON public.users;
DROP POLICY IF EXISTS "users_admin_select"    ON public.users;

DROP POLICY IF EXISTS "research_public_read"   ON public.research_requests;
DROP POLICY IF EXISTS "research_public_insert" ON public.research_requests;
DROP POLICY IF EXISTS "research_staff_manage"  ON public.research_requests;
DROP POLICY IF EXISTS "research_own_read"      ON public.research_requests;
DROP POLICY IF EXISTS "research_auth_insert"   ON public.research_requests;
DROP POLICY IF EXISTS "research_self_select"   ON public.research_requests;
DROP POLICY IF EXISTS "research_insert_self"   ON public.research_requests;
DROP POLICY IF EXISTS "research_admin_all"     ON public.research_requests;

DROP POLICY IF EXISTS "market_public_read"         ON public.market_products;
DROP POLICY IF EXISTS "market_staff_write"         ON public.market_products;
DROP POLICY IF EXISTS "market_products_read_all"   ON public.market_products;
DROP POLICY IF EXISTS "market_products_admin_all"  ON public.market_products;

DROP POLICY IF EXISTS "coupons_public_read"         ON public.coupons;
DROP POLICY IF EXISTS "coupons_public_update_count" ON public.coupons;
DROP POLICY IF EXISTS "coupons_staff_manage"        ON public.coupons;
DROP POLICY IF EXISTS "coupons_admin_manage"        ON public.coupons;
DROP POLICY IF EXISTS "coupons_auth_read"           ON public.coupons;
DROP POLICY IF EXISTS "coupons_auth_update"         ON public.coupons;
DROP POLICY IF EXISTS "coupons_read_all"            ON public.coupons;
DROP POLICY IF EXISTS "coupons_admin_all"           ON public.coupons;

DROP POLICY IF EXISTS "settings_staff_write"   ON public.settings;
DROP POLICY IF EXISTS "settings_public_read"   ON public.settings;
DROP POLICY IF EXISTS "settings_admin_manage"  ON public.settings;
DROP POLICY IF EXISTS "settings_read_all"      ON public.settings;
DROP POLICY IF EXISTS "settings_admin_all"     ON public.settings;

DROP POLICY IF EXISTS "profiles_admin_manage"  ON public.profiles;
DROP POLICY IF EXISTS "profiles_self_read"     ON public.profiles;
DROP POLICY IF EXISTS "profiles_self_select"   ON public.profiles;
DROP POLICY IF EXISTS "profiles_self_update"   ON public.profiles;
DROP POLICY IF EXISTS "profiles_admin_select"  ON public.profiles;

DROP POLICY IF EXISTS "supplies_admin_all"     ON public.supplies;
DROP POLICY IF EXISTS "supply_log_admin_all"   ON public.supply_log;

-- حذف الدوال القديمة (النسخة التي تأخذ uuid)
DROP FUNCTION IF EXISTS public.check_is_order_manager(uuid);
DROP FUNCTION IF EXISTS public.check_is_admin(uuid);
DROP FUNCTION IF EXISTS public.check_is_operator_or_admin(uuid);

-- ----------------------------------------------------------
-- 1️⃣ استخراج الـ telegram_id من JWT
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_telegram_id()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT auth.jwt() -> 'user_metadata' ->> 'telegram_user_id';
$$;

-- ----------------------------------------------------------
-- 2️⃣ دوال فحص الدور (مقارنة text آمنة)
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_is_role(role_name TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id::text = (auth.jwt() ->> 'sub')
      AND role = role_name
  );
$$;

CREATE OR REPLACE FUNCTION public.check_is_driver()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT public.check_is_role('driver');
$$;

CREATE OR REPLACE FUNCTION public.check_is_preparer()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT public.check_is_role('preparer');
$$;

CREATE OR REPLACE FUNCTION public.check_is_storekeeper()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT public.check_is_role('storekeeper');
$$;

CREATE OR REPLACE FUNCTION public.check_is_operator()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT public.check_is_role('operator');
$$;

CREATE OR REPLACE FUNCTION public.check_is_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT public.check_is_role('admin');
$$;

CREATE OR REPLACE FUNCTION public.check_is_operator_or_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT public.check_is_operator() OR public.check_is_admin();
$$;

-- ----------------------------------------------------------
-- 3️⃣ orders — العميل يرى/يعدل طلباته + الإدارة ترى الكل
-- ----------------------------------------------------------
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY orders_insert_owner ON public.orders
  FOR INSERT TO PUBLIC
  WITH CHECK (user_id::text = (auth.jwt() ->> 'sub'));

CREATE POLICY orders_select_owner ON public.orders
  FOR SELECT TO PUBLIC
  USING (user_id::text = (auth.jwt() ->> 'sub'));

CREATE POLICY orders_update_owner ON public.orders
  FOR UPDATE TO PUBLIC
  USING (user_id::text = (auth.jwt() ->> 'sub'));

CREATE POLICY orders_full_operator_admin ON public.orders
  FOR ALL TO PUBLIC
  USING (public.check_is_operator_or_admin());

-- ----------------------------------------------------------
-- 4️⃣ profiles — الجميع يقرأ + admin يدير الكل + المستخدم يعدل بروفايله
-- ----------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_authenticated ON public.profiles
  FOR SELECT TO PUBLIC
  USING (true);

CREATE POLICY profiles_admin_all ON public.profiles
  FOR ALL TO PUBLIC
  USING (public.check_is_admin())
  WITH CHECK (public.check_is_admin());

CREATE POLICY profiles_self_update ON public.profiles
  FOR UPDATE TO PUBLIC
  USING (id::text = (auth.jwt() ->> 'sub'));

-- ----------------------------------------------------------
-- 5️⃣ users — المستخدم يقرأ/يعدل بياناته + admin يقرأ الكل
-- ----------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_self_select ON public.users
  FOR SELECT TO PUBLIC
  USING (id::text = (auth.jwt() ->> 'sub'));

CREATE POLICY users_self_update ON public.users
  FOR UPDATE TO PUBLIC
  USING (id::text = (auth.jwt() ->> 'sub'));

CREATE POLICY users_insert_self ON public.users
  FOR INSERT TO PUBLIC
  WITH CHECK (id::text = (auth.jwt() ->> 'sub'));

CREATE POLICY users_admin_select ON public.users
  FOR SELECT TO PUBLIC
  USING (public.check_is_admin());

-- ----------------------------------------------------------
-- 6️⃣ market_products — قراءة للجميع + تعديل للإدارة
-- ----------------------------------------------------------
ALTER TABLE public.market_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY market_products_read_all ON public.market_products
  FOR SELECT TO PUBLIC
  USING (true);

CREATE POLICY market_products_admin_all ON public.market_products
  FOR ALL TO PUBLIC
  USING (public.check_is_admin());

-- ----------------------------------------------------------
-- 7️⃣ coupons — قراءة للجميع + إدارة كاملة للـ admin
-- ----------------------------------------------------------
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;

CREATE POLICY coupons_read_all ON public.coupons
  FOR SELECT TO PUBLIC
  USING (true);

CREATE POLICY coupons_admin_all ON public.coupons
  FOR ALL TO PUBLIC
  USING (public.check_is_admin());

-- ----------------------------------------------------------
-- 8️⃣ research_requests — المالك يقرأ/ينشئ + admin يدير الكل
-- ----------------------------------------------------------
ALTER TABLE public.research_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY research_self_select ON public.research_requests
  FOR SELECT TO PUBLIC
  USING (user_id::text = (auth.jwt() ->> 'sub'));

CREATE POLICY research_insert_self ON public.research_requests
  FOR INSERT TO PUBLIC
  WITH CHECK (user_id::text = (auth.jwt() ->> 'sub'));

CREATE POLICY research_admin_all ON public.research_requests
  FOR ALL TO PUBLIC
  USING (public.check_is_admin());

-- ----------------------------------------------------------
-- 9️⃣ settings — قراءة للجميع + تعديل للإدارة
-- ----------------------------------------------------------
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY settings_read_all ON public.settings
  FOR SELECT TO PUBLIC
  USING (true);

CREATE POLICY settings_admin_all ON public.settings
  FOR ALL TO PUBLIC
  USING (public.check_is_admin());

-- ----------------------------------------------------------
-- 🔟 supplies — الإدارة فقط (operator أو admin)
-- ----------------------------------------------------------
ALTER TABLE public.supplies ENABLE ROW LEVEL SECURITY;

CREATE POLICY supplies_admin_all ON public.supplies
  FOR ALL TO PUBLIC
  USING (public.check_is_operator_or_admin());

-- ----------------------------------------------------------
-- 1️⃣1️⃣ supply_log — الإدارة فقط (operator أو admin)
-- ----------------------------------------------------------
ALTER TABLE public.supply_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY supply_log_admin_all ON public.supply_log
  FOR ALL TO PUBLIC
  USING (public.check_is_operator_or_admin());

-- ----------------------------------------------------------
-- 1️⃣2️⃣ Trigger لمنع تكرار الطلبات السريع
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_check_order_cooldown()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.orders
    WHERE user_id = NEW.user_id
      AND created_at > NOW() - INTERVAL '30 seconds'
  ) THEN
    RAISE EXCEPTION 'You are sending orders too quickly.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_order_cooldown ON public.orders;
CREATE TRIGGER check_order_cooldown
BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.trg_check_order_cooldown();

-- ==========================================================
--   انتهى ملف rls_final_secure.sql ✅
-- ==========================================================
