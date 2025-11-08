// lib/auth/useSession.ts
'use client'

import { useEffect, useState } from 'react'
import { createSupabaseBrowser } from '@/lib/supabase/browser'

export function useSession() {
  const [session, setSession] = useState<Awaited<ReturnType<ReturnType<typeof createSupabaseBrowser>['auth']['getSession']>>['data']['session'] | null>(null)
  const supabase = createSupabaseBrowser()

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data }) => mounted && setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => { mounted = false; sub.subscription.unsubscribe() }
  }, [])

  return { session, supabase }
}
