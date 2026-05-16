import { Config } from './config.js';
const { URL, ANON_KEY } = Config.SUPABASE;
if (!URL || !ANON_KEY) throw new Error('[supabase.js] مفاتيح Supabase مفقودة في config.js');
if (!window.supabase) {
  alert('خطأ: لم يتم تحميل مكتبة Supabase. يرجى التحقق من اتصال الإنترنت.');
  throw new Error('[supabase.js] window.supabase is undefined');
}

export const sb = window.supabase.createClient(URL, ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  realtime: { timeout: 20_000 },
});

console.log('🚀 Supabase initialized for project:', URL.split('//')[1].split('.')[0]);
