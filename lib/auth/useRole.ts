// lib/auth/useRole.ts
'use client'

import { useEffect, useState } from 'react'
import { createSupabaseBrowser } from '@/lib/supabase/browser'
import { useSession } from './useSession'

export function useRole() {
  const { session } = useSession()
  const [role, setRole] = useState<'admin'|'client'|null>(null)

  useEffect(() => {
    const run = async () => {
      if (!session?.user) return setRole(null)
      const supabase = createSupabaseBrowser()
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle()
      if (!error && data) setRole((data.role as any) ?? 'client')
    }
    run()
  }, [session?.user?.id])

  return role
}
