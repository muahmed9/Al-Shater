import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function parseJwtPayload(token: string) {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const base64Url = parts[1]
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(base64)
    return JSON.parse(raw)
  } catch (e) {
    console.error('[parseJwtPayload] failed:', e)
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  try {
    // ── 1. Extract and Verify Token ─────────────────────────
    const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (!token) {
      return json({ error: 'غير مصرح — يرجى تسجيل الدخول أولاً كمدير' })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceRoleKey)

    // Decode JWT payload
    const payload = parseJwtPayload(token)
    const callerId = payload?.sub
    console.log('[create-staff] Caller ID from JWT:', callerId)

    if (!callerId) {
      return json({ error: 'غير مصرح — صيغة التوكن غير صحيحة' })
    }

    // Verify caller exists in auth.users
    const { data: callerUser, error: callerErr } = await admin.auth.admin.getUserById(callerId)
    if (callerErr || !callerUser?.user) {
      console.error('[create-staff] getUserById error:', callerErr)
      return json({ error: 'غير مصرح — الحساب غير موجود في النظام' })
    }

    const caller = callerUser.user
    const callerEmail = caller.email?.toLowerCase() || ''
    const tgId = String(caller.user_metadata?.telegram_user_id || caller.user_metadata?.telegram_id || '')

    // Check if admin in profiles table OR matches known admin emails / TG IDs
    const { data: callerProfile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', caller.id)
      .maybeSingle()

    const isKnownAdminEmail = callerEmail === 'mustafaalsaadi1999@gmail.com' || callerEmail === 'admin@shater.app'
    const isKnownTgAdmin = tgId === '7618746133' || tgId === '929803281'
    const isAdmin = callerProfile?.role === 'admin' || isKnownAdminEmail || isKnownTgAdmin

    console.log('[create-staff] Auth check:', {
      callerId: caller.id,
      callerEmail,
      tgId,
      profileRole: callerProfile?.role,
      isAdmin,
    })

    if (!isAdmin) {
      return json({ error: 'غير مسموح — هذه العملية مخصصة للمدير العام فقط' })
    }

    // ── 2. Parse and Validate Request Body ──────────────────
    const body = await req.json()
    const name = String(body.name || '').trim()
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const emoji = String(body.emoji || '👤').trim()
    const permissions = Array.isArray(body.permissions) ? body.permissions : []

    console.log('[create-staff] Payload:', { name, email, emoji, permissionsCount: permissions.length })

    if (!name) return json({ error: 'يرجى إدخال اسم الموظف' })
    if (!email || !email.includes('@')) return json({ error: 'يرجى إدخال بريد إلكتروني صالح' })
    if (password.length < 6) return json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' })
    if (!permissions.length) return json({ error: 'يرجى اختيار صلاحية واحدة على الأقل للموظف' })

    // ── 3. Create or Update Auth User ───────────────────────
    let targetUserId: string | null = null

    const { data: newUser, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name, emoji },
    })

    if (createError) {
      console.warn('[create-staff] createUser note:', createError.message)
      if (createError.message?.toLowerCase().includes('already') || createError.message?.toLowerCase().includes('exists')) {
        // User already exists in auth.users, let's find and update them
        const { data: listData } = await admin.auth.admin.listUsers({ perPage: 1000 })
        const existing = listData?.users?.find(u => u.email?.toLowerCase() === email)
        if (existing) {
          targetUserId = existing.id
          await admin.auth.admin.updateUserById(targetUserId, {
            password,
            user_metadata: { full_name: name, emoji },
          })
          console.log('[create-staff] Updated existing auth user:', targetUserId)
        } else {
          return json({ error: 'البريد مسجل مسبقاً، تعذر تحديث الحساب' })
        }
      } else {
        return json({ error: 'فشل إنشاء المستخدم: ' + createError.message })
      }
    } else {
      targetUserId = newUser.user.id
      console.log('[create-staff] Created new auth user:', targetUserId)
    }

    if (!targetUserId) {
      return json({ error: 'تعذر تحديد معرّف الحساب' })
    }

    // ── 4. Upsert Profile Row ───────────────────────────────
    const { error: profileError } = await admin.from('profiles').upsert({
      id: targetUserId,
      name,
      emoji,
      role: 'custom',
      permissions,
      updated_at: new Date().toISOString(),
    })

    if (profileError) {
      console.error('[create-staff] profile upsert error:', profileError)
      return json({ error: 'فشل حفظ الملف الشخصي: ' + profileError.message })
    }

    console.log('[create-staff] ✅ Successfully created staff:', { targetUserId, name, email })
    return json({
      success: true,
      user_id: targetUserId,
      name,
      email,
      message: `تم إنشاء حساب الموظف (${name}) بنجاح`,
    })

  } catch (err: any) {
    console.error('[create-staff] Uncaught error:', err)
    return json({ error: 'حدث خطأ في السيرفر: ' + (err?.message || err) })
  }
})
