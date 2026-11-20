-- Manager tasks: the owner assigns a task to a staff member (today: the shop
-- manager), the assignee gets a private Telegram DM from employee-bot with a
-- "✅ בוצע" button, and a daily morning reminder lists every task that is due
-- or overdue until it is marked done (in Telegram or on the CoffeeFlow page
-- "משימות לצוות").
--
-- Who is who:
--   employees.clerk_user_id links a CoffeeFlow login (Clerk `sub`) to the
--   employee row that carries the telegram_id. The assignee reads their own
--   tasks through it; the creator is told "done" through it.
--
-- Writes:
--   admins       → insert / update / delete any task (RLS)
--   linked staff → add tasks for themselves; edit / delete those (RLS)
--   the assignee → mark their own task done or open again (set_manager_task_done)
--   employee-bot → service role (Telegram button, notify / remind bookkeeping)

-- ── employees ↔ Clerk login ─────────────────────────────────────────────────
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS clerk_user_id text;
CREATE UNIQUE INDEX IF NOT EXISTS employees_clerk_user_id_key
  ON public.employees (clerk_user_id) WHERE clerk_user_id IS NOT NULL;

-- Which login belongs to which employee is set as data after this migration
-- (UPDATE employees SET clerk_user_id = <user_roles.user_id> WHERE id = …),
-- never in the repo: it would mean committing staff email addresses.

-- ── manager_tasks ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.manager_tasks (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title                text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  notes                text CHECK (notes IS NULL OR length(notes) <= 2000),
  assignee_employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  -- Defaults to today in Israel; the owner can pick another day.
  due_date             date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Jerusalem')::date),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_by           text DEFAULT (auth.jwt() ->> 'sub'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  done_at              timestamptz,
  done_via             text CHECK (done_via IN ('app', 'telegram')),
  -- employee-bot bookkeeping
  notified_at          timestamptz,           -- first DM to the assignee
  last_reminded_on     date,                  -- Israel date of the last daily reminder
  reminder_count       integer NOT NULL DEFAULT 0,
  creator_notified_at  timestamptz,           -- "done" DM to the creator
  CONSTRAINT manager_tasks_done_consistent CHECK ((status = 'done') = (done_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS manager_tasks_open_due_idx
  ON public.manager_tasks (due_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS manager_tasks_assignee_idx
  ON public.manager_tasks (assignee_employee_id, status);

-- True when the signed-in Clerk user is the employee the task is assigned to.
CREATE OR REPLACE FUNCTION public.is_task_assignee(p_employee_id bigint) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employees
     WHERE id = p_employee_id
       AND clerk_user_id IS NOT NULL
       AND clerk_user_id = (auth.jwt() ->> 'sub')
  );
$$;

ALTER TABLE public.manager_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manager_tasks_select ON public.manager_tasks;
CREATE POLICY manager_tasks_select ON public.manager_tasks
  FOR SELECT TO authenticated, anon
  USING (public.is_admin() OR public.is_task_assignee(assignee_employee_id));

-- A linked staff member may also keep their OWN task list: insert a task
-- assigned to themselves, and edit or delete the tasks they created for
-- themselves. Tasks for anyone else, and tasks the owner assigned, stay
-- admin-only (the assignee closes those through set_manager_task_done).
CREATE OR REPLACE FUNCTION public.is_own_self_task(p_employee_id bigint, p_created_by text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $$
  SELECT p_created_by IS NOT NULL
     AND p_created_by = (auth.jwt() ->> 'sub')
     AND public.is_task_assignee(p_employee_id);
$$;

DROP POLICY IF EXISTS manager_tasks_insert ON public.manager_tasks;
CREATE POLICY manager_tasks_insert ON public.manager_tasks
  FOR INSERT TO authenticated, anon
  WITH CHECK (public.is_admin() OR public.is_own_self_task(assignee_employee_id, created_by));

DROP POLICY IF EXISTS manager_tasks_update ON public.manager_tasks;
CREATE POLICY manager_tasks_update ON public.manager_tasks
  FOR UPDATE TO authenticated, anon
  USING      (public.is_admin() OR public.is_own_self_task(assignee_employee_id, created_by))
  WITH CHECK (public.is_admin() OR public.is_own_self_task(assignee_employee_id, created_by));

DROP POLICY IF EXISTS manager_tasks_delete ON public.manager_tasks;
CREATE POLICY manager_tasks_delete ON public.manager_tasks
  FOR DELETE TO authenticated, anon
  USING (public.is_admin() OR public.is_own_self_task(assignee_employee_id, created_by));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.manager_tasks TO authenticated, anon;
GRANT ALL ON public.manager_tasks TO service_role;

-- The assignee (or an admin) marks a task done, or open again after a mis-tap.
-- Returns the updated row, or nothing when the caller may not touch it or the
-- task is already in that state.
CREATE OR REPLACE FUNCTION public.set_manager_task_done(p_id bigint, p_done boolean)
  RETURNS SETOF public.manager_tasks
  LANGUAGE sql SECURITY DEFINER
  SET search_path TO 'public'
AS $$
  UPDATE public.manager_tasks t
     SET status              = CASE WHEN p_done THEN 'done' ELSE 'open' END,
         done_at             = CASE WHEN p_done THEN now() END,
         done_via            = CASE WHEN p_done THEN 'app' END,
         creator_notified_at = CASE WHEN p_done THEN t.creator_notified_at END
   WHERE t.id = p_id
     AND t.status = CASE WHEN p_done THEN 'open' ELSE 'done' END
     AND (public.is_admin() OR public.is_task_assignee(t.assignee_employee_id))
  RETURNING t.*;
$$;

REVOKE ALL ON FUNCTION public.set_manager_task_done(bigint, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_manager_task_done(bigint, boolean) TO authenticated, anon, service_role;
REVOKE ALL ON FUNCTION public.is_task_assignee(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_task_assignee(bigint) TO authenticated, anon, service_role;
REVOKE ALL ON FUNCTION public.is_own_self_task(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_own_self_task(bigint, text) TO authenticated, anon, service_role;

-- ── Daily reminder cron ─────────────────────────────────────────────────────
-- 06:00 UTC = 08:00 Israel in winter, 09:00 in summer. employee-bot skips
-- Saturday and anything already reminded today, so a re-run is harmless.
-- Same auth as the other employee-bot crons (service key from Vault).
DO $cron$
BEGIN
  -- Only where the Vault cron key exists (prod): a local or dev database must
  -- not start calling the prod function.
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_service_role_key') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'manager-tasks-reminder-daily';
    PERFORM cron.schedule(
      'manager-tasks-reminder-daily',
      '0 6 * * *',
      $job$
      SELECT net.http_post(
        url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/employee-bot?action=task-reminders',
        headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
      $job$
    );
  END IF;
END
$cron$;
