-- ============================================================
-- VELIA — RLS / 403 / xabarlar / parent / admin  (bir marta ishga tushiring)
-- Supabase → SQL Editor → Run
-- Eski tablelarni o'chirmaydi. Funksiyalar SECURITY DEFINER — rekursiya yo'q.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1) Helper functions (RLS ni aylanib o'tadi, xato qaytarmaydi)
DROP FUNCTION IF EXISTS public.is_platform_admin() CASCADE;
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN COALESCE(
    (SELECT p.is_platform_admin FROM public.profiles p WHERE p.id = auth.uid()),
    false
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

DROP FUNCTION IF EXISTS public.is_center_member(uuid) CASCADE;
CREATE OR REPLACE FUNCTION public.is_center_member(p_center_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_center_id IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.center_members
    WHERE center_id = p_center_id AND user_id = auth.uid()
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

DROP FUNCTION IF EXISTS public.center_role(uuid) CASCADE;
CREATE OR REPLACE FUNCTION public.center_role(p_center_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r text;
BEGIN
  SELECT role INTO r
  FROM public.center_members
  WHERE center_id = p_center_id AND user_id = auth.uid()
  LIMIT 1;
  RETURN r;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

DROP FUNCTION IF EXISTS public.is_parent_of(uuid) CASCADE;
CREATE OR REPLACE FUNCTION public.is_parent_of(p_student_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_student_id IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.parent_links
    WHERE student_id = p_student_id AND parent_user_id = auth.uid()
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_center_member(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.center_role(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_parent_of(uuid) TO authenticated, anon;

-- 2) Profiles: o'z qatorini o'qish/yozish + admin
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name TEXT DEFAULT '';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email TEXT DEFAULT '';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT 'uz';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'light';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;

DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='profiles'
  LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON profiles', r.policyname); END LOOP;
END $$;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_platform_admin());
CREATE POLICY profiles_insert ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid() OR public.is_platform_admin());
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.is_platform_admin())
  WITH CHECK (id = auth.uid() OR public.is_platform_admin());

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;

-- Auth user yaratilganda profil avtomatik
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(COALESCE(NEW.email, ''), '@', 1), 'User')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.ensure_own_profile(p_full_name text DEFAULT NULL, p_email text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    auth.uid(),
    COALESCE(p_email, ''),
    COALESCE(NULLIF(p_full_name, ''), 'User')
  )
  ON CONFLICT (id) DO UPDATE
    SET email = COALESCE(NULLIF(EXCLUDED.email, ''), profiles.email),
        full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), profiles.full_name);
END;
$$;
GRANT EXECUTE ON FUNCTION public.ensure_own_profile(text, text) TO authenticated;

INSERT INTO public.profiles (id, full_name, email)
SELECT u.id,
  COALESCE(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1), 'User'),
  COALESCE(u.email, '')
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
ON CONFLICT (id) DO NOTHING;

-- 3) group_students — center_id ustuni YO'Q; groups orqali
CREATE TABLE IF NOT EXISTS public.group_students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, student_id)
);

DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='group_students'
  LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON group_students', r.policyname); END LOOP;
END $$;

ALTER TABLE public.group_students ENABLE ROW LEVEL SECURITY;

CREATE POLICY group_students_all ON public.group_students FOR ALL TO authenticated
  USING (
    public.is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = group_students.group_id AND public.is_center_member(g.center_id)
    )
    OR public.is_parent_of(student_id)
  )
  WITH CHECK (
    public.is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = group_students.group_id AND public.is_center_member(g.center_id)
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.group_students TO authenticated;

-- 4) students — parent + email + markaz, rekursiyasiz
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='students'
  LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON students', r.policyname); END LOOP;
END $$;

ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

CREATE POLICY students_select ON public.students FOR SELECT TO authenticated
  USING (
    public.is_platform_admin()
    OR public.is_center_member(center_id)
    OR public.is_parent_of(id)
    OR (
      email IS NOT NULL
      AND length(email) > 3
      AND lower(email) = lower(COALESCE(auth.jwt() ->> 'email', ''))
    )
  );
CREATE POLICY students_write ON public.students FOR ALL TO authenticated
  USING (public.is_platform_admin() OR public.is_center_member(center_id))
  WITH CHECK (public.is_platform_admin() OR public.is_center_member(center_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.students TO authenticated;

-- 5) parent_links
CREATE TABLE IF NOT EXISTS public.parent_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parent_user_id, student_id)
);

DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='parent_links'
  LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON parent_links', r.policyname); END LOOP;
END $$;

ALTER TABLE public.parent_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY parent_links_own ON public.parent_links FOR ALL TO authenticated
  USING (parent_user_id = auth.uid() OR public.is_platform_admin())
  WITH CHECK (parent_user_id = auth.uid() OR public.is_platform_admin());

CREATE POLICY parent_links_center ON public.parent_links FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = parent_links.student_id AND public.is_center_member(s.center_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = parent_links.student_id AND public.is_center_member(s.center_id)
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.parent_links TO authenticated;

-- 6) student_messages — markaz yozadi, ota-ona o'qiydi
CREATE TABLE IF NOT EXISTS public.student_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id UUID NOT NULL REFERENCES public.centers(id) ON DELETE CASCADE,
  student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
  group_id UUID REFERENCES public.groups(id) ON DELETE SET NULL,
  recipient_name TEXT NOT NULL DEFAULT '',
  recipient_phone TEXT,
  recipient_email TEXT,
  channel TEXT NOT NULL DEFAULT 'in_app',
  message_type TEXT NOT NULL DEFAULT 'general',
  title TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  sent_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.student_messages DROP CONSTRAINT IF EXISTS student_messages_channel_check;
