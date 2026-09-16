import type { APIRoute } from 'astro'
import { sessionClient } from '../lib/supabase/server.ts'

export const POST: APIRoute = async ({ cookies, request, redirect }) => {
  const supabase = sessionClient(cookies, request.headers)
  await supabase.auth.signOut()
  return redirect('/')
}

// A GET would let any page log the user out with an <img> tag.
export const GET: APIRoute = ({ redirect }) => redirect('/')
