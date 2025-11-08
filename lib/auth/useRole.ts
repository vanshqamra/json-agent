// lib/auth/useRole.ts
'use client'

import { useEffect, useState } from 'react'
import { useSession } from './useSession'

export function useRole() {
  const { session, supabase } = useSession()
  const [role, setRole] = useState<'admin' | 'client' | null>(null)

  useEffect(() => {
    const run = async () => {
      if (!session?.user || !supabase) {
        setRole(null)
        return
      }
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle()
      if (!error && data) setRole((data.role as any) ?? 'client')
    }
    run()
  }, [session?.user?.id, supabase])

  return role
}
