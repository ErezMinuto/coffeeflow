// Minuto SEO Agent — CMS / catalog reader.
//
// Reads from the existing tables maintained by other sync jobs:
//   minuto_blog_posts — populated by an RSS sync of minuto.co.il/blog
//   woo_products      — populated by the WooCommerce sync job
//   origins / products — internal coffee inventory tables
//
// We never write to these tables from the SEO Agent. The Writer Worker
// will push new drafts to WordPress via the existing blog-publish edge
// function — that's a separate concern handled there, not here.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Published blog posts (avoid duplicate recommendations) ───────────────

export interface PublishedBlogPost {
  title: string
  url: string
  published_at: string | null
}

export async function fetchRecentBlogPosts(
  supabase: SupabaseClient,
  sinceIsoDate: string,
  limit = 100,
): Promise<PublishedBlogPost[]> {
  const { data, error } = await supabase
    .from('minuto_blog_posts')
    .select('title, url, published_at')
    .gte('published_at', sinceIsoDate)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(limit)
  if (error) throw new Error(`fetchRecentBlogPosts failed: ${error.message}`)
  return (data ?? []) as PublishedBlogPost[]
}

// ── Product catalog (so the orchestrator can pick relevant SKUs) ─────────

export interface WooProduct {
  name: string
  price: number | null
  permalink: string | null
  image_url: string | null
  // woo_products tracks WooCommerce status as text ('instock' | 'outofstock' |
  // 'onbackorder'), NOT a numeric count. For numeric stock levels, see
  // fetchInventoryAlerts which reads the internal `products` table.
  stock_status: string | null
}

export async function fetchActiveCatalog(supabase: SupabaseClient): Promise<WooProduct[]> {
  const { data, error } = await supabase
    .from('woo_products')
    .select('name, price, permalink, image_url, stock_status')
    .not('image_url', 'is', null)
    .order('name')
  if (error) throw new Error(`fetchActiveCatalog failed: ${error.message}`)
  return (data ?? []) as WooProduct[]
}

// ── Inventory health (low-stock signals into orchestrator's planning) ────

export interface InventoryAlert {
  name: string
  packed_stock: number
  min_packed_stock: number | null
  state: 'low' | 'critical' | 'healthy'
}

export async function fetchInventoryAlerts(
  supabase: SupabaseClient,
): Promise<InventoryAlert[]> {
  const { data, error } = await supabase
    .from('products')
    .select('name, packed_stock, min_packed_stock')
  if (error) throw new Error(`fetchInventoryAlerts failed: ${error.message}`)

  return (data ?? []).map((p: { name: string; packed_stock: number; min_packed_stock: number | null }) => {
    const min = p.min_packed_stock ?? 0
    const state =
      p.packed_stock <= 0       ? 'critical'
      : p.packed_stock <= min   ? 'low'
      :                            'healthy'
    return { ...p, state }
  })
}
