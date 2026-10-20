// Real photos of Minuto bags, used as the image model's bag reference in place
// of the store image.
//
// The store images are design mockups: Daye Bensa's shows a stand-up zip
// pouch with the label printed on, while the real 330g bag is a flat-bottom
// pouch with a sticker label. Renders copied the mockup. A bag with an entry
// here is rendered from photos of the real bag (cut out and white-balanced);
// a bag without one keeps the store image, exactly as before.
//
// Photos live in the marketing bucket under bag-references/<slug>/, a prefix
// purge-old-media never touches. To add a bag: upload a front photo (and up
// to two other angles) there, then add its WooCommerce woo_id below.
//
// label_text is what the bag's label actually prints, checked letter by
// letter after each render (see bag_label_check.ts). It is NOT the store
// title ("פולי קפה אתיופיה דיי בנסה חד זני ... - Minuto Daye Bensa ..."),
// which the bag never shows.

export interface BagReference {
  front:      string     // storage path of the main front photo; the label authority
  views:      string[]   // storage paths of other angles, for the bag's 3D shape (max 2)
  label_text: string[]   // product name as printed on the label
}

const BUCKET = 'marketing'

export const BAG_REFERENCES: Record<number, BagReference> = {
  // Daye Bensa light roast, photographed 2026-10-20 (IMG_6816 front, IMG_6815 left three-quarter).
  78450: {
    front:      'bag-references/daye-bensa/front.png',
    views:      ['bag-references/daye-bensa/three-quarter-left.png'],
    label_text: ['Daye Bensa'],
  },
}

// The lockup printed on every Minuto bag, checked even when a bag has no entry.
export const BAG_LOCKUP_TEXT = ['MINUTO', 'Café Roastery']

export function bagReferenceFor(wooId: number | null | undefined): BagReference | null {
  return typeof wooId === 'number' ? BAG_REFERENCES[wooId] ?? null : null
}

export function storagePublicUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${path}`
}
