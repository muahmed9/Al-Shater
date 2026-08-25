import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  try {
    // ── 1. Extract JWT token ────────────────────────────────
    const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (!token) return json({ error: 'غير مصرح — لا يوجد توكن' })

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceRoleKey)

    // ── 2. Verify caller identity using token ───────────────
    const { data: { user: caller }, error: authError } = await admin.auth.getUser(token)
    console.log('[create-staff] caller:', caller?.id, caller?.email, 'authError:', authError?.message)
    if (authError || !caller) return json({ error: 'غير مصرح — توكن غير صالح' })

    // ── 3. Check caller is admin ────────────────────────────
    const { data: callerProfile, error: profileErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', caller.id)
      .maybeSingle()

    const tgId = caller.user_metadata?.telegram_user_id || caller.user_metadata?.telegram_id
    const isTgAdmin = tgId === '7618746133' || tgId === '929803281'
    const isAdmin = callerProfile?.role === 'admin' || isTgAdmin

    console.log('[create-staff] profile:', callerProfile, 'isTgAdmin:', isTgAdmin, 'profileErr:', profileErr?.message)
    if (!isAdmin) {
      return json({ error: 'غير مسموح — فقط المدير يمكنه إنشاء حسابات' })
    }

    // ── 4. Parse request body ───────────────────────────────
    const { email, password, name, emoji, permissions } = await req.json()
    console.log('[create-staff] creating:', { email, name, permissions })

    if (!email || !password || !name) {
      return json({ error: 'يرجى إدخال الاسم والبريد وكلمة المرور' })
    }
    if (password.length < 6) {
      return json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' })
    }
    if (!permissions || !permissions.length) {
      return json({ error: 'يرجى اختيار صلاحية واحدة على الأقل' })
    }

    // ── 5. Create the auth user ─────────────────────────────
    const { data: newUser, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name },
    })

    if (createError) {
      console.log('[create-staff] createUser error:', createError.message)
      if (createError.message?.includes('already') || createError.message?.includes('exists')) {
        return json({ error: 'هذا البريد الإلكتروني مسجل مسبقاً' })
      }
      return json({ error: createError.message })
    }

    console.log('[create-staff] user created:', newUser.user.id)

    // ── 6. Create the profile row ───────────────────────────
    const { error: profileError } = await admin.from('profiles').insert({
      id: newUser.user.id,
      name,
      emoji: emoji || '👤',
      role: 'custom',
      permissions,
    })

    if (profileError) {
      console.log('[create-staff] profile insert error:', profileError.message)
      await admin.auth.admin.deleteUser(newUser.user.id)
      return json({ error: 'فشل إنشاء الملف الشخصي: ' + profileError.message })
    }

    console.log('[create-staff] ✅ success for', email)
    return json({ success: true, user_id: newUser.user.id })

  } catch (err) {
    console.error('[create-staff] unexpected error:', err.message)
    return json({ error: err.message })
  }
})
