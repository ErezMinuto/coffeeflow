-- Manager tasks: everyone can task everyone.
--
-- Before: only admins assigned tasks to other people; linked staff could only
-- add tasks for themselves. Now any active staff member with a linked
-- CoffeeFlow login (employees.clerk_user_id) can assign a task to anyone, and
-- sees, edits and deletes the tasks they created.
--
-- Rules after this migration:
--   read          → admins, the assignee, the creator
--   insert        → admins, or a linked active staff member as the creator
--                   (created_by must be their own login, so it can't be spoofed)
--   update/delete → admins, or the task's creator
--   mark done     → unchanged: the assignee or an admin (set_manager_task_done)
--
-- is_own_self_task() from 20261120120000 is no longer used by any policy; it
-- is left in place (harmless) rather than dropped.

-- True when the signed-in Clerk user is an active, linked employee.
CREATE OR REPLACE FUNCTION public.is_linked_staff() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employees
     WHERE clerk_user_id IS NOT NULL
       AND clerk_user_id = (auth.jwt() ->> 'sub')
       AND active IS NOT FALSE
  );
$$;

-- True when the signed-in user created the task and is linked, active staff.
CREATE OR REPLACE FUNCTION public.is_task_creator(p_created_by text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $$
  SELECT p_created_by IS NOT NULL
     AND p_created_by = (auth.jwt() ->> 'sub')
     AND public.is_linked_staff();
$$;

REVOKE ALL ON FUNCTION public.is_linked_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_linked_staff() TO authenticated, anon, service_role;
REVOKE ALL ON FUNCTION public.is_task_creator(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_task_creator(text) TO authenticated, anon, service_role;

DROP POLICY IF EXISTS manager_tasks_select ON public.manager_tasks;
CREATE POLICY manager_tasks_select ON public.manager_tasks
  FOR SELECT TO authenticated, anon
  USING (public.is_admin()
         OR public.is_task_assignee(assignee_employee_id)
         OR public.is_task_creator(created_by));

DROP POLICY IF EXISTS manager_tasks_insert ON public.manager_tasks;
CREATE POLICY manager_tasks_insert ON public.manager_tasks
  FOR INSERT TO authenticated, anon
  WITH CHECK (public.is_admin() OR public.is_task_creator(created_by));

DROP POLICY IF EXISTS manager_tasks_update ON public.manager_tasks;
CREATE POLICY manager_tasks_update ON public.manager_tasks
  FOR UPDATE TO authenticated, anon
  USING      (public.is_admin() OR public.is_task_creator(created_by))
  WITH CHECK (public.is_admin() OR public.is_task_creator(created_by));

DROP POLICY IF EXISTS manager_tasks_delete ON public.manager_tasks;
CREATE POLICY manager_tasks_delete ON public.manager_tasks
  FOR DELETE TO authenticated, anon
  USING (public.is_admin() OR public.is_task_creator(created_by));

-- ── Which columns signed-in users may write ─────────────────────────────────
-- With creators (not just admins) able to write rows, limit direct writes to
-- the task's content. Status / done_at / done_via change only through
-- set_manager_task_done (SECURITY DEFINER), and the bot bookkeeping columns
-- only through employee-bot (service_role, which keeps GRANT ALL).
REVOKE INSERT, UPDATE ON public.manager_tasks FROM authenticated, anon;
GRANT INSERT (title, notes, due_date, assignee_employee_id, created_by)
  ON public.manager_tasks TO authenticated, anon;
GRANT UPDATE (title, notes, due_date, assignee_employee_id)
  ON public.manager_tasks TO authenticated, anon;

-- Moving the due date makes the task "new" for the daily reminder again
-- (the page used to write last_reminded_on itself; it no longer can).
CREATE OR REPLACE FUNCTION public.manager_tasks_reset_reminder() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    NEW.last_reminded_on := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS manager_tasks_reset_reminder ON public.manager_tasks;
CREATE TRIGGER manager_tasks_reset_reminder
  BEFORE UPDATE OF due_date ON public.manager_tasks
  FOR EACH ROW EXECUTE FUNCTION public.manager_tasks_reset_reminder();
