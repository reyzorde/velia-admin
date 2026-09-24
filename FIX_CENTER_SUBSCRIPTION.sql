-- ============================================================
-- FIX_CENTER_SUBSCRIPTION.sql
-- Subscription history + atomic plan change + owner notification
-- Safe / idempotent. Does NOT drop tables or delete data.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.subscription_plan_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id UUID NOT NULL REFERENCES public.centers(id) ON DELETE CASCADE,
  old_plan TEXT,
  new_plan TEXT NOT NULL,
  old_billing_period TEXT,
  new_billing_period TEXT,
  old_started_at TIMESTAMPTZ,
  new_started_at TIMESTAMPTZ,
  old_expires_at TIMESTAMPTZ,
  new_expires_at TIMESTAMPTZ,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_sub_plan_history_center
  ON public.subscription_plan_history (center_id, changed_at DESC);

ALTER TABLE public.subscription_plan_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sub_hist_admin ON public.subscription_plan_history;
CREATE POLICY sub_hist_admin ON public.subscription_plan_history
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin()
    OR public.is_center_member(center_id)
  );

DROP POLICY IF EXISTS sub_hist_admin_write ON public.subscription_plan_history;
CREATE POLICY sub_hist_admin_write ON public.subscription_plan_history
  FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin());

GRANT SELECT, INSERT ON public.subscription_plan_history TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'notifications'
  ) THEN
    EXECUTE 'ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY';
    DROP POLICY IF EXISTS notifications_admin_insert ON public.notifications;
    CREATE POLICY notifications_admin_insert ON public.notifications
      FOR INSERT TO authenticated
      WITH CHECK (
        public.is_platform_admin()
        OR sender_user_id = auth.uid()
      );
    DROP POLICY IF EXISTS notifications_recipient_read ON public.notifications;
    CREATE POLICY notifications_recipient_read ON public.notifications
      FOR SELECT TO authenticated
      USING (
        public.is_platform_admin()
        OR recipient_user_id = auth.uid()
        OR (center_id IS NOT NULL AND public.is_center_member(center_id))
      );
    GRANT SELECT, INSERT ON public.notifications TO authenticated;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.admin_change_center_subscription(
  p_center_id UUID,
  p_plan TEXT,
  p_billing_period TEXT DEFAULT 'monthly',
  p_student_limit INT DEFAULT NULL,
  p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old RECORD;
  v_new_started TIMESTAMPTZ := now();
  v_new_expires TIMESTAMPTZ;
  v_limit INT;
  v_owner UUID;
  v_center_name TEXT;
  v_changed BOOLEAN := false;
  v_title TEXT;
  v_body TEXT;
  v_period TEXT;
  v_hist_id UUID;
  v_notif_id UUID;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'faqat platform admin';
  END IF;

  IF p_plan IS NULL OR length(trim(p_plan)) = 0 THEN
    RAISE EXCEPTION 'plan required';
  END IF;

  v_period := lower(COALESCE(NULLIF(trim(p_billing_period), ''), 'monthly'));
  IF v_period NOT IN ('monthly', 'yearly') THEN
    v_period := 'monthly';
  END IF;

  v_limit := COALESCE(
    p_student_limit,
    CASE lower(p_plan)
      WHEN 'start' THEN 20
      WHEN 'silver' THEN 100
      WHEN 'gold' THEN 1000
      WHEN 'platinum' THEN 999999
      ELSE 20
    END
  );

  IF v_period = 'yearly' THEN
    v_new_expires := v_new_started + INTERVAL '1 year';
  ELSE
    v_new_expires := v_new_started + INTERVAL '1 month';
  END IF;

  SELECT * INTO v_old
  FROM public.subscriptions
  WHERE center_id = p_center_id
  FOR UPDATE;

  IF v_old.id IS NULL THEN
    INSERT INTO public.subscriptions (
      center_id, plan_id, status, billing_period,
      student_limit_override, started_at, expires_at, updated_at
    ) VALUES (
      p_center_id, p_plan, 'active', v_period,
      v_limit, v_new_started, v_new_expires, now()
    );
    v_changed := true;
  ELSE
    IF COALESCE(v_old.plan_id, '') IS DISTINCT FROM p_plan
       OR COALESCE(v_old.billing_period, '') IS DISTINCT FROM v_period THEN
      v_changed := true;
    END IF;

    UPDATE public.subscriptions SET
      plan_id = p_plan,
      billing_period = v_period,
      status = 'active',
      student_limit_override = v_limit,
      started_at = CASE WHEN v_changed THEN v_new_started ELSE started_at END,
      expires_at = CASE WHEN v_changed THEN v_new_expires ELSE expires_at END,
      updated_at = now()
    WHERE center_id = p_center_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'center_subscriptions' AND c.relkind = 'r'
  ) THEN
    EXECUTE $q$
      INSERT INTO public.center_subscriptions (center_id, plan, student_limit, expires_at, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (center_id) DO UPDATE SET
        plan = EXCLUDED.plan,
        student_limit = EXCLUDED.student_limit,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    $q$ USING p_center_id, p_plan, v_limit, v_new_expires;
  END IF;

  IF NOT v_changed THEN
    RETURN jsonb_build_object(
      'changed', false,
      'plan', p_plan,
      'billing_period', v_period
    );
  END IF;

  INSERT INTO public.subscription_plan_history (
    center_id, old_plan, new_plan,
    old_billing_period, new_billing_period,
    old_started_at, new_started_at,
    old_expires_at, new_expires_at,
    changed_by, note
  ) VALUES (
    p_center_id,
    v_old.plan_id,
    p_plan,
    v_old.billing_period,
    v_period,
    v_old.started_at,
    v_new_started,
    v_old.expires_at,
    v_new_expires,
    auth.uid(),
    p_note
  )
  RETURNING id INTO v_hist_id;

  SELECT owner_id, name INTO v_owner, v_center_name
  FROM public.centers WHERE id = p_center_id;

  IF v_owner IS NOT NULL THEN
    v_title := 'Tarif yangilandi';
    v_body := format(
      E'%s markazingiz tarifi\n%s%s → %s%s\nholatiga o''zgartirildi.\nBoshlangan sana: %s\nTugash sanasi: %s',
      COALESCE(v_center_name, 'Markaz'),
      COALESCE(v_old.plan_id, '—'),
      CASE WHEN v_old.billing_period IS NOT NULL THEN ' (' || v_old.billing_period || ')' ELSE '' END,
      p_plan,
      ' (' || v_period || ')',
      to_char(v_new_started AT TIME ZONE 'UTC', 'DD.MM.YYYY'),
      to_char(v_new_expires AT TIME ZONE 'UTC', 'DD.MM.YYYY')
    );

    INSERT INTO public.notifications (
      center_id, recipient_user_id, sender_user_id,
      type, title, body, metadata
    ) VALUES (
      p_center_id,
      v_owner,
      auth.uid(),
      'subscription',
      v_title,
      v_body,
      jsonb_build_object(
        'center_id', p_center_id,
        'center_name', v_center_name,
        'old_plan', v_old.plan_id,
        'new_plan', p_plan,
        'old_billing_period', v_old.billing_period,
        'new_billing_period', v_period,
        'started_at', v_new_started,
        'expires_at', v_new_expires,
        'history_id', v_hist_id
      )
    )
    RETURNING id INTO v_notif_id;
  END IF;

  RETURN jsonb_build_object(
    'changed', true,
    'history_id', v_hist_id,
    'notification_id', v_notif_id,
    'plan', p_plan,
    'billing_period', v_period,
    'started_at', v_new_started,
    'expires_at', v_new_expires
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_change_center_subscription(UUID, TEXT, TEXT, INT, TEXT) TO authenticated;

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
  PERFORM public.admin_change_center_subscription(
    p_center_id, p_plan, 'monthly', p_student_limit, NULL
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_center_plan(UUID, TEXT, INT) TO authenticated;
