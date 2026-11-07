-- Regression test: a staff user cannot repoint a supplier_invoices row at
-- someone else's file.
--
-- Why it matters: the supplier_invoices_update policy lets staff edit their own
-- pending_review row, and its WITH CHECK pins only uploaded_by. The storage
-- policy supplier_invoices_files_read grants SELECT on any object whose name is
-- the file_path of a row the caller uploaded. So if file_path were writable,
-- staff A could set it to the name of another uploader's object and download it.
-- UNIQUE(file_path) already stops A from taking a name another row still holds,
-- but an orphan object (worker killed between upload and insert, or a storage
-- remove that failed on delete) has no row, and would be readable.
-- What stops that is the BEFORE UPDATE trigger supplier_invoices_touch, which
-- resets file_path (and uploaded_by, file_sha256, ...) to OLD on every update.
-- This check fails if that trigger is dropped, disabled or loosened.
--
-- Runs as staff A, admin and service_role (simulated JWT claims, no real
-- tokens), then RAISES with the results, so the transaction always rolls back
-- and nothing it inserts is kept. Safe on prod; scripts/qa-scan.sh --db runs it.
-- Expected: every key "ok" and "detail": {}. Any "FAIL" is a regression; its
-- reason is under "detail".
--
-- admin and service_role are pinned too, today. Nothing in the app changes
-- file_path after insert (supplier-invoices/ingest.ts sets it once). If that is
-- relaxed on purpose for service_role, change those two expectations.
DO $t$
DECLARE
  r jsonb := '{}'::jsonb;
  tag text := 'user_test_sifp_' || substr(md5(random()::text), 1, 8);
  a_sub text := tag || '_a';
  b_sub text := tag || '_b';
  admin_sub text := tag || '_admin';
  a_path text := tag || '/a.pdf';
  b_path text := tag || '/b.pdf';
  orphan_path text := tag || '/orphan.pdf';   -- B's object, no row points at it
  a_id uuid := gen_random_uuid();
  b_id uuid := gen_random_uuid();
  v text;
  fp text;
  sn text;
  ub text;
  n bigint;
  tg text := (SELECT tgenabled::text FROM pg_trigger
               WHERE tgrelid = 'public.supplier_invoices'::regclass
                 AND tgname = 'supplier_invoices_touch');
