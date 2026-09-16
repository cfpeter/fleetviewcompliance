/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

import type { SupabaseClient } from '@supabase/supabase-js'

declare global {
  namespace App {
    interface Locals {
      // Set by middleware on guarded routes. `!` is safe only behind the guard.
      supabase?: SupabaseClient
      userId?: string
      carrierId?: string
    }
  }
}

export {}
