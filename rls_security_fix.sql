-- =====================================================================
-- تأمين قاعدة بيانات "الشاطر" — الإصلاحات الأمنية الأساسية
-- =====================================================================
-- تاريخ التنفيذ: 2026-05-20
-- الهدف: قفل عمليات الكتابة/الحذف الخطرة مع الحفاظ على وظائف الزبائن
-- تعليمات: انسخ هذا الكود بالكامل وشغّله في SQL Editor في Supabase
-- =====================================================================


-- =====================================================================
-- 1. تفعيل RLS على جميع الجداول
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
-- 2. جدول الإعدادات (settings) — قراءة عامة، كتابة للمدير فقط
-- =====================================================================
DROP POLICY IF EXISTS "Allow public read for settings" ON public.settings;
DROP POLICY IF EXISTS "Allow admin update for settings" ON public.settings;
DROP POLICY IF EXISTS "Allow admin insert for settings" ON public.settings;
DROP POLICY IF EXISTS "Allow admin write for settings" ON public.settings;
DROP POLICY IF EXISTS "settings_public_read" ON public.settings;
DROP POLICY IF EXISTS "settings_staff_write" ON public.settings;

-- الزبائن: قراءة الأسعار والإعدادات
CREATE POLICY "settings_public_read" 
ON public.settings FOR SELECT TO public USING (true);

-- المدير العام فقط: تعديل الأسعار والإعدادات
CREATE POLICY "settings_staff_write" 
ON public.settings FOR ALL TO authenticated 
USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
);


-- =====================================================================
-- 3. جدول القرطاسية (market_products) — قراءة عامة، كتابة للموظفين
-- =====================================================================
DROP POLICY IF EXISTS "Allow public read for market_products" ON public.market_products;
DROP POLICY IF EXISTS "Allow admin insert for market_products" ON public.market_products;
DROP POLICY IF EXISTS "Allow admin update for market_products" ON public.market_products;
DROP POLICY IF EXISTS "Allow admin delete for market_products" ON public.market_products;
DROP POLICY IF EXISTS "Allow admin write for market_products" ON public.market_products;
DROP POLICY IF EXISTS "market_public_read" ON public.market_products;
DROP POLICY IF EXISTS "market_staff_write" ON public.market_products;

-- الزبائن: تصفح المنتجات
CREATE POLICY "market_public_read" 
ON public.market_products FOR SELECT TO public USING (true);

-- المدراء والموظفون: إضافة/تعديل/حذف المنتجات
CREATE POLICY "market_staff_write" 
ON public.market_products FOR ALL TO authenticated 
USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role IN ('admin', 'operator'))
);


-- =====================================================================
-- 4. جدول الطلبات (orders)
--    INSERT + SELECT مفتوحان للزبائن
--    UPDATE + DELETE للموظفين فقط (تغيير الحالة)
-- =====================================================================
DROP POLICY IF EXISTS "Allow public insert for orders" ON public.orders;
DROP POLICY IF EXISTS "Allow public read own orders" ON public.orders;
DROP POLICY IF EXISTS "Allow staff manage orders" ON public.orders;
DROP POLICY IF EXISTS "orders_public_insert" ON public.orders;
DROP POLICY IF EXISTS "orders_public_read" ON public.orders;
DROP POLICY IF EXISTS "orders_staff_manage" ON public.orders;

-- الزبائن: إرسال طلب جديد
CREATE POLICY "orders_public_insert" 
ON public.orders FOR INSERT TO public WITH CHECK (true);

-- الزبائن: قراءة الطلبات (الفلترة بـ user_id تتم في كود الجافاسكريبت)
CREATE POLICY "orders_public_read" 
ON public.orders FOR SELECT TO public USING (true);

-- الموظفون والمندوبون: إدارة الطلبات (تعديل الحالة، الحذف)
CREATE POLICY "orders_staff_manage" 
ON public.orders FOR ALL TO authenticated 
USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role IN ('admin', 'operator', 'driver', 'preparer'))
);


-- =====================================================================
-- 5. جدول المستخدمين (users)
--    SELECT + INSERT + UPDATE مفتوحة للزبائن
--    حماية عمود loyalty_points عبر Trigger منفصل (القسم 10)
-- =====================================================================
DROP POLICY IF EXISTS "Allow public select for users" ON public.users;
DROP POLICY IF EXISTS "Allow public insert for users" ON public.users;
DROP POLICY IF EXISTS "Allow public update for users" ON public.users;
DROP POLICY IF EXISTS "Allow staff manage users" ON public.users;
DROP POLICY IF EXISTS "users_public_read" ON public.users;
DROP POLICY IF EXISTS "users_public_insert" ON public.users;
DROP POLICY IF EXISTS "users_public_update" ON public.users;
DROP POLICY IF EXISTS "users_staff_manage" ON public.users;

-- قراءة البيانات والنقاط
CREATE POLICY "users_public_read" 
ON public.users FOR SELECT TO public USING (true);

