import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Routes, Route, Navigate, useNavigate, useParams, Link } from 'react-router-dom';
import {
  LayoutDashboard, Building2, CreditCard, BookOpen, Users, Megaphone, LogOut, Plus, Trash2, Loader2, Shield,
  Search, ArrowLeft, Clock,
} from 'lucide-react';
import logoDark from './assets/velia-night-logo.png';
import { supabase } from './lib/supabase';
import { Centers, CenterDetail } from './pages/Centers';

type AdminUser = { id: string; email?: string };

function useAdmin() {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const safety = window.setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 12_000);
    void (async () => {
      try {
        const { data } = await Promise.race([
          supabase.auth.getSession(),
          new Promise<{ data: { session: null } }>((resolve) =>
            window.setTimeout(() => resolve({ data: { session: null } }), 10_000)
          ),
        ]);
        if (cancelled) return;
        const u = data.session?.user;
        if (!u) {
          setLoading(false);
          return;
        }
        setUser({ id: u.id, email: u.email });
        const { data: profile } = await supabase
          .from('profiles')
          .select('is_platform_admin')
          .eq('id', u.id)
          .maybeSingle();
        if (cancelled) return;
        setOk(Boolean(profile?.is_platform_admin));
      } catch {
        if (!cancelled) setOk(false);
      } finally {
        if (!cancelled) setLoading(false);
        window.clearTimeout(safety);
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(safety);
    };
  }, []);
  return { user, ok, loading };
}

function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
      if (err || !data.user) { setError(err?.message || 'Login xato'); return; }
      const { data: profile } = await supabase.from('profiles').select('is_platform_admin').eq('id', data.user.id).maybeSingle();
      if (!profile?.is_platform_admin) {
        await supabase.auth.signOut();
        setError('Platform admin emas');
        return;
      }
      nav('/');
    } finally { setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand-row">
          <img src={logoDark} alt="Velia" className="logo" />
          <div><h1>Velia Admin</h1><p className="muted">Platform boshqaruvi</p></div>
        </div>
        <label className="muted">Email</label>
        <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" required />
        <label className="muted" style={{ display: 'block', marginTop: 10 }}>Parol</label>
        <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" required />
        {error && <p className="err">{error}</p>}
        <button className="btn" type="submit" disabled={busy} style={{ marginTop: 14, width: '100%' }}>
          {busy ? <Loader2 className="spin" size={16} /> : null} Kirish
        </button>
      </form>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const nav = useNavigate();
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="side-brand">
          <img src={logoDark} alt="Velia" className="side-logo" />
          <span>Admin</span>
        </div>
        <NavLink to="/" end><LayoutDashboard size={16} /> Dashboard</NavLink>
        <NavLink to="/centers"><Building2 size={16} /> Markazlar</NavLink>
        <NavLink to="/subscriptions"><CreditCard size={16} /> Tariflar</NavLink>
        <NavLink to="/mocks"><BookOpen size={16} /> Mock testlar</NavLink>
        <NavLink to="/announcements"><Megaphone size={16} /> Xabarlar</NavLink>
        <NavLink to="/users"><Users size={16} /> Adminlar</NavLink>
        <button type="button" className="logout-btn" onClick={async () => { await supabase.auth.signOut(); nav('/login'); }}>
          <LogOut size={16} /> Chiqish
        </button>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

function Dashboard() {
  const [stats, setStats] = useState({ centers: 0, students: 0, mocks: 0, subs: 0 });
  useEffect(() => {
    void (async () => {
      const [c, s, m, sub] = await Promise.all([
        supabase.from('centers').select('*', { count: 'exact', head: true }),
        supabase.from('students').select('*', { count: 'exact', head: true }),
        supabase.from('mock_tests').select('*', { count: 'exact', head: true }),
        supabase.from('center_subscriptions').select('*', { count: 'exact', head: true }),
      ]);
      setStats({ centers: c.count ?? 0, students: s.count ?? 0, mocks: m.count ?? 0, subs: sub.count ?? 0 });
    })();
  }, []);
  return (
    <div>
      <h1>Dashboard</h1>
      <div className="stats">
        <div className="stat"><span className="muted">Markazlar</span><strong>{stats.centers}</strong></div>
        <div className="stat"><span className="muted">Oquvchilar</span><strong>{stats.students}</strong></div>
        <div className="stat"><span className="muted">Mock testlar</span><strong>{stats.mocks}</strong></div>
        <div className="stat"><span className="muted">Faol tariflar</span><strong>{stats.subs}</strong></div>
      </div>
    </div>
  );
}

function Subscriptions() {
  const [rows, setRows] = useState<any[]>([]);
  const load = useCallback(async () => {
    const { data } = await supabase.from('center_subscriptions').select('id, plan, student_limit, expires_at, updated_at, centers(name)').order('updated_at', { ascending: false }).limit(200);
    setRows(data || []);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const setPlan = async (id: string, plan: string) => {
    const limits: Record<string, number> = { start: 20, silver: 100, gold: 1000, platinum: 999999 };
    const studentLimit = limits[plan] ?? 20;
    const { data: list } = await supabase.from('centers').select('id, center_subscriptions(id)').limit(500);
    let resolvedCenter: string | null = null;
    for (const c of list || []) {
      const subs = Array.isArray(c.center_subscriptions) ? c.center_subscriptions : c.center_subscriptions ? [c.center_subscriptions] : [];
      if (subs.some((s: any) => s?.id === id)) { resolvedCenter = c.id; break; }
    }
    if (resolvedCenter) {
      const { error } = await supabase.rpc('admin_set_center_plan', {
        p_center_id: resolvedCenter,
        p_plan: plan,
        p_student_limit: studentLimit,
      });
      if (error) {
        await supabase.from('subscriptions').upsert({
          center_id: resolvedCenter,
          plan_id: plan,
          status: 'active',
          student_limit_override: studentLimit,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'center_id' });
      }
    } else {
      await supabase.from('center_subscriptions').update({
        plan,
        student_limit: studentLimit,
        updated_at: new Date().toISOString(),
      }).eq('id', id);
    }
    await load();
  };
  return (
    <div>
      <h1>Tariflar / obunalar</h1>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Markaz</th><th>Plan</th><th>Status</th><th>Amal</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const c = Array.isArray(r.centers) ? r.centers[0] : r.centers;
              return (
                <tr key={r.id}>
                  <td>{c?.name || '—'}</td>
                  <td><code>{r.plan || r.plan_id}</code></td>
                  <td>{r.plan || r.status || '—'}</td>
                  <td>
                    <select className="input" style={{ maxWidth: 160 }} value={r.plan || 'start'} onChange={(e) => void setPlan(r.id, e.target.value)}>
                      <option value="start">Start</option>
                      <option value="silver">Silver</option>
                      <option value="gold">Gold</option>
                      <option value="platinum">Platinum</option>
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Guard({ children }: { children: React.ReactNode }) {
  const { ok, loading } = useAdmin();
  if (loading) return <div className="main">Yuklanmoqda...</div>;
  if (!ok) return <Navigate to="/login" replace />;
  return <Shell>{children}</Shell>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Guard><Dashboard /></Guard>} />
      <Route path="/centers" element={<Guard><Centers /></Guard>} />
      <Route path="/centers/:centerId" element={<Guard><CenterDetail /></Guard>} />
      <Route path="/subscriptions" element={<Guard><Subscriptions /></Guard>} />
      <Route path="/mocks" element={<Guard><Mocks /></Guard>} />
      <Route path="/announcements" element={<Guard><Announcements /></Guard>} />
      <Route path="/users" element={<Guard><UsersPage /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
