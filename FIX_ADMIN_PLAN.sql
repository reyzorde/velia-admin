-- ============================================================
-- FIX_ADMIN_PLAN.sql — tarif yangilash + admin yaratish
-- Supabase SQL Editor da bir marta ishga tushiring
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id UUID NOT NULL UNIQUE REFERENCES public.centers(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL DEFAULT 'start',
  status TEXT NOT NULL DEFAULT 'active',
  billing_period TEXT DEFAULT 'monthly',
  student_limit_override INT,
  started_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subs_admin_all ON public.subscriptions;
CREATE POLICY subs_admin_all ON public.subscriptions FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

DROP POLICY IF EXISTS subs_member_read ON public.subscriptions;
CREATE POLICY subs_member_read ON public.subscriptions FOR SELECT TO authenticated
  USING (
    public.is_platform_admin()
    OR public.is_center_member(center_id)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_center_plan(
  p_center_id UUID,
  p_plan TEXT,
  p_student_limit INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'faqat platform admin';
  END IF;

  INSERT INTO public.subscriptions (center_id, plan_id, status, billing_period, student_limit_override, updated_at)
  VALUES (p_center_id, p_plan, 'active', 'monthly', p_student_limit, now())
  ON CONFLICT (center_id) DO UPDATE SET
    plan_id = EXCLUDED.plan_id,
    student_limit_override = EXCLUDED.student_limit_override,
    status = 'active',
    updated_at = now();

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'center_subscriptions' AND c.relkind = 'r'
  ) THEN
    EXECUTE $q$
      INSERT INTO public.center_subscriptions (center_id, plan, student_limit, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (center_id) DO UPDATE SET
        plan = EXCLUDED.plan,
        student_limit = EXCLUDED.student_limit,
        updated_at = now()
    $q$ USING p_center_id, p_plan, p_student_limit;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_center_plan(UUID, TEXT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.ensure_own_profile(p_full_name TEXT, p_email TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  INSERT INTO public.profiles (id, full_name, email)
  VALUES (
    auth.uid(),
    COALESCE(NULLIF(p_full_name, ''), split_part(COALESCE(p_email, ''), '@', 1), 'User'),
    COALESCE(p_email, '')
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), profiles.full_name),
    email = COALESCE(NULLIF(EXCLUDED.email, ''), profiles.email),
    updated_at = now();
END;
$$;
GRANT EXECUTE ON FUNCTION public.ensure_own_profile(TEXT, TEXT) TO authenticated;

-- UPDATE public.profiles SET is_platform_admin = true WHERE email = 'admin@velia.uz';
