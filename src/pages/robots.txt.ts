import type { APIRoute } from 'astro'
import { site } from '../lib/site.ts'

export const GET: APIRoute = () =>
  new Response(
    // /check renders a specific carrier's federal record. It is public data, but
    // there is no reason for us to have search engines crawl every DOT number.
    `User-agent: *\nAllow: /\nDisallow: /check\n\nSitemap: ${site.url}/sitemap.xml\n`,
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  )