ALTER TABLE public.student_messages DROP CONSTRAINT IF EXISTS student_messages_message_type_check;

DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='student_messages'
  LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON student_messages', r.policyname); END LOOP;
END $$;

ALTER TABLE public.student_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY msg_select ON public.student_messages FOR SELECT TO authenticated
  USING (
    public.is_platform_admin()
    OR public.is_center_member(center_id)
    OR public.is_parent_of(student_id)
    OR (
      student_id IS NULL
      AND EXISTS (
        SELECT 1 FROM public.parent_links pl
        JOIN public.students s ON s.id = pl.student_id
        WHERE pl.parent_user_id = auth.uid() AND s.center_id = student_messages.center_id
      )
    )
    OR EXISTS (
      SELECT 1 FROM public.students s
      WHERE lower(COALESCE(s.email, '')) = lower(COALESCE(auth.jwt() ->> 'email', ''))
        AND s.email IS NOT NULL
        AND (
          s.id = student_messages.student_id
          OR (student_messages.student_id IS NULL AND s.center_id = student_messages.center_id)
        )
    )
  );

CREATE POLICY msg_write ON public.student_messages FOR ALL TO authenticated
  USING (public.is_platform_admin() OR public.is_center_member(center_id))
  WITH CHECK (public.is_platform_admin() OR public.is_center_member(center_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.student_messages TO authenticated;

-- 7) attendance / payments ota-ona o'qishi
DO $$ BEGIN
  IF to_regclass('public.attendance') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS attendance_select ON attendance';
    EXECUTE 'DROP POLICY IF EXISTS attendance_access ON attendance';
    EXECUTE 'DROP POLICY IF EXISTS attendance_write ON attendance';
    EXECUTE $p$
      CREATE POLICY attendance_select ON attendance FOR SELECT TO authenticated
      USING (
        public.is_platform_admin()
        OR public.is_parent_of(student_id)
        OR EXISTS (SELECT 1 FROM groups g WHERE g.id = attendance.group_id AND public.is_center_member(g.center_id))
      )
    $p$;
    EXECUTE $p$
      CREATE POLICY attendance_write ON attendance FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM groups g WHERE g.id = attendance.group_id AND public.is_center_member(g.center_id)))
      WITH CHECK (EXISTS (SELECT 1 FROM groups g WHERE g.id = attendance.group_id AND public.is_center_member(g.center_id)))
    $p$;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.student_payments') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS payments_access ON student_payments';
    EXECUTE 'DROP POLICY IF EXISTS payments_write ON student_payments';
    EXECUTE $p$
      CREATE POLICY payments_access ON student_payments FOR SELECT TO authenticated
      USING (public.is_platform_admin() OR public.is_center_member(center_id) OR public.is_parent_of(student_id))
    $p$;
    EXECUTE $p$
      CREATE POLICY payments_write ON student_payments FOR ALL TO authenticated
      USING (public.is_platform_admin() OR public.is_center_member(center_id))
      WITH CHECK (public.is_platform_admin() OR public.is_center_member(center_id))
    $p$;
  END IF;
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS pay_select ON payments';
    EXECUTE $p$
      CREATE POLICY pay_select ON payments FOR SELECT TO authenticated
      USING (
        public.is_platform_admin()
        OR public.is_parent_of(student_id)
        OR EXISTS (SELECT 1 FROM students s WHERE s.id = payments.student_id AND public.is_center_member(s.center_id))
      )
    $p$;
  END IF;
END $$;

-- 8) center_members / centers / subscriptions
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='center_members'
  LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON center_members', r.policyname); END LOOP;
END $$;

ALTER TABLE public.center_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY cm_select ON public.center_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_platform_admin() OR public.is_center_member(center_id));
CREATE POLICY cm_write ON public.center_members FOR ALL TO authenticated
  USING (
    public.is_platform_admin()
    OR public.center_role(center_id) IN ('owner', 'admin', 'administrator')
  )
  WITH CHECK (
    public.is_platform_admin()
    OR public.center_role(center_id) IN ('owner', 'admin', 'administrator')
    OR (user_id = auth.uid() AND public.center_role(center_id) IS NULL)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.center_members TO authenticated;

-- 9) Real table bo'lsa center_subscriptions RLS; view bo'lsa o'tkazib yubor
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'center_subscriptions' AND c.relkind = 'r'
  ) THEN
    EXECUTE 'ALTER TABLE public.center_subscriptions ENABLE ROW LEVEL SECURITY';
    PERFORM 1 FROM pg_policies WHERE tablename = 'center_subscriptions' AND policyname = 'cs_select';
    -- recreate
    EXECUTE 'DROP POLICY IF EXISTS cs_select ON center_subscriptions';
    EXECUTE 'DROP POLICY IF EXISTS cs_write ON center_subscriptions';
    EXECUTE $p$
      CREATE POLICY cs_select ON center_subscriptions FOR SELECT TO authenticated
      USING (public.is_platform_admin() OR public.is_center_member(center_id))
    $p$;
    EXECUTE $p$
      CREATE POLICY cs_write ON center_subscriptions FOR ALL TO authenticated
      USING (public.is_platform_admin() OR public.is_center_member(center_id))
      WITH CHECK (public.is_platform_admin() OR public.is_center_member(center_id))
    $p$;
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.center_subscriptions TO authenticated';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