BEGIN
  r := r || jsonb_build_object('trigger_enabled',
    CASE WHEN tg IN ('O', 'A') THEN 'ok' ELSE 'FAIL tgenabled=' || coalesce(tg, 'missing') END);

  -- Fixtures, as the table owner.
  INSERT INTO public.user_roles (user_id, role, email) VALUES
    (a_sub, 'employee', a_sub || '@test.invalid'),
    (b_sub, 'employee', b_sub || '@test.invalid'),
    (admin_sub, 'admin', admin_sub || '@test.invalid');
  INSERT INTO public.supplier_invoices (id, file_path, file_mime, file_size, file_sha256, uploaded_by, supplier_name)
  VALUES (a_id, a_path, 'application/pdf', 1, tag || '_sha_a', a_sub, 'A original'),
         (b_id, b_path, 'application/pdf', 1, tag || '_sha_b', b_sub, 'B original');
  INSERT INTO storage.objects (bucket_id, name) VALUES
    ('supplier-invoices', a_path), ('supplier-invoices', b_path), ('supplier-invoices', orphan_path);

  -- ── staff A ───────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', a_sub)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  r := r || jsonb_build_object('staff_role_sanity',
    CASE WHEN public.is_staff() AND NOT public.is_admin() THEN 'ok' ELSE 'FAIL is_staff/is_admin wrong' END);

  -- The attack: repoint own pending row at the orphan, alongside a legit edit.
  BEGIN
    UPDATE public.supplier_invoices SET file_path = orphan_path, supplier_name = 'A edited' WHERE id = a_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    r := r || jsonb_build_object('staff_own_row_updatable', CASE WHEN n = 1 THEN 'ok' ELSE 'FAIL rows=' || n END);
  EXCEPTION WHEN others THEN
    r := r || jsonb_build_object('staff_own_row_updatable', 'FAIL ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- End to end, as A: which of the three test objects can A read now?
  SELECT string_agg(name, ',' ORDER BY name) INTO v
    FROM storage.objects WHERE bucket_id = 'supplier-invoices' AND name IN (a_path, b_path, orphan_path);
  r := r || jsonb_build_object('staff_reads_only_own_file',
    CASE WHEN v = a_path THEN 'ok' ELSE 'FAIL visible=' || coalesce(v, 'none') END);

  -- Handing the row to someone else: silently pinned or refused are both safe.
  BEGIN
    UPDATE public.supplier_invoices SET uploaded_by = b_sub WHERE id = a_id;
  EXCEPTION WHEN insufficient_privilege OR with_check_option_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.supplier_invoices SET supplier_name = 'pwned' WHERE id = b_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    r := r || jsonb_build_object('staff_cannot_update_others_row',
      CASE WHEN n = 0 THEN 'ok' ELSE 'FAIL rows=' || n END);
  EXCEPTION WHEN insufficient_privilege OR with_check_option_violation THEN
    r := r || jsonb_build_object('staff_cannot_update_others_row', 'ok');
  END;

  BEGIN
    INSERT INTO public.supplier_invoices (file_path, file_mime, file_size, file_sha256, uploaded_by)
    VALUES (orphan_path, 'application/pdf', 1, tag || '_sha_c', a_sub);
    r := r || jsonb_build_object('staff_insert_denied', 'FAIL insert allowed');
  EXCEPTION WHEN insufficient_privilege OR with_check_option_violation THEN
    r := r || jsonb_build_object('staff_insert_denied', 'ok');
  END;
  EXECUTE 'RESET ROLE';

  -- Verify as the table owner, so no RLS sits between the write and the read.
  SELECT file_path, supplier_name, uploaded_by INTO fp, sn, ub FROM public.supplier_invoices WHERE id = a_id;
  r := r || jsonb_build_object(
    'staff_file_path_pinned',   CASE WHEN fp = a_path THEN 'ok' ELSE 'FAIL file_path=' || coalesce(fp, 'null') END,
    'staff_other_edit_saved',   CASE WHEN sn = 'A edited' THEN 'ok' ELSE 'FAIL supplier_name=' || coalesce(sn, 'null') END,
    'staff_uploaded_by_pinned', CASE WHEN ub = a_sub THEN 'ok' ELSE 'FAIL uploaded_by=' || coalesce(ub, 'null') END);
  SELECT supplier_name INTO sn FROM public.supplier_invoices WHERE id = b_id;
  IF sn <> 'B original' THEN
    r := r || jsonb_build_object('staff_cannot_update_others_row', 'FAIL supplier_name=' || coalesce(sn, 'null'));
  END IF;

  -- ── admin ─────────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', admin_sub)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.supplier_invoices SET file_path = tag || '/admin.pdf' WHERE id = b_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    r := r || jsonb_build_object('admin_update_reached_row', CASE WHEN n = 1 THEN 'ok' ELSE 'FAIL rows=' || n END);
  EXCEPTION WHEN others THEN
    r := r || jsonb_build_object('admin_update_reached_row', 'FAIL ' || SQLSTATE || ' ' || SQLERRM);
  END;
  EXECUTE 'RESET ROLE';
  SELECT file_path INTO fp FROM public.supplier_invoices WHERE id = b_id;
  r := r || jsonb_build_object('admin_file_path_pinned',
    CASE WHEN fp = b_path THEN 'ok' ELSE 'FAIL file_path=' || coalesce(fp, 'null') END);

  -- ── service_role ──────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  BEGIN
    UPDATE public.supplier_invoices SET file_path = tag || '/svc.pdf' WHERE id = b_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    r := r || jsonb_build_object('service_role_update_reached_row', CASE WHEN n = 1 THEN 'ok' ELSE 'FAIL rows=' || n END);
  EXCEPTION WHEN others THEN
    r := r || jsonb_build_object('service_role_update_reached_row', 'FAIL ' || SQLSTATE || ' ' || SQLERRM);
  END;
  EXECUTE 'RESET ROLE';
  SELECT file_path INTO fp FROM public.supplier_invoices WHERE id = b_id;
  r := r || jsonb_build_object('service_role_file_path_pinned',
    CASE WHEN fp = b_path THEN 'ok' ELSE 'FAIL file_path=' || coalesce(fp, 'null') END);

  -- scripts/qa-scan.sh matches the exact value "FAIL"; keep the why in detail.
  SELECT coalesce(jsonb_object_agg(key, CASE WHEN value LIKE 'FAIL%' THEN 'FAIL' ELSE value END), '{}'::jsonb)
         || jsonb_build_object('detail', coalesce(jsonb_object_agg(key, value) FILTER (WHERE value LIKE 'FAIL%'), '{}'::jsonb))
    INTO r
    FROM jsonb_each_text(r);
  RAISE EXCEPTION 'DRYRUN_RESULT %', r::text;
END
$t$;
