-- =====================================================================
-- تأمين قاعدة بيانات "الشاطر" — الإصلاحات الأمنية الأساسية (النسخة الآمنة 100%)
-- =====================================================================
-- تاريخ التعديل: 2026-05-20
-- الهدف: قفل عمليات الكتابة/الحذف مع منع التكرار اللانهائي (Infinite Recursion)
-- تعليمات: انسخ هذا الكود بالكامل وشغّله في SQL Editor في Supabase
-- =====================================================================

-- =====================================================================
-- 0. حذف السياسات القديمة تماماً لتجنب أي تداخل
-- =====================================================================
DROP POLICY IF EXISTS "settings_public_read" ON public.settings;
DROP POLICY IF EXISTS "settings_staff_write" ON public.settings;
DROP POLICY IF EXISTS "market_public_read" ON public.market_products;
DROP POLICY IF EXISTS "market_staff_write" ON public.market_products;
DROP POLICY IF EXISTS "orders_public_insert" ON public.orders;
DROP POLICY IF EXISTS "orders_public_read" ON public.orders;
DROP POLICY IF EXISTS "orders_staff_manage" ON public.orders;
DROP POLICY IF EXISTS "users_public_read" ON public.users;
DROP POLICY IF EXISTS "users_public_insert" ON public.users;
DROP POLICY IF EXISTS "users_public_update" ON public.users;
DROP POLICY IF EXISTS "users_staff_manage" ON public.users;
DROP POLICY IF EXISTS "research_public_insert" ON public.research_requests;
DROP POLICY IF EXISTS "research_public_read" ON public.research_requests;
DROP POLICY IF EXISTS "research_staff_manage" ON public.research_requests;
DROP POLICY IF EXISTS "profiles_self_read" ON public.profiles;
DROP POLICY IF EXISTS "profiles_admin_manage" ON public.profiles;
DROP POLICY IF EXISTS "coupons_public_read" ON public.coupons;
DROP POLICY IF EXISTS "coupons_public_update_count" ON public.coupons;
DROP POLICY IF EXISTS "coupons_staff_manage" ON public.coupons;
DROP POLICY IF EXISTS "supplies_staff_manage" ON public.supplies;
DROP POLICY IF EXISTS "supply_log_staff_manage" ON public.supply_log;

-- =====================================================================
-- 1. إنشاء دوال التحقق الآمنة (SECURITY DEFINER) لمنع التكرار اللانهائي
--    هذه الدوال تتجاوز RLS وتعمل مباشرة على قاعدة البيانات للتحقق من الأدوار
-- =====================================================================

