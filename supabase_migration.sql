-- 1. إضافة الأعمدة المفقودة لجدول طلبات البحوث (research_requests)
ALTER TABLE public.research_requests 
ADD COLUMN IF NOT EXISTS name text,
ADD COLUMN IF NOT EXISTS phone text,
ADD COLUMN IF NOT EXISTS subject text,
ADD COLUMN IF NOT EXISTS type text,
ADD COLUMN IF NOT EXISTS pages integer,
ADD COLUMN IF NOT EXISTS deadline timestamp with time zone;

-- 2. تفعيل الحماية RLS لجميع الجداول وتعديل الصلاحيات للتأكد من وصول الزوار والمشرفين
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_requests ENABLE ROW LEVEL SECURITY;

-- 3. سياسات الوصول لجدول الإعدادات (settings)
DROP POLICY IF EXISTS "Allow public read for settings" ON public.settings;
CREATE POLICY "Allow public read for settings" 
ON public.settings FOR SELECT 
TO public 
USING (true);

DROP POLICY IF EXISTS "Allow admin update for settings" ON public.settings;
CREATE POLICY "Allow admin update for settings" 
ON public.settings FOR UPDATE 
TO public 
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Allow admin insert for settings" ON public.settings;
CREATE POLICY "Allow admin insert for settings" 
ON public.settings FOR INSERT 
TO public 
WITH CHECK (true);

-- 4. سياسات الوصول لجدول القرطاسية (market_products)
DROP POLICY IF EXISTS "Allow public read for market_products" ON public.market_products;
CREATE POLICY "Allow public read for market_products" 
ON public.market_products FOR SELECT 
TO public 
USING (true);

DROP POLICY IF EXISTS "Allow admin insert for market_products" ON public.market_products;
CREATE POLICY "Allow admin insert for market_products" 
ON public.market_products FOR INSERT 
TO public 
WITH CHECK (true);

DROP POLICY IF EXISTS "Allow admin update for market_products" ON public.market_products;
CREATE POLICY "Allow admin update for market_products" 
ON public.market_products FOR UPDATE 
TO public 
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Allow admin delete for market_products" ON public.market_products;
CREATE POLICY "Allow admin delete for market_products" 
ON public.market_products FOR DELETE 
TO public 
USING (true);

-- 5. سياسات الوصول لجدول طلبات البحوث (research_requests)
DROP POLICY IF EXISTS "Allow public insert for research_requests" ON public.research_requests;
CREATE POLICY "Allow public insert for research_requests" 
ON public.research_requests FOR INSERT 
TO public 
WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public read for research_requests" ON public.research_requests;
CREATE POLICY "Allow public read for research_requests" 
ON public.research_requests FOR SELECT 
TO public 
USING (true);

DROP POLICY IF EXISTS "Allow public update for research_requests" ON public.research_requests;
CREATE POLICY "Allow public update for research_requests" 
ON public.research_requests FOR UPDATE 
TO public 
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public delete for research_requests" ON public.research_requests;
CREATE POLICY "Allow public delete for research_requests" 
ON public.research_requests FOR DELETE 
TO public 
USING (true);

