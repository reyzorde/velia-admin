import { FormEvent, useCallback, useEffect, useState } from 'react';
import { NavLink, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Building2, CreditCard, BookOpen, Users, Megaphone, LogOut, Plus, Trash2, Loader2, Shield,
} from 'lucide-react';
import logoDark from './assets/velia-night-logo.png';
import { supabase } from './lib/supabase';

type AdminUser = { id: string; email?: string };

function useAdmin() {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void supabase.auth.getSession().then(async ({ data }) => {
      const u = data.session?.user;
      if (!u) { setLoading(false); return; }
      setUser({ id: u.id, email: u.email });
      const { data: profile } = await supabase.from('profiles').select('is_platform_admin').eq('id', u.id).maybeSingle();
      setOk(Boolean(profile?.is_platform_admin));
      setLoading(false);
    });
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

function Centers() {
  const [rows, setRows] = useState<any[]>([]);
  const [plans, setPlans] = useState<Array<{ id: string; name_uz: string }>>([]);
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    const [{ data }, { data: p }] = await Promise.all([
      supabase.from('centers').select('id, name, owner_id, created_at, center_subscriptions(id, plan, student_limit, expires_at)').order('created_at', { ascending: false }),
      supabase.from('plans').select('id, name_uz').order('sort_order'),
    ]);
    setRows(data || []);
    setPlans(p || []);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const changePlan = async (centerId: string, planId: string) => {
    setMsg('');
    const limits: Record<string, number> = { start: 20, silver: 100, gold: 1000, platinum: 999999 };
    const studentLimit = limits[planId] ?? 20;

    const { error: rpcErr } = await supabase.rpc('admin_set_center_plan', {
      p_center_id: centerId,
      p_plan: planId,
      p_student_limit: studentLimit,
    });
    if (!rpcErr) {
      setMsg('Tarif yangilandi');
      await load();
      return;
    }

    const { error: subErr } = await supabase.from('subscriptions').upsert(
      {
        center_id: centerId,
        plan_id: planId,
        status: 'active',
        billing_period: 'monthly',
        student_limit_override: studentLimit,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'center_id' }
    );
    if (!subErr) {
      setMsg('Tarif yangilandi (subscriptions)');
      await load();
      return;
    }

    setMsg(
      (rpcErr?.message || subErr?.message || 'Xato') +
        ' — Supabase SQL Editor da FIX_ADMIN_PLAN.sql ni ishga tushiring'
    );
    await load();
  };

  return (
    <div>
      <h1>Markazlar</h1>
      {msg && <p className="muted">{msg}</p>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Nomi</th><th>Joriy tarif</th><th>Status</th><th>Tarifni ozgartirish</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const sub = Array.isArray(r.center_subscriptions) ? r.center_subscriptions[0] : r.center_subscriptions;
              return (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td><code>{sub?.plan || sub?.plan_id || '—'}</code></td>
                  <td>{sub?.plan ? 'active' : '—'}</td>
                  <td>
                    <select className="input" style={{ maxWidth: 180 }} defaultValue={sub?.plan || sub?.plan_id || ''} onChange={(e) => { if (e.target.value) void changePlan(r.id, e.target.value); }}>
                      <option value="" disabled>Tanlang</option>
                      {plans.map((p) => <option key={p.id} value={p.id}>{p.name_uz || p.id}</option>)}
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
    const row = rows.find((r) => r.id === id);
    const centerId = row?.center_id || (Array.isArray(row?.centers) ? null : null);
    // Prefer RPC via center if we can resolve
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

function Mocks() {
  const { user } = useAdmin();
  const [rows, setRows] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [subjectId, setSubjectId] = useState('physics');
  const [duration, setDuration] = useState(60);
  const [centerId, setCenterId] = useState('');
  const [centers, setCenters] = useState<Array<{ id: string; name: string }>>([]);
  const [qText, setQText] = useState('Namuna savol?');
  const [optA, setOptA] = useState('A');
  const [optB, setOptB] = useState('B');
  const [optC, setOptC] = useState('C');
  const [optD, setOptD] = useState('D');
  const [correct, setCorrect] = useState('A');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [{ data }, { data: c }] = await Promise.all([
      supabase.from('mock_tests').select('id, title, public_code, center_id, is_published, created_at, centers(name)').order('created_at', { ascending: false }).limit(150),
      supabase.from('centers').select('id, name').order('name'),
    ]);
    setRows(data || []);
    setCenters(c || []);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!user?.id) return;
    setBusy(true); setMsg('');
    try {
      const { data: test, error: tErr } = await supabase.from('mock_tests').insert({
        center_id: centerId || null, subject_id: subjectId, title: title.trim(), duration_minutes: duration,
        max_score: 1, is_published: true, created_by: user.id,
      }).select('id, public_code').single();
      if (tErr || !test) throw tErr || new Error('Test yaratilmadi');
      const { data: q, error: qErr } = await supabase.from('mock_questions').insert({
        test_id: test.id, question_type: 'single_choice', prompt: qText.trim() || 'Savol', points: 1, sort_order: 1,
      }).select('id').single();
      if (qErr || !q) throw qErr || new Error('Savol saqlanmadi');
      const opts = [{ label: optA, key: 'A' }, { label: optB, key: 'B' }, { label: optC, key: 'C' }, { label: optD, key: 'D' }].filter((o) => o.label.trim());
      for (let i = 0; i < opts.length; i++) {
        await supabase.from('mock_question_options').insert({ question_id: q.id, label: opts[i].label.trim(), is_correct: opts[i].key === correct, sort_order: i + 1 });
      }
      setMsg('Yaratildi. Kod: ' + test.public_code);
      setTitle('');
      await load();
    } catch (err: any) { setMsg(err?.message || 'Xato'); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!confirm("Mock test o'chirilsinmi? Oy limitti qaytarmaydi.")) return;
    await supabase.from('mock_tests').delete().eq('id', id);
    await load();
  };
  return (
    <div>
      <h1>Mock testlar</h1>
      <p className="muted">Admin cheklovsiz yaratadi. Ochirish oy limitini qaytarmaydi.</p>
      <form className="card" onSubmit={create} style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
        <strong>Yangi test (minimal 1 savol)</strong>
        <input className="input" placeholder="Test nomi" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <select className="input" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            <option value="physics">Fizika</option><option value="math">Matematika</option><option value="ielts">IELTS</option>
            <option value="biology">Biologiya</option><option value="chemistry">Kimyo</option><option value="history">Tarix</option>
            <option value="native_lang">Ona tili</option>
          </select>
          <input className="input" type="number" min={5} value={duration} onChange={(e) => setDuration(Number(e.target.value) || 60)} />
          <select className="input" value={centerId} onChange={(e) => setCenterId(e.target.value)}>
            <option value="">Barcha / platform</option>
            {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <input className="input" value={qText} onChange={(e) => setQText(e.target.value)} placeholder="Savol matni" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <input className="input" value={optA} onChange={(e) => setOptA(e.target.value)} placeholder="A" />
          <input className="input" value={optB} onChange={(e) => setOptB(e.target.value)} placeholder="B" />
          <input className="input" value={optC} onChange={(e) => setOptC(e.target.value)} placeholder="C" />
          <input className="input" value={optD} onChange={(e) => setOptD(e.target.value)} placeholder="D" />
        </div>
        <select className="input" value={correct} onChange={(e) => setCorrect(e.target.value)} style={{ maxWidth: 120 }}>
          <option value="A">Togri: A</option><option value="B">Togri: B</option><option value="C">Togri: C</option><option value="D">Togri: D</option>
        </select>
        {msg && <p className="muted">{msg}</p>}
        <button className="btn" type="submit" disabled={busy}>{busy ? <Loader2 className="spin" size={16} /> : <Plus size={16} />} Yaratish</button>
      </form>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Nomi</th><th>Kod</th><th>Markaz</th><th>Sana</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const c = Array.isArray(r.centers) ? r.centers[0] : r.centers;
              return (
                <tr key={r.id}>
                  <td>{r.title}</td>
                  <td><code>{r.public_code}</code></td>
                  <td>{c?.name || '—'}</td>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td><button className="btn danger" type="button" onClick={() => void remove(r.id)}><Trash2 size={14} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Announcements() {
  const { user } = useAdmin();
  const [rows, setRows] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [centerId, setCenterId] = useState('');
  const [centers, setCenters] = useState<Array<{ id: string; name: string }>>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [{ data }, { data: c }] = await Promise.all([
      supabase.from('platform_announcements').select('id, title, body, target_center_id, active, created_at, centers(name)').order('created_at', { ascending: false }).limit(100),
      supabase.from('centers').select('id, name').order('name'),
    ]);
    setRows(data || []);
    setCenters(c || []);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!user?.id) return;
    setBusy(true); setMsg('');
    try {
      const { error } = await supabase.from('platform_announcements').insert({
        title: title.trim() || null, body: body.trim(), target_center_id: centerId || null, created_by: user.id, active: true,
      });
      if (error) throw error;
      setTitle(''); setBody(''); setMsg('Yuborildi');
      await load();
    } catch (err: any) { setMsg(err?.message || 'Xato — SQL migratsiyani ishga tushiring'); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!confirm("Xabar o'chirilsinmi?")) return;
    await supabase.from('platform_announcements').delete().eq('id', id);
    await load();
  };
  return (
    <div>
      <h1>Markazlarga xabar</h1>
      <p className="muted">Velia app ochilganda modal korinishida chiqadi.</p>
      <form className="card" onSubmit={send} style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
        <input className="input" placeholder="Sarlavha" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="input" rows={4} placeholder="Xabar matni" value={body} onChange={(e) => setBody(e.target.value)} required />
        <select className="input" value={centerId} onChange={(e) => setCenterId(e.target.value)}>
          <option value="">Barcha markazlar</option>
          {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {msg && <p className="muted">{msg}</p>}
        <button className="btn" type="submit" disabled={busy}>{busy ? <Loader2 className="spin" size={16} /> : <Megaphone size={16} />} Yuborish</button>
      </form>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Sarlavha</th><th>Matn</th><th>Markaz</th><th>Sana</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const c = Array.isArray(r.centers) ? r.centers[0] : r.centers;
              return (
                <tr key={r.id}>
                  <td>{r.title || '—'}</td>
                  <td style={{ maxWidth: 280 }}>{r.body?.slice(0, 80)}</td>
                  <td>{c?.name || 'Barcha'}</td>
                  <td>{new Date(r.created_at).toLocaleString()}</td>
                  <td><button className="btn danger" type="button" onClick={() => void remove(r.id)}><Trash2 size={14} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UsersPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, is_platform_admin, created_at')
      .eq('is_platform_admin', true)
      .order('created_at', { ascending: false })
      .limit(100);
    setRows(data || []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const createAdmin = async (e: FormEvent) => {
    e.preventDefault();
    setMsg('');
    setBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const adminSession = sessionData.session;
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { full_name: fullName.trim() } },
      });
      if (error) throw error;
      const uid = data.user?.id;
      if (!uid) throw new Error('Foydalanuvchi yaratilmadi (email confirm o‘chirilganini tekshiring)');

      const { error: pErr } = await supabase.from('profiles').upsert({
        id: uid,
        email: email.trim(),
        full_name: fullName.trim(),
        is_platform_admin: true,
      });
      if (pErr) {
        // RPC fallback
        const { error: rpcErr } = await supabase.rpc('create_platform_admin', {
          p_email: email.trim(),
          p_password: password,
          p_full_name: fullName.trim(),
        });
        if (rpcErr) throw new Error(pErr.message + ' | ' + rpcErr.message);
      }

      // Restore original admin session if signUp switched it
      if (adminSession) {
        await supabase.auth.setSession({
          access_token: adminSession.access_token,
          refresh_token: adminSession.refresh_token,
        });
      }

      setFullName('');
      setEmail('');
      setPassword('');
      setMsg('Yangi admin yaratildi: ' + email.trim());
      await load();
    } catch (err: any) {
      setMsg(err?.message || 'Xato');
    } finally {
      setBusy(false);
    }
  };

  const revokeAdmin = async (id: string) => {
    const { error } = await supabase.from('profiles').update({ is_platform_admin: false }).eq('id', id);
    setMsg(error ? error.message : 'Admin huquqi olib tashlandi');
    await load();
  };

  return (
    <div>
      <h1>Platform adminlar</h1>
      <p className="muted">Yangi adminni email va parol bilan yarating. Mavjud foydalanuvchini «admin qilish» yo‘q.</p>
      <form className="card" onSubmit={createAdmin} style={{ display: 'grid', gap: 10, marginBottom: 16, maxWidth: 480 }}>
        <strong>Yangi admin</strong>
        <input className="input" placeholder="To‘liq ism" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        <input className="input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
        <input className="input" type="password" placeholder="Parol (min 6)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} autoComplete="new-password" required />
        <button className="btn" type="submit" disabled={busy}>{busy ? <Loader2 className="spin" size={16} /> : <Plus size={16} />} Yaratish</button>
      </form>
      {msg && <p className="muted">{msg}</p>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Ism</th><th>Email</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.full_name || '—'}</td>
                <td>{r.email}</td>
                <td>
                  <button className="btn danger" type="button" onClick={() => void revokeAdmin(r.id)}>Olib tashla</button>
                </td>
              </tr>
            ))}
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
      <Route path="/subscriptions" element={<Guard><Subscriptions /></Guard>} />
      <Route path="/mocks" element={<Guard><Mocks /></Guard>} />
      <Route path="/announcements" element={<Guard><Announcements /></Guard>} />
      <Route path="/users" element={<Guard><UsersPage /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
