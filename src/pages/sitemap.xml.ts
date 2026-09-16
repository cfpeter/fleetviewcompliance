import type { APIRoute } from 'astro'
import { site } from '../lib/site.ts'

const paths = ['/', '/features', '/pricing', '/about', '/privacy', '/terms']

export const GET: APIRoute = () => {
  const urls = paths
    .map((p) => `  <url><loc>${site.url}${p === '/' ? '' : p}</loc></url>`)
    .join('\n')
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
  )
}
