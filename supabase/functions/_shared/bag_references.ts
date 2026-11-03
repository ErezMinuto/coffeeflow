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

const MOUNT_KENYA: BagReference = {
  front:      'bag-references/mount-kenya/front.png',
  views:      ['bag-references/mount-kenya/three-quarter-left.png', 'bag-references/mount-kenya/three-quarter-right.png'],
  label_text: ['Mount Kenya AA+'],
}

export const BAG_REFERENCES: Record<number, BagReference> = {
  // Daye Bensa light roast, photographed 2026-10-20 (IMG_6816 front, IMG_6815 left three-quarter).
  78450: {
    front:      'bag-references/daye-bensa/front.png',
    views:      ['bag-references/daye-bensa/three-quarter-left.png'],
    label_text: ['Daye Bensa'],
  },
  // Dark Chocolate, photographed 2026-10-20 (IMG_6822 front, IMG_6820 left / IMG_6821 right three-quarter).
  64860: {
    front:      'bag-references/dark-chocolate/front.png',
    views:      ['bag-references/dark-chocolate/three-quarter-left.png', 'bag-references/dark-chocolate/three-quarter-right.png'],
    label_text: ['Dark Chocolate'],
  },
  // Velvet Star, photographed 2026-10-20 (IMG_6824 front, IMG_6826 right / IMG_6827 left three-quarter).
  64855: {
    front:      'bag-references/velvet-star/front.png',
    views:      ['bag-references/velvet-star/three-quarter-right.png', 'bag-references/velvet-star/three-quarter-left.png'],
    label_text: ['Velvet Star'],
  },
  // Guatemala Antigua (roasted), photographed 2026-10-20 (IMG_6831 front).
  // The printed label has a typo, "Guatemala Aantigua". Erez: "should be
  // Antigua", so the front photo was retouched to read "Antigua" and the
  // label check expects that. Front only: in the three-quarter shots the name
  // is too small and slanted to retouch cleanly, and they would teach the
  // typo. (65111 is green coffee and is never featured, so it has no entry.)
  65179: {
    front:      'bag-references/guatemala-antigua/front.png',
    views:      [],
    label_text: ['Guatemala Antigua'],
  },
  // Mount Kenya AA+, photographed 2026-10-20 (IMG_6836 front, IMG_6833 left /
  // IMG_6834 right three-quarter). Two roasted store rows show the same bag
  // (identical store mockups), so both use these photos. 65110 is green
  // coffee and has no entry.
  65135: MOUNT_KENYA,
  65463: MOUNT_KENYA,
  // Jungle Java, photographed 2026-10-20 (IMG_6840 front, IMG_6841 left / IMG_6842 right).
  65431: {
    front:      'bag-references/jungle-java/front.png',
    views:      ['bag-references/jungle-java/three-quarter-left.png', 'bag-references/jungle-java/three-quarter-right.png'],
    label_text: ['Jungle Java'],
  },
  // Guji- Ethiopia, photographed 2026-10-20 (IMG_6844 front, IMG_6845 left /
  // IMG_6846 right). The label really prints "Guji- Ethiopia" (hyphen on
  // "Guji", space after); the check ignores hyphens and spacing.
  65169: {
    front:      'bag-references/guji-ethiopia/front.png',
    views:      ['bag-references/guji-ethiopia/three-quarter-left.png', 'bag-references/guji-ethiopia/three-quarter-right.png'],
    label_text: ['Guji- Ethiopia'],
  },
  // Aristo, photographed 2026-10-20 (IMG_6837 front, IMG_6839 left; no right view was shot).
  64702: {
    front:      'bag-references/aristo/front.png',
    views:      ['bag-references/aristo/three-quarter-left.png'],
    label_text: ['Aristo'],
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
