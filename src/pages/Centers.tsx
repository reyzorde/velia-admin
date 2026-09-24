import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Search, ArrowLeft, Clock, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

type BillingPeriod = 'monthly' | 'yearly';
type SubRow = {
  id?: string; plan_id?: string; plan?: string; status?: string; billing_period?: string;
  started_at?: string | null; expires_at?: string | null; student_limit_override?: number | null;
};
type CenterListRow = {
  id: string; name: string; owner_id: string; created_at: string;
  owner?: { full_name?: string | null; email?: string | null } | null;
  subscriptions?: SubRow | SubRow[] | null;
  center_subscriptions?: SubRow | SubRow[] | null;
  students?: Array<{ count: number }> | { count: number } | null;
};

const PLAN_LIMITS: Record<string, number> = { start: 20, silver: 100, gold: 1000, platinum: 999999 };

function firstRel<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}
function subOf(row: CenterListRow): SubRow | null {
  return firstRel(row.subscriptions) || firstRel(row.center_subscriptions);
}
function planOf(s: SubRow | null | undefined): string {
  if (!s) return '—';
  return (s.plan_id || s.plan || '—').toString();
}
function billingOf(s: SubRow | null | undefined): BillingPeriod | '—' {
  const b = (s?.billing_period || '').toLowerCase();
  if (b === 'yearly') return 'yearly';
  if (b === 'monthly') return 'monthly';
  return '—';
}
function studentCount(row: CenterListRow): number {
  const s = row.students;
  if (!s) return 0;
  if (Array.isArray(s)) return Number(s[0]?.count ?? 0);
  return Number((s as { count: number }).count ?? 0);
}
function fmtDate(iso?: string | null): string {
  if (!iso) return 'Unavailable';
  try { return new Date(iso).toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  catch { return 'Unavailable'; }
}
function fmtDateLong(iso?: string | null): string {
  if (!iso) return 'Unavailable';
  try { return new Date(iso).toLocaleDateString('uz-UZ', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return 'Unavailable'; }
}
function subStatus(s: SubRow | null | undefined, now = Date.now()): 'active' | 'expired' | 'expiring' | 'none' {
  if (!s || (!s.plan_id && !s.plan)) return 'none';
  const exp = s.expires_at ? new Date(s.expires_at).getTime() : null;
  if (exp != null && exp < now) return 'expired';
  if (exp != null && exp - now < 7 * 24 * 60 * 60 * 1000) return 'expiring';
  return 'active';
}
function useCountdown(expiresAt?: string | null) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return useMemo(() => {
    void tick;
    if (!expiresAt) return { label: 'Unavailable', expired: false };
    const end = new Date(expiresAt).getTime();
    const now = Date.now();
    if (Number.isNaN(end)) return { label: 'Unavailable', expired: false };
    if (end <= now) return { label: 'Expired', expired: true };
    const ms = end - now;
    const days = Math.floor(ms / 86_400_000);
    const hours = Math.floor((ms % 86_400_000) / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    return { label: `${days} kun ${hours} soat ${mins} daqiqa`, expired: false };
  }, [expiresAt, tick]);
}
function useAdminLite() {
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      if (u) setUser({ id: u.id, email: u.email });
    });
  }, []);
  return { user };
}