-- تسجيل مستخدم جديد
CREATE POLICY "users_public_insert" 
ON public.users FOR INSERT TO public WITH CHECK (true);

-- تحديث البيانات (الهاتف مثلاً) — حماية النقاط عبر Trigger في القسم 10
CREATE POLICY "users_public_update" 
ON public.users FOR UPDATE TO public USING (true) WITH CHECK (true);

-- المسؤولون: صلاحيات كاملة
CREATE POLICY "users_staff_manage" 
ON public.users FOR ALL TO authenticated 
USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role IN ('admin', 'operator'))
);


-- =====================================================================
-- 6. جدول البحوث (research_requests)
--    INSERT + SELECT للزبائن | UPDATE + DELETE للموظفين فقط
-- =====================================================================
DROP POLICY IF EXISTS "Allow public insert for research_requests" ON public.research_requests;
DROP POLICY IF EXISTS "Allow public read for research_requests" ON public.research_requests;
DROP POLICY IF EXISTS "Allow public update for research_requests" ON public.research_requests;
DROP POLICY IF EXISTS "Allow public delete for research_requests" ON public.research_requests;
DROP POLICY IF EXISTS "Allow public read own research" ON public.research_requests;
DROP POLICY IF EXISTS "Allow staff manage research_requests" ON public.research_requests;
DROP POLICY IF EXISTS "research_public_insert" ON public.research_requests;
DROP POLICY IF EXISTS "research_public_read" ON public.research_requests;
DROP POLICY IF EXISTS "research_staff_manage" ON public.research_requests;

-- الزبائن: تقديم طلب بحث
CREATE POLICY "research_public_insert" 
ON public.research_requests FOR INSERT TO public WITH CHECK (true);

-- الزبائن: قراءة طلبات البحوث
CREATE POLICY "research_public_read" 
ON public.research_requests FOR SELECT TO public USING (true);

-- الموظفون: تعديل/حذف/إدارة طلبات البحوث
CREATE POLICY "research_staff_manage" 
ON public.research_requests FOR ALL TO authenticated 
USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role IN ('admin', 'operator'))
);


-- =====================================================================
-- 7. جدول الملفات الشخصية (profiles) — للموظفين فقط
-- =====================================================================
DROP POLICY IF EXISTS "Allow public read for profiles" ON public.profiles;
DROP POLICY IF EXISTS "Allow admin manage profiles" ON public.profiles;
DROP POLICY IF EXISTS "Allow self read profile" ON public.profiles;
DROP POLICY IF EXISTS "profiles_self_read" ON public.profiles;
DROP POLICY IF EXISTS "profiles_admin_manage" ON public.profiles;

-- الموظف يقرأ ملفه الشخصي فقط (للتحقق من الدور والصلاحيات)
CREATE POLICY "profiles_self_read" 
ON public.profiles FOR SELECT TO authenticated 
USING (auth.uid() = id);

-- المدير: تحكم كامل بملفات الموظفين
CREATE POLICY "profiles_admin_manage" 
ON public.profiles FOR ALL TO authenticated 
USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
);


-- =====================================================================
-- 8. جدول الكوبونات (coupons)
--    SELECT + UPDATE(عداد الاستخدام) للزبائن | إدارة كاملة للمدير
-- =====================================================================
DROP POLICY IF EXISTS "coupons_public_read" ON public.coupons;
DROP POLICY IF EXISTS "coupons_public_update_count" ON public.coupons;
DROP POLICY IF EXISTS "coupons_staff_manage" ON public.coupons;

-- الزبائن: قراءة الكوبونات للتحقق من صلاحيتها
CREATE POLICY "coupons_public_read" 
ON public.coupons FOR SELECT TO public USING (true);

-- الزبائن: تحديث عداد الاستخدام عند استخدام الكوبون
CREATE POLICY "coupons_public_update_count" 
ON public.coupons FOR UPDATE TO public USING (true) WITH CHECK (true);

-- المدير: إدارة كاملة (إنشاء/تعديل/حذف الكوبونات)
CREATE POLICY "coupons_staff_manage" 
ON public.coupons FOR ALL TO authenticated 
USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
);


-- =====================================================================
-- 9. جدول المخزون (supplies + supply_log) — للموظفين فقط
-- =====================================================================
DROP POLICY IF EXISTS "supplies_staff_manage" ON public.supplies;
DROP POLICY IF EXISTS "supply_log_staff_manage" ON public.supply_log;

CREATE POLICY "supplies_staff_manage" 
ON public.supplies FOR ALL TO authenticated 
USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role IN ('admin', 'operator', 'storekeeper'))
);

CREATE POLICY "supply_log_staff_manage" 
ON public.supply_log FOR ALL TO authenticated 
USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role IN ('admin', 'operator', 'storekeeper'))
);


-- =====================================================================
-- 10. Trigger — حماية نقاط الولاء من التلاعب المباشر
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
-- 11. Trigger — إضافة نقاط الولاء تلقائياً عند التوصيل
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
-- 12. RPC — خصم نقاط الولاء بشكل آمن
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