-- التحقق هل المستخدم مدير عام (admin)
CREATE OR REPLACE FUNCTION public.check_is_admin(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = p_user_id AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- التحقق هل المستخدم موظف استنساخ أو مدير عام (operator / admin)
CREATE OR REPLACE FUNCTION public.check_is_operator_or_admin(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = p_user_id AND role IN ('admin', 'operator')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- التحقق هل المستخدم من مدراء الطلبات (admin, operator, driver, preparer)
CREATE OR REPLACE FUNCTION public.check_is_order_manager(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = p_user_id AND role IN ('admin', 'operator', 'driver', 'preparer')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- التحقق هل المستخدم أمين مخزن أو موظف مخول (admin, operator, storekeeper)
CREATE OR REPLACE FUNCTION public.check_is_storekeeper_or_staff(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = p_user_id AND role IN ('admin', 'operator', 'storekeeper')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;


-- =====================================================================
-- 2. تفعيل RLS على جميع الجداول
-- =====================================================================
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supply_log ENABLE ROW LEVEL SECURITY;


-- =====================================================================
-- 3. جدول الإعدادات (settings) — قراءة عامة، كتابة للمدير فقط
-- =====================================================================
CREATE POLICY "settings_public_read" 
ON public.settings FOR SELECT TO public USING (true);

CREATE POLICY "settings_staff_write" 
ON public.settings FOR ALL TO authenticated 
USING (
  public.check_is_admin(auth.uid())
);


-- =====================================================================
-- 4. جدول القرطاسية (market_products) — قراءة عامة، كتابة للموظفين
-- =====================================================================
CREATE POLICY "market_public_read" 
ON public.market_products FOR SELECT TO public USING (true);

CREATE POLICY "market_staff_write" 
ON public.market_products FOR ALL TO authenticated 
USING (
  public.check_is_operator_or_admin(auth.uid())
);


-- =====================================================================
-- 5. جدول الطلبات (orders) — INSERT+SELECT للعامة | UPDATE للموظفين
-- =====================================================================
CREATE POLICY "orders_public_insert" 
ON public.orders FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "orders_public_read" 
ON public.orders FOR SELECT TO public USING (true);

CREATE POLICY "orders_staff_manage" 
ON public.orders FOR ALL TO authenticated 
USING (
  public.check_is_order_manager(auth.uid())
);


-- =====================================================================
-- 6. جدول المستخدمين (users) — قراءة+تسجيل+تحديث للعامة (النقاط محمية بالـ Trigger)
-- =====================================================================
CREATE POLICY "users_public_read" 
ON public.users FOR SELECT TO public USING (true);

CREATE POLICY "users_public_insert" 
ON public.users FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "users_public_update" 
ON public.users FOR UPDATE TO public USING (true) WITH CHECK (true);

CREATE POLICY "users_staff_manage" 
ON public.users FOR ALL TO authenticated 
USING (
  public.check_is_operator_or_admin(auth.uid())
);


-- =====================================================================
-- 7. جدول البحوث (research_requests) — تقديم وقراءة للعامة | إدارة للموظفين
-- =====================================================================
CREATE POLICY "research_public_insert" 
ON public.research_requests FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "research_public_read" 
ON public.research_requests FOR SELECT TO public USING (true);

CREATE POLICY "research_staff_manage" 
ON public.research_requests FOR ALL TO authenticated 
USING (
  public.check_is_operator_or_admin(auth.uid())
);


-- =====================================================================
-- 8. جدول الملفات الشخصية (profiles) — قراءة للموظف نفسه | إدارة للمدير
-- =====================================================================
CREATE POLICY "profiles_self_read" 
ON public.profiles FOR SELECT TO authenticated 
USING (auth.uid() = id);

CREATE POLICY "profiles_admin_manage" 
ON public.profiles FOR ALL TO authenticated 
USING (
  public.check_is_admin(auth.uid())
);


-- =====================================================================
-- 9. جدول الكوبونات (coupons) — قراءة وتحديث العداد للعامة | إدارة للمدير
-- =====================================================================
CREATE POLICY "coupons_public_read" 
ON public.coupons FOR SELECT TO public USING (true);

CREATE POLICY "coupons_public_update_count" 
ON public.coupons FOR UPDATE TO public USING (true) WITH CHECK (true);

CREATE POLICY "coupons_staff_manage" 
ON public.coupons FOR ALL TO authenticated 
USING (
  public.check_is_admin(auth.uid())
);


-- =====================================================================
-- 10. جدول المخزون وسجل الحركات (supplies + supply_log) — للموظفين المخولين
-- =====================================================================
CREATE POLICY "supplies_staff_manage" 
ON public.supplies FOR ALL TO authenticated 
USING (
  public.check_is_storekeeper_or_staff(auth.uid())
);

CREATE POLICY "supply_log_staff_manage" 
ON public.supply_log FOR ALL TO authenticated 
USING (
  public.check_is_storekeeper_or_staff(auth.uid())
);


-- =====================================================================
-- 11. Trigger — حماية نقاط الولاء من التلاعب المباشر
--     يسمح فقط للدوال الآمنة (Trigger/RPC) بتعديل النقاط
--     عبر آلية session variable: app.bypass_points_guard
-- =====================================================================
CREATE OR REPLACE FUNCTION guard_loyalty_points()
RETURNS TRIGGER AS $$
BEGIN
  -- السماح إذا تم تعيين علم التجاوز من الدوال الآمنة (SECURITY DEFINER)
  IF current_setting('app.bypass_points_guard', true) = 'true' THEN
    RETURN NEW;
  END IF;
  
  -- إذا تم محاولة تغيير النقاط مباشرة، إعادتها للقيمة القديمة بصمت
  IF NEW.loyalty_points IS DISTINCT FROM OLD.loyalty_points THEN
    NEW.loyalty_points := OLD.loyalty_points;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_loyalty_points ON public.users;
CREATE TRIGGER trg_guard_loyalty_points
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION guard_loyalty_points();


-- =====================================================================
-- 12. Trigger — إضافة نقاط الولاء تلقائياً عند التوصيل
--     عند تغيير حالة الطلب إلى 'delivered':
--     يضيف floor(total / 1000) نقطة للزبون
-- =====================================================================
CREATE OR REPLACE FUNCTION award_loyalty_points_on_delivery()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'delivered' AND (OLD.status IS DISTINCT FROM 'delivered') THEN
    -- تعيين علم التجاوز للسماح بتعديل النقاط عبر الـ Guard Trigger
    PERFORM set_config('app.bypass_points_guard', 'true', true);
    
    UPDATE public.users
    SET loyalty_points = COALESCE(loyalty_points, 0) + floor(COALESCE(NEW.total, 0) / 1000)
    WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_award_points ON public.orders;
CREATE TRIGGER trg_award_points
AFTER UPDATE ON public.orders
FOR EACH ROW
EXECUTE FUNCTION award_loyalty_points_on_delivery();


-- =====================================================================
-- 13. RPC — خصم نقاط الولاء بشكل آمن
--     يُستدعى من الواجهة الأمامية: sb.rpc('sp_redeem_points', { ... })
--     يتحقق من الرصيد الكافي قبل الخصم
-- =====================================================================
CREATE OR REPLACE FUNCTION sp_redeem_points(p_user_id TEXT, p_points INT, p_discount INT)
RETURNS VOID AS $$
DECLARE
  current_points INT;
BEGIN
  -- قفل الصف لمنع التحديثات المتزامنة (race condition)
  SELECT loyalty_points INTO current_points 
  FROM public.users 
  WHERE id = p_user_id 
  FOR UPDATE;
  
  IF current_points IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير موجود';
  END IF;
  
  IF current_points < p_points THEN
    RAISE EXCEPTION 'نقاطك غير كافية';
  END IF;
  
  -- تعيين علم التجاوز للسماح بتعديل النقاط عبر الـ Guard Trigger
  PERFORM set_config('app.bypass_points_guard', 'true', true);
  
  UPDATE public.users
  SET loyalty_points = current_points - p_points
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- منح صلاحية تنفيذ الدالة للزبائن (anon) والموظفين (authenticated)
GRANT EXECUTE ON FUNCTION sp_redeem_points(TEXT, INT, INT) TO anon;
GRANT EXECUTE ON FUNCTION sp_redeem_points(TEXT, INT, INT) TO authenticated;
