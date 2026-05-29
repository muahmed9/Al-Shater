import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function verifyTelegram(initData: string, botToken: string) {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null
  params.delete('hash')

  const dataStr = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const enc = new TextEncoder()
  const secretKey = await crypto.subtle.importKey(
    'raw', enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const secretBytes = await crypto.subtle.sign('HMAC', secretKey, enc.encode(botToken))
  const dataKey = await crypto.subtle.importKey(
    'raw', secretBytes,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const computed = await crypto.subtle.sign('HMAC', dataKey, enc.encode(dataStr))
  const hex = [...new Uint8Array(computed)]
    .map(b => b.toString(16).padStart(2, '0')).join('')
  return hex === hash ? Object.fromEntries(params.entries()) : null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const { initData } = await req.json()
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || Deno.env.get('BOT_TOKEN')!
    const verified = await verifyTelegram(initData, botToken)
    if (!verified) return new Response(
      JSON.stringify({ error: 'توقيع Telegram غير صحيح' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
    const tgUser = JSON.parse(verified.user || '{}')
    const telegramId = String(tgUser.id)
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const email = `tg_${telegramId}@shater-internal.app`
    const password = `tg_${telegramId}_${botToken.slice(0, 10)}`
    let { data, error } = await admin.auth.signInWithPassword({ email, password })
    if (error) {
      await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: {
          telegram_user_id: telegramId,
          first_name: tgUser.first_name ?? '',
          username: tgUser.username ?? '',
        }
      })
      ;({ data, error } = await admin.auth.signInWithPassword({ email, password }))
    }
    if (error) throw error
    return new Response(JSON.stringify({
      access_token: data.session!.access_token,
      refresh_token: data.session!.refresh_token,
      telegram_id: telegramId,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
