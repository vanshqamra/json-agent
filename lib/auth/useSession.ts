// lib/auth/useSession.ts
'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { createSupabaseBrowser } from '@/lib/supabase/browser'

export function useSession() {
  const supabase = useMemo(() => createSupabaseBrowser(), [])
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    if (!supabase) return undefined
    let mounted = true
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) setSession(data.session)
    })
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => {
      mounted = false
      subscription?.subscription?.unsubscribe()
    }
  }, [supabase])

  return { session, supabase }
}
