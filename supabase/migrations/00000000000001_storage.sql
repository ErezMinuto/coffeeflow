-- Storage objects that a public/app/ops dump cannot see: the two buckets and the
-- one custom policy on storage.objects (prod, 2026-11-07). The 11 triggers on
-- storage/auth tables are Supabase's own and are not reproduced here.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
  ('marketing', 'marketing', true, 52428800,
   ARRAY['image/jpeg','image/png','image/webp','video/mp4','video/quicktime']),
  ('supplier-invoices', 'supplier-invoices', false, 10485760,
   ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "supplier_invoices_files_read" ON storage.objects;
CREATE POLICY "supplier_invoices_files_read" ON storage.objects
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    bucket_id = 'supplier-invoices'
    AND (
      public.is_admin()
      OR public.is_bookkeeper()
      OR EXISTS (
        SELECT 1 FROM public.supplier_invoices si
        WHERE si.file_path = objects.name
          AND si.uploaded_by = (auth.jwt() ->> 'sub')
      )
    )
  );
