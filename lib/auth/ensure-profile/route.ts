// app/api/auth/ensure-profile/route.ts
import { NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase/server'

export async function POST() {
  const supabase = createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, reason: 'not_signed_in' }, { status: 401 })

  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (!existing) {
    await supabase.from('profiles').insert({
      id: user.id,
      full_name: user.user_metadata?.full_name ?? null,
      role: 'client'
    })
  }
  return NextResponse.json({ ok: true })
}