export function Centers() {
  const { user } = useAdminLite();
  const [rows, setRows] = useState<CenterListRow[]>([]);
  const [plans, setPlans] = useState<Array<{ id: string; name_uz: string }>>([]);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'start' | 'silver' | 'gold' | 'platinum' | 'monthly' | 'yearly' | 'active' | 'expired' | 'expiring'>('all');
  const [sort, setSort] = useState<'name' | 'created' | 'plan' | 'started' | 'expires' | 'students'>('created');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [{ data, error: cErr }, { data: p }] = await Promise.all([
        supabase.from('centers').select(
          `id, name, owner_id, created_at,
           owner:profiles!centers_owner_id_fkey(full_name, email),
           subscriptions(id, plan_id, status, billing_period, started_at, expires_at, student_limit_override, updated_at),
           students(count)`
        ).order('created_at', { ascending: false }),
        supabase.from('plans').select('id, name_uz').order('sort_order'),
      ]);
      if (cErr) {
        const { data: d2, error: e2 } = await supabase.from('centers').select(
          `id, name, owner_id, created_at, center_subscriptions(id, plan, student_limit, expires_at, updated_at)`
        ).order('created_at', { ascending: false });
        if (e2) throw e2;
        const list = (d2 || []) as CenterListRow[];
        const ownerIds = [...new Set(list.map((r) => r.owner_id).filter(Boolean))];
        const centerIds = list.map((r) => r.id);
        const [{ data: owners }, { data: subs }, { data: stu }] = await Promise.all([
          ownerIds.length ? supabase.from('profiles').select('id, full_name, email').in('id', ownerIds) : Promise.resolve({ data: [] as Array<{ id: string; full_name: string | null; email: string | null }> }),
          centerIds.length ? supabase.from('subscriptions').select('id, center_id, plan_id, status, billing_period, started_at, expires_at, student_limit_override, updated_at').in('center_id', centerIds) : Promise.resolve({ data: [] as Array<SubRow & { center_id: string }> }),
          centerIds.length ? supabase.from('students').select('center_id').in('center_id', centerIds) : Promise.resolve({ data: [] as Array<{ center_id: string }> }),
        ]);
        const ownerMap = new Map((owners || []).map((o) => [o.id, o]));
        const subMap = new Map((subs || []).map((s) => [s.center_id, s]));
        const countMap = new Map<string, number>();
        for (const s of stu || []) countMap.set(s.center_id, (countMap.get(s.center_id) || 0) + 1);
        setRows(list.map((r) => ({
          ...r,
          owner: ownerMap.get(r.owner_id) || null,
          subscriptions: subMap.get(r.id) || firstRel(r.center_subscriptions),
          students: [{ count: countMap.get(r.id) || 0 }],
        })));
      } else {
        setRows((data || []) as CenterListRow[]);
      }
      setPlans(p || []);
    } catch (err: unknown) {
      const m = err && typeof err === 'object' && 'message' in err ? String((err as { message: string }).message) : 'Unable to load centers';
      setError(m); setRows([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const changePlan = async (centerId: string, planId: string, billing: BillingPeriod = 'monthly') => {
    if (!user?.id) return;
    setMsg('');
    const studentLimit = PLAN_LIMITS[planId] ?? 20;
    const { data, error } = await supabase.rpc('admin_change_center_subscription', {
      p_center_id: centerId, p_plan: planId, p_billing_period: billing, p_student_limit: studentLimit, p_note: null,
    });
    if (!error) {
      const changed = (data as { changed?: boolean } | null)?.changed;
      setMsg(changed === false ? 'Tarif o‘zgarishsiz' : 'Tarif yangilandi · history + notification');
      await load(); return;
    }
    const { error: rpcErr } = await supabase.rpc('admin_set_center_plan', { p_center_id: centerId, p_plan: planId, p_student_limit: studentLimit });
    if (!rpcErr) {
      setMsg('Tarif yangilandi (legacy). FIX_CENTER_SUBSCRIPTION.sql ni ishga tushiring.');
      await load(); return;
    }
    setMsg((error?.message || rpcErr?.message || 'Xato') + ' — FIX_CENTER_SUBSCRIPTION.sql');
  };

  const filtered = useMemo(() => {
    const now = Date.now();
    const qq = q.trim().toLowerCase();
    let list = rows.filter((r) => {
      const s = subOf(r);
      const owner = firstRel(r.owner);
      if (qq) {
        const hay = [r.name, owner?.full_name, owner?.email, r.id, planOf(s)].join(' ').toLowerCase();
        if (!hay.includes(qq)) return false;
      }
      const st = subStatus(s, now);
      const plan = planOf(s).toLowerCase();
      const bill = billingOf(s);
      if (filter === 'start' || filter === 'silver' || filter === 'gold' || filter === 'platinum') { if (plan !== filter) return false; }
      else if (filter === 'monthly' || filter === 'yearly') { if (bill !== filter) return false; }
      else if (filter === 'active') { if (st !== 'active' && st !== 'expiring') return false; }
      else if (filter === 'expired') { if (st !== 'expired') return false; }
      else if (filter === 'expiring') { if (st !== 'expiring') return false; }
      return true;
    });
    list = [...list].sort((a, b) => {
      const sa = subOf(a); const sb = subOf(b);
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'plan') return planOf(sa).localeCompare(planOf(sb));
      if (sort === 'started') return (sa?.started_at || '').localeCompare(sb?.started_at || '');
      if (sort === 'expires') return (sa?.expires_at || '').localeCompare(sb?.expires_at || '');
      if (sort === 'students') return studentCount(b) - studentCount(a);
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    return list;
  }, [rows, q, filter, sort]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Markazlar</h1>
          <p className="muted">Barcha markazlar · real Supabase maʼlumotlari</p>
        </div>
        <button type="button" className="btn secondary" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="spin" size={16} /> : null} Yangilash
        </button>
      </div>
      <div className="toolbar card">
        <div className="search-wrap">
          <Search size={16} className="search-ico" />
          <input className="input" placeholder="Qidirish: nom, owner, email, ID…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input" style={{ maxWidth: 160 }} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All</option>
          <option value="start">Start (Free)</option>
          <option value="silver">Silver</option>
          <option value="gold">Gold</option>
          <option value="platinum">Platinum</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="expiring">Expiring soon</option>
        </select>
        <select className="input" style={{ maxWidth: 160 }} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="created">Created date</option>
          <option value="name">Name</option>
          <option value="plan">Plan</option>
          <option value="started">Started date</option>
          <option value="expires">Expiry date</option>
          <option value="students">Students count</option>
        </select>
      </div>
      {msg && <p className="muted">{msg}</p>}
      {error && <p className="err">Unable to load center data — {error}</p>}
      {loading && <div className="card skeleton-block"><div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line" /></div>}
      {!loading && filtered.length === 0 && (
        <div className="card empty-box"><h3>Markazlar topilmadi</h3><p className="muted">Qidiruv yoki filter boʻyicha natija yoʻq.</p></div>
      )}
      {!loading && filtered.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Nomi</th><th>Owner</th><th>Tarif</th><th>Billing</th><th>Status</th><th>Students</th><th>Expires</th><th>Tarif</th><th></th></tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const s = subOf(r);
                const owner = firstRel(r.owner);
                const st = subStatus(s);
                return (
                  <tr key={r.id}>
                    <td>
                      <Link className="link-strong" to={`/centers/${r.id}`}>{r.name}</Link>
                      <div className="muted" style={{ fontSize: 12 }}>{r.id.slice(0, 8)}…</div>
                    </td>
                    <td>
                      <div>{owner?.full_name || 'Unavailable'}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{owner?.email || '—'}</div>
                    </td>
                    <td><code>{planOf(s)}</code></td>
                    <td>{billingOf(s)}</td>
                    <td><span className={`badge badge-${st}`}>{st === 'none' ? '—' : st}</span></td>
                    <td>{studentCount(r)}</td>
                    <td>{fmtDate(s?.expires_at)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <select className="input" style={{ maxWidth: 120 }} defaultValue={planOf(s) === '—' ? '' : planOf(s)}
                          onChange={(e) => { if (e.target.value) void changePlan(r.id, e.target.value, billingOf(s) === 'yearly' ? 'yearly' : 'monthly'); }}>
                          <option value="" disabled>Plan</option>
                          {plans.map((p) => <option key={p.id} value={p.id}>{p.name_uz || p.id}</option>)}
                        </select>
                        <select className="input" style={{ maxWidth: 110 }} defaultValue={billingOf(s) === '—' ? 'monthly' : billingOf(s)}
                          onChange={(e) => { void changePlan(r.id, planOf(s) === '—' ? 'start' : planOf(s), e.target.value as BillingPeriod); }}>
                          <option value="monthly">Monthly</option>
                          <option value="yearly">Yearly</option>
                        </select>
                      </div>
                    </td>
                    <td>
                      <Link className="btn secondary" to={`/centers/${r.id}`} style={{ textDecoration: 'none' }}>Detail</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function CenterDetail() {
  const { centerId } = useParams<{ centerId: string }>();
  const { user } = useAdminLite();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [center, setCenter] = useState<{ id: string; name: string; owner_id: string; created_at: string } | null>(null);
  const [owner, setOwner] = useState<{ full_name?: string | null; email?: string | null } | null>(null);
  const [sub, setSub] = useState<SubRow | null>(null);
  const [history, setHistory] = useState<Array<{
    id: string; old_plan: string | null; new_plan: string; old_billing_period: string | null; new_billing_period: string | null;
    old_expires_at: string | null; new_expires_at: string | null; changed_at: string; changed_by: string | null; note: string | null;
  }>>([]);
  const [stats, setStats] = useState({ totalStudents: 0, activeStudents: 0, inactiveStudents: 0, groups: 0, courses: 0, teachers: 0 });
  const [plans, setPlans] = useState<Array<{ id: string; name_uz: string }>>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [planSel, setPlanSel] = useState('start');
  const [billSel, setBillSel] = useState<BillingPeriod>('monthly');
  const countdown = useCountdown(sub?.expires_at);

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError('');
    try {
      const { data: c, error: cErr } = await supabase.from('centers').select('id, name, owner_id, created_at').eq('id', centerId).maybeSingle();
      if (cErr) throw cErr;
      if (!c) { setCenter(null); setError('Center not found'); return; }
      setCenter(c);
      const [
        { data: own }, { data: subData }, { data: hist }, { data: students },
        { data: groups }, { data: courses }, { data: members }, { data: planList },
      ] = await Promise.all([
        supabase.from('profiles').select('full_name, email').eq('id', c.owner_id).maybeSingle(),
        supabase.from('subscriptions').select('id, plan_id, status, billing_period, started_at, expires_at, student_limit_override, updated_at').eq('center_id', centerId).maybeSingle(),
        supabase.from('subscription_plan_history').select('id, old_plan, new_plan, old_billing_period, new_billing_period, old_expires_at, new_expires_at, changed_at, changed_by, note').eq('center_id', centerId).order('changed_at', { ascending: false }).limit(50),
        supabase.from('students').select('id, status').eq('center_id', centerId),
        supabase.from('groups').select('id').eq('center_id', centerId),
        supabase.from('courses').select('id').eq('center_id', centerId),
        supabase.from('center_members').select('id, role').eq('center_id', centerId),
        supabase.from('plans').select('id, name_uz').order('sort_order'),
      ]);
      setOwner(own || null);
      setSub(subData || null);
      setHistory(hist || []);
      setPlans(planList || []);
      if (subData?.plan_id) setPlanSel(subData.plan_id);
      if (subData?.billing_period === 'yearly' || subData?.billing_period === 'monthly') setBillSel(subData.billing_period);
      const stu = students || [];
      const active = stu.filter((s) => (s.status || 'active') === 'active').length;
      setStats({
        totalStudents: stu.length, activeStudents: active, inactiveStudents: stu.length - active,
        groups: (groups || []).length, courses: (courses || []).length,
        teachers: (members || []).filter((m) => m.role === 'teacher').length,
      });
    } catch (err: unknown) {
      const m = err && typeof err === 'object' && 'message' in err ? String((err as { message: string }).message) : 'Unable to load center data';
      setError(m);
    } finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { void load(); }, [load]);

  const applyPlan = async (e: FormEvent) => {
    e.preventDefault();
    if (!centerId || !user?.id) return;
    setBusy(true); setMsg('');
    try {
      const { data, error } = await supabase.rpc('admin_change_center_subscription', {
        p_center_id: centerId, p_plan: planSel, p_billing_period: billSel, p_student_limit: PLAN_LIMITS[planSel] ?? 20, p_note: null,
      });
      if (error) throw error;
      const changed = (data as { changed?: boolean } | null)?.changed;
      setMsg(changed === false ? 'O‘zgarish yo‘q' : 'Tarif yangilandi · history + notification');
      await load();
    } catch (err: unknown) {
      const m = err && typeof err === 'object' && 'message' in err ? String((err as { message: string }).message) : 'Xato';
      setMsg(m + ' — FIX_CENTER_SUBSCRIPTION.sql');
    } finally { setBusy(false); }
  };

  if (loading) {
    return (
      <div>
        <p className="muted">Loading center…</p>
        <div className="card skeleton-block"><div className="skeleton-line" /><div className="skeleton-line" /></div>
      </div>
    );
  }
  if (!center) {
    return (
      <div className="card empty-box">
        <h3>Center not found</h3>
        <p className="muted">{error || 'Bu ID boʻyicha markaz yoʻq.'}</p>
        <Link className="btn secondary" to="/centers" style={{ textDecoration: 'none' }}><ArrowLeft size={16} /> Orqaga</Link>
      </div>
    );
  }
  const st = subStatus(sub);
  return (
    <div>
      <div className="page-head">
        <div>
          <Link to="/centers" className="muted back-link"><ArrowLeft size={14} /> Markazlar</Link>
          <h1>{center.name}</h1>
          <p className="muted">ID: {center.id}</p>
        </div>
      </div>
      {msg && <p className="muted">{msg}</p>}
      <div className="detail-grid">
        <div className="card">
          <h3>Basic information</h3>
          <dl className="kv">
            <dt>Center name</dt><dd>{center.name}</dd>
            <dt>Center ID</dt><dd><code>{center.id}</code></dd>
            <dt>Owner</dt><dd>{owner?.full_name || 'Unavailable'}</dd>
            <dt>Owner email</dt><dd>{owner?.email || 'Unavailable'}</dd>
            <dt>Created at</dt><dd>{fmtDateLong(center.created_at)}</dd>
            <dt>Status</dt><dd><span className={`badge badge-${st}`}>{st === 'none' ? 'No subscription' : st}</span></dd>
          </dl>
        </div>
        <div className="card">
          <h3>Subscription</h3>
          <dl className="kv">
            <dt>Current plan</dt><dd><code>{planOf(sub)}</code></dd>
            <dt>Billing cycle</dt><dd>{billingOf(sub)}</dd>
            <dt>Subscription status</dt><dd>{sub?.status || (st === 'none' ? '—' : st)}</dd>
            <dt>Started at</dt><dd>{fmtDateLong(sub?.started_at)}</dd>
            <dt>Expires at</dt><dd>{fmtDateLong(sub?.expires_at)}</dd>
            <dt>Time left</dt>
            <dd className={countdown.expired ? 'err' : ''}>
              <Clock size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              {countdown.expired ? 'Expired' : `Expires in ${countdown.label}`}
            </dd>
          </dl>
          <form onSubmit={applyPlan} className="plan-form">
            <strong>Tarifni o‘zgartirish</strong>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <select className="input" style={{ maxWidth: 140 }} value={planSel} onChange={(e) => setPlanSel(e.target.value)}>
                {plans.map((p) => <option key={p.id} value={p.id}>{p.name_uz || p.id}</option>)}
              </select>
              <select className="input" style={{ maxWidth: 120 }} value={billSel} onChange={(e) => setBillSel(e.target.value as BillingPeriod)}>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
              <button className="btn" type="submit" disabled={busy}>
                {busy ? <Loader2 className="spin" size={16} /> : null} Saqlash
              </button>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>History + faqat owner ga notification (duplicate yoʻq).</p>
          </form>
        </div>
        <div className="card">
          <h3>Statistics</h3>
          <div className="stats">
            <div className="stat"><span className="muted">Students</span><strong>{stats.totalStudents}</strong></div>
            <div className="stat"><span className="muted">Active</span><strong>{stats.activeStudents}</strong></div>
            <div className="stat"><span className="muted">Inactive</span><strong>{stats.inactiveStudents}</strong></div>
            <div className="stat"><span className="muted">Groups</span><strong>{stats.groups}</strong></div>
            <div className="stat"><span className="muted">Courses</span><strong>{stats.courses}</strong></div>
            <div className="stat"><span className="muted">Teachers</span><strong>{stats.teachers}</strong></div>
          </div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3>Subscription history</h3>
        {history.length === 0 ? (
          <p className="muted">Hali tarix yoʻq. Tarif o‘zgartirilganda bu yerda ko‘rinadi.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Changed at</th><th>Old → New</th><th>Billing</th><th>Prev expiry</th><th>New expiry</th></tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{fmtDateLong(h.changed_at)}</td>
                    <td><code>{h.old_plan || '—'}</code> → <code>{h.new_plan}</code></td>
                    <td>{(h.old_billing_period || '—')} → {(h.new_billing_period || '—')}</td>
                    <td>{fmtDate(h.old_expires_at)}</td>
                    <td>{fmtDate(h.new_expires_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
