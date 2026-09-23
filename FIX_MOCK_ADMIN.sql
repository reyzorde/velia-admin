-- ============================================================
-- FIX_MOCK_ADMIN.sql
-- Root cause:
--   mock_q_write only allowed is_center_member(t.center_id)
--     → platform admin / center_id IS NULL denied → 403 on mock_questions
--   mock_test_sections RLS incomplete → INSERT RETURNING failed → 400
-- RLS stays ENABLED. No service_role on frontend.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT is_platform_admin FROM public.profiles WHERE id = auth.uid()),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.is_center_member(p_center_id UUID)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    public.is_platform_admin()
    OR (
      p_center_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.center_members
        WHERE center_id = p_center_id
          AND user_id = auth.uid()
          AND COALESCE(is_active, true) = true
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_mock_test(p_test_id UUID)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.mock_tests t
    WHERE t.id = p_test_id
      AND (
        public.is_platform_admin()
        OR t.created_by = auth.uid()
        OR (t.center_id IS NOT NULL AND public.is_center_member(t.center_id))
      )
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_center_member(UUID) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_mock_test(UUID) TO authenticated;

ALTER TABLE public.mock_questions ADD COLUMN IF NOT EXISTS image_path TEXT;
ALTER TABLE public.mock_questions ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE public.mock_tests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mock_tests_access ON public.mock_tests;
DROP POLICY IF EXISTS mock_tests_write ON public.mock_tests;
DROP POLICY IF EXISTS mock_tests_admin_all ON public.mock_tests;
DROP POLICY IF EXISTS mock_tests_center_write ON public.mock_tests;
DROP POLICY IF EXISTS mock_tests_public_read ON public.mock_tests;
DROP POLICY IF EXISTS mock_tests_select ON public.mock_tests;

CREATE POLICY mock_tests_select ON public.mock_tests
  FOR SELECT TO authenticated, anon
  USING (
    is_published = true
    OR public.is_platform_admin()
    OR created_by = auth.uid()
    OR (center_id IS NOT NULL AND public.is_center_member(center_id))
  );

CREATE POLICY mock_tests_write ON public.mock_tests
  FOR ALL TO authenticated
  USING (
    public.is_platform_admin()
    OR created_by = auth.uid()
    OR (center_id IS NOT NULL AND public.is_center_member(center_id))
  )
  WITH CHECK (
    public.is_platform_admin()
    OR (center_id IS NOT NULL AND public.is_center_member(center_id))
  );

ALTER TABLE public.mock_test_sections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mock_sec_select ON public.mock_test_sections;
DROP POLICY IF EXISTS mock_sec_write ON public.mock_test_sections;
DROP POLICY IF EXISTS mock_sections_admin ON public.mock_test_sections;
DROP POLICY IF EXISTS "mock_test_sections_all" ON public.mock_test_sections;

CREATE POLICY mock_sec_select ON public.mock_test_sections
  FOR SELECT TO authenticated, anon
  USING (
    public.is_platform_admin()
    OR public.can_manage_mock_test(test_id)
    OR EXISTS (
      SELECT 1 FROM public.mock_tests t
      WHERE t.id = mock_test_sections.test_id AND t.is_published = true
    )
  );

CREATE POLICY mock_sec_write ON public.mock_test_sections
  FOR ALL TO authenticated
  USING (public.can_manage_mock_test(test_id))
  WITH CHECK (public.can_manage_mock_test(test_id));

ALTER TABLE public.mock_questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mock_q_access ON public.mock_questions;
DROP POLICY IF EXISTS mock_q_write ON public.mock_questions;
DROP POLICY IF EXISTS mock_q_select ON public.mock_questions;
DROP POLICY IF EXISTS mock_questions_admin ON public.mock_questions;

CREATE POLICY mock_q_select ON public.mock_questions
  FOR SELECT TO authenticated, anon
  USING (
    public.is_platform_admin()
    OR public.can_manage_mock_test(test_id)
    OR EXISTS (
      SELECT 1 FROM public.mock_tests t
      WHERE t.id = mock_questions.test_id AND t.is_published = true
    )
  );

CREATE POLICY mock_q_write ON public.mock_questions
  FOR ALL TO authenticated
  USING (public.can_manage_mock_test(test_id))
  WITH CHECK (public.can_manage_mock_test(test_id));

ALTER TABLE public.mock_question_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mock_opt_access ON public.mock_question_options;
DROP POLICY IF EXISTS mock_opt_write ON public.mock_question_options;
DROP POLICY IF EXISTS mock_opt_select ON public.mock_question_options;
DROP POLICY IF EXISTS mock_options_admin ON public.mock_question_options;

CREATE POLICY mock_opt_select ON public.mock_question_options
  FOR SELECT TO authenticated, anon
  USING (
    public.is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM public.mock_questions q
      WHERE q.id = mock_question_options.question_id
        AND (
          public.can_manage_mock_test(q.test_id)
          OR EXISTS (
            SELECT 1 FROM public.mock_tests t
            WHERE t.id = q.test_id AND t.is_published = true
          )
        )
    )
  );

CREATE POLICY mock_opt_write ON public.mock_question_options
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.mock_questions q
      WHERE q.id = mock_question_options.question_id
        AND public.can_manage_mock_test(q.test_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.mock_questions q
      WHERE q.id = mock_question_options.question_id
        AND public.can_manage_mock_test(q.test_id)
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mock_tests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mock_test_sections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mock_questions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mock_question_options TO authenticated;
GRANT SELECT ON public.mock_tests TO anon;
GRANT SELECT ON public.mock_test_sections TO anon;
GRANT SELECT ON public.mock_questions TO anon;
GRANT SELECT ON public.mock_question_options TO anon;
