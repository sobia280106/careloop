import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { MyDay, Meds } from './Doses.jsx'
import { useAlerts, Bell, AlertsPage, Floor, Cover } from './Alerts.jsx'
import { usePending, Approvals } from './Changes.jsx'
import { Vitals } from './Vitals.jsx'
import { Dashboard } from './Dashboard.jsx'
import { Insights } from './Insights.jsx'

const IDLE_MS = 15 * 60 * 1000 // auto-logout after 15 minutes of no activity
const ROLE_LABEL = { admin: 'Admin', supervisor: 'Supervisor', caregiver: 'Caregiver' }

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = still checking
  const [me, setMe] = useState(undefined)
  const [tab, setTab] = useState('myday')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    setTab('myday') // never carry the previous person's screen over to the next login
    if (!session) { setMe(undefined); return }
    supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle()
      .then(({ data }) => setMe(data))
  }, [session])

  useEffect(() => {
    if (!session) return
    let t
    const reset = () => { clearTimeout(t); t = setTimeout(() => supabase.auth.signOut(), IDLE_MS) }
    const evs = ['click', 'keydown', 'mousemove', 'touchstart']
    evs.forEach(e => window.addEventListener(e, reset)); reset()
    return () => { clearTimeout(t); evs.forEach(e => window.removeEventListener(e, reset)) }
  }, [session])

  const reloadMe = () => session && supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle()
    .then(({ data }) => setMe(data))

  const alerts = useAlerts(me) // must stay above the early returns below
  const pending = usePending(me)

  if (session === undefined) return <main><p className="sub">Loading…</p></main>
  if (!session) return <Login />
  if (me === undefined) return <main><p className="sub">Loading your account…</p></main>
  if (me === null || !me.active) return (
    <main>
      <h1>Account not active</h1>
      <p className="sub">Ask your administrator to activate your account.</p>
      <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </main>
  )

  const lead = me.role === 'admin' || me.role === 'supervisor'
  const tabs = [
    ['myday', 'My day'], ['dashboard', 'Dashboard'], ['residents', 'Residents'], ['meds', 'Medications'], ['vitals', 'Vitals'], ['insights', 'Insights'],
    ...(lead ? [['floor', 'Floor'], ['approvals', pending.count ? `Approvals (${pending.count})` : 'Approvals'], ['cover', 'Cover']] : []),
    ...(me.role === 'admin' ? [['staff', 'Staff']] : []),
  ]
  const allowed = tabs.map(([k]) => k).concat('alerts')
  const shownTab = allowed.includes(tab) ? tab : 'myday'
  return (
    <>
      <header className="bar">
        <span className="brand">CareLoop</span>
        <nav className="tabs">
          {tabs.map(([k, label]) => (
            <button key={k} className="tab" aria-current={shownTab === k ? 'page' : undefined}
              onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
        <Bell count={alerts.count} critical={alerts.critical} active={shownTab === 'alerts'} onClick={() => setTab('alerts')} />
        <span className="who">{me.full_name} ({ROLE_LABEL[me.role]})</span>
        <button className="btn quiet" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      <main>{shownTab === 'myday' ? <MyDay me={me} />
        : shownTab === 'dashboard' ? <Dashboard me={me} go={setTab} />
        : shownTab === 'residents' ? <Residents me={me} />
        : shownTab === 'meds' ? <Meds me={me} />
        : shownTab === 'vitals' ? <Vitals me={me} />
        : shownTab === 'insights' ? <Insights me={me} />
        : shownTab === 'alerts' ? <AlertsPage me={me} alerts={alerts} />
        : shownTab === 'floor' ? <Floor me={me} alerts={alerts} />
        : shownTab === 'approvals' ? <Approvals me={me} onChange={pending.reload} />
        : shownTab === 'cover' ? <Cover me={me} />
        : shownTab === 'staff' ? <Staff me={me} onRenamed={reloadMe} />
        : <MyDay me={me} />}</main>
    </>
  )
}

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async e => {
    e.preventDefault(); setBusy(true); setErr('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setErr('Email or password is incorrect.')
    setBusy(false)
  }
  return (
    <div className="login">
      <h1>CareLoop</h1>
      <p className="sub">Sign in with the account your administrator created.</p>
      <form className="card" onSubmit={submit}>
        {err && <p className="err" role="alert">{err}</p>}
        <label>Email<input type="email" value={email} required autoComplete="username"
          onChange={e => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" value={password} required autoComplete="current-password"
          onChange={e => setPassword(e.target.value)} /></label>
        <button className="btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}

function Residents({ me }) {
  const isAdmin = me.role === 'admin'
  const [rows, setRows] = useState([])
  const [staff, setStaff] = useState([])
  const [unit, setUnit] = useState('')
  const [f, setF] = useState({ full_name: '', room: '', unit_label: '' })
  const [err, setErr] = useState('')

  const load = async () => {
    const [r, s] = await Promise.all([
      supabase.from('residents').select('*').eq('active', true).order('full_name'),
      supabase.from('profiles').select('id, full_name').eq('active', true).order('full_name'),
    ])
    if (r.error) setErr(r.error.message); else setRows(r.data)
    if (s.data) setStaff(s.data)
  }
  useEffect(() => { load() }, [])

  const run = async q => { const { error } = await q; if (error) setErr(error.message); else { setErr(''); load() } }
  const add = e => {
    e.preventDefault()
    run(supabase.from('residents').insert({ full_name: f.full_name, room: f.room || null, unit_label: f.unit_label || null }))
    setF({ full_name: '', room: '', unit_label: '' })
  }
  const assign = (id, cg) => run(supabase.from('residents').update({ assigned_caregiver_id: cg || null }).eq('id', id))
  const archive = id => run(supabase.from('residents').update({ active: false }).eq('id', id))

  const nameOf = id => staff.find(s => s.id === id)?.full_name ?? 'Unassigned'
  const units = [...new Set(rows.map(r => r.unit_label).filter(Boolean))]
  const shown = unit ? rows.filter(r => r.unit_label === unit) : rows

  return (
    <>
      <h1>Residents</h1>
      <p className="sub">{isAdmin ? 'All residents.' : me.role === 'supervisor' ? 'All residents. Only an admin can add residents or change who looks after them.' : 'Residents assigned to you or under your cover.'}</p>
      {err && <p className="err" role="alert">{err}</p>}

      {isAdmin && (
        <form className="card fields" onSubmit={add}>
          <label>Full name<input value={f.full_name} required onChange={e => setF({ ...f, full_name: e.target.value })} /></label>
          <label>Room<input value={f.room} onChange={e => setF({ ...f, room: e.target.value })} /></label>
          <label>Unit<input value={f.unit_label} placeholder="e.g. East Wing" onChange={e => setF({ ...f, unit_label: e.target.value })} /></label>
          <button className="btn">Add resident</button>
        </form>
      )}

      {units.length > 0 && (
        <p><label>Unit filter{' '}
          <select value={unit} onChange={e => setUnit(e.target.value)}>
            <option value="">All units</option>
            {units.map(u => <option key={u}>{u}</option>)}
          </select></label></p>
      )}

      <div className="card">
        {shown.length === 0 && <p className="empty">{isAdmin ? 'No residents yet. Add the first one above.' : 'No residents are assigned to you yet.'}</p>}
        {shown.map(r => (
          <div className="row" key={r.id}>
            <span className="name">{r.full_name}</span>
            <span className="meta">{[r.room && `Room ${r.room}`, r.unit_label].filter(Boolean).join(', ') || '—'}</span>
            {isAdmin ? (
              <>
                <select aria-label={`Caregiver for ${r.full_name}`} value={r.assigned_caregiver_id ?? ''}
                  onChange={e => assign(r.id, e.target.value)}>
                  <option value="">Unassigned</option>
                  {staff.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                </select>
                <button className="btn quiet" onClick={() => archive(r.id)}>Archive</button>
              </>
            ) : <span className="meta">Caregiver: {nameOf(r.assigned_caregiver_id)}</span>}
          </div>
        ))}
      </div>
    </>
  )
}

function Staff({ me, onRenamed }) {
  const [rows, setRows] = useState([])
  const [edit, setEdit] = useState(null) // { id, name }
  const [err, setErr] = useState('')
  const load = async () => {
    const { data, error } = await supabase.from('profiles').select('*').order('full_name')
    if (error) setErr(error.message); else setRows(data)
  }
  useEffect(() => { load() }, [])
  const update = async (id, patch) => {
    const { error } = await supabase.from('profiles').update(patch).eq('id', id)
    if (error) setErr(error.message); else { setErr(''); load() }
  }
  const rename = async () => {
    const name = edit.name.trim()
    if (name.length < 2) return setErr('Enter a name with at least 2 letters.')
    const { data, error } = await supabase.from('profiles').update({ full_name: name }).eq('id', edit.id).select('id')
    if (error) setErr(error.message)
    else if (!data || data.length === 0) setErr('The database did not allow that rename.')
    else { setErr(''); if (edit.id === me.id && onRenamed) onRenamed(); setEdit(null); load() }
  }
  return (
    <>
      <h1>Staff</h1>
      <p className="sub">New accounts are created in Supabase (Authentication, Users) for now. Set each person’s role here.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="card">
        {rows.map(p => (
          <div className="row" key={p.id}>
            {edit?.id === p.id ? (
              <>
                <input aria-label={`New name for ${p.full_name}`} value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} />
                <button className="btn" onClick={rename}>Save name</button>
                <button className="btn quiet" onClick={() => setEdit(null)}>Cancel</button>
              </>
            ) : (
              <>
                <span className="name">{p.full_name}{p.id === me.id && ' (you)'}</span>
                <button className="btn quiet" aria-label={`Rename ${p.full_name}`} onClick={() => setEdit({ id: p.id, name: p.full_name })}>Rename</button>
              </>
            )}
            <select aria-label={`Role for ${p.full_name}`} value={p.role} disabled={p.id === me.id}
              onChange={e => update(p.id, { role: e.target.value })}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button className="btn quiet" disabled={p.id === me.id}
              onClick={() => update(p.id, { active: !p.active })}>{p.active ? 'Deactivate' : 'Activate'}</button>
          </div>
        ))}
      </div>
    </>
  )
}
