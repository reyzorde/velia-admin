CREATE TABLE IF NOT EXISTS platform_announcements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT,
  body TEXT NOT NULL,
  target_center_id UUID REFERENCES centers(id) ON DELETE CASCADE,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id UUID NOT NULL REFERENCES platform_announcements(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

ALTER TABLE platform_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ann_admin_all ON platform_announcements;
CREATE POLICY ann_admin_all ON platform_announcements FOR ALL TO authenticated
  USING (is_platform_admin()) WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS ann_center_read ON platform_announcements;
CREATE POLICY ann_center_read ON platform_announcements FOR SELECT TO authenticated
  USING (
    active = true AND (
      target_center_id IS NULL OR is_center_member(target_center_id) OR is_platform_admin()
    )
  );

DROP POLICY IF EXISTS ann_reads_own ON announcement_reads;
CREATE POLICY ann_reads_own ON announcement_reads FOR ALL TO authenticated
  USING (user_id = auth.uid() OR is_platform_admin())
  WITH CHECK (user_id = auth.uid() OR is_platform_admin());

DROP POLICY IF EXISTS mock_admin_all ON mock_tests;
CREATE POLICY mock_admin_all ON mock_tests FOR ALL TO authenticated
  USING (is_platform_admin() OR (center_id IS NOT NULL AND is_center_member(center_id)))
  WITH CHECK (is_platform_admin() OR (center_id IS NOT NULL AND is_center_member(center_id)));

DROP POLICY IF EXISTS subs_admin_write ON subscriptions;
CREATE POLICY subs_admin_write ON subscriptions FOR ALL TO authenticated
  USING (is_platform_admin()) WITH CHECK (is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_announcements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON announcement_reads TO authenticated;

-- UPDATE profiles SET is_platform_admin = true WHERE email = 'admin@velia.uz';
