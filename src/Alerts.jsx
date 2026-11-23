import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import './alerts.css'
import { Chips } from './Vitals.jsx'

const TZ = 'Asia/Kolkata' // matches facility_tz() in the database
const fmt = ts => ts ? new Date(ts).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }) : ''
const isLead = me => me.role === 'admin' || me.role === 'supervisor'
const clean = m => String(m || '').replace(/^[A-Z_]+:\s*/, '')
const toLocalInput = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
const istMidnight = () => {
  const ymd = new Date().toLocaleDateString('en-CA', { timeZone: TZ }) // e.g. 2026-11-22
  return new Date(`${ymd}T00:00:00+05:30`)
}

/* ---------- shared alert data: live + 30s backup refresh ---------- */
export function useAlerts(me) {
  const [rows, setRows] = useState([])
  const [names, setNames] = useState({})
  const [err, setErr] = useState('')
  const active = !!(me && me.active)

  const reload = useCallback(async () => {
    if (!active) return
    const { data, error } = await supabase.from('alerts').select('*')
      .is('resolved_at', null).order('created_at', { ascending: false })
    if (error) setErr(error.message); else { setErr(''); setRows(data) }
  }, [active])

  useEffect(() => {
    if (!active) return
    reload()
    supabase.from('profiles').select('id, full_name').then(({ data }) => {
      if (data) setNames(Object.fromEntries(data.map(p => [p.id, p.full_name])))
    })
    const ch = supabase.channel('alerts-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, reload)
      .subscribe()
    const t = setInterval(reload, 30000)
    return () => { clearInterval(t); supabase.removeChannel(ch) }
  }, [active, reload])

  const waiting = rows.filter(a => !a.acknowledged_by)
  return { rows, names, err, reload, count: waiting.length, critical: waiting.filter(a => a.priority === 'critical').length }
}

/* ---------- bell in the header ---------- */
export function Bell({ count, critical, active, onClick }) {
  return (
    <button className="bell" aria-current={active ? 'page' : undefined} onClick={onClick}
      aria-label={`Alerts: ${count} waiting`}>
      <span aria-hidden="true">🔔</span>
      {count > 0 && <span className={`badge${critical > 0 ? ' hot' : ''}`}>{count}</span>}
    </button>
  )
}

/* ---------- alerts page ---------- */
const GROUPS = [['critical', 'Critical'], ['normal', 'Normal'], ['info', 'Info']]

export function AlertsPage({ me, alerts }) {
  const { rows, names, err, reload } = alerts
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const lead = isLead(me)

  const call = async (id, fn) => {
    setBusy(id); setMsg('')
    const { data, error } = await supabase.rpc(fn, { p_alert_id: id })
    setBusy('')
    if (error) setMsg(clean(error.message))
    else if (data === 'OK') setMsg('')
    else if (String(data).startsWith('ALREADY_CLAIMED')) setMsg('Already taken: ' + clean(data))
    else if (data === 'ALREADY_RESOLVED') setMsg('That alert was already closed.')
    reload()
  }

  return (
    <>
      <h1>Alerts</h1>
      <p className="sub">{lead ? 'Tap “I’m on it” so everyone knows you are handling it and the timer stops.' : 'Notes for you from the care team.'}</p>
      {(err || msg) && <p className="err" role="alert">{err || msg}</p>}
      {rows.length === 0 && <div className="card"><p className="empty">No open alerts. All clear.</p></div>}
      {GROUPS.map(([p, label]) => {
        const list = rows.filter(a => a.priority === p)
        if (list.length === 0) return null
        return (
          <section key={p}>
            <h2 className={`al-head al-head-${p}`}>{label} ({list.length})</h2>
            {list.map(a => (
              <div key={a.id} className={`al al-${a.priority}`}>
                <div className="al-main">
                  <p className="al-msg">{a.message}</p>
                  <p className="al-meta">
                    {fmt(a.created_at)}
                    {a.escalated_at && <span className="al-tag hot">Escalated to admin</span>}
                    {a.next_escalation_at && !a.acknowledged_by && <span className="al-tag">Goes to admin at {fmtTime(a.next_escalation_at)}</span>}
                    {a.acknowledged_by && <span className="al-tag ok">On it: {names[a.acknowledged_by] ?? 'a colleague'}</span>}
                  </p>
                </div>
                <div className="al-actions">
                  {lead && !a.acknowledged_by && a.level !== 'caregiver' &&
                    <button className="btn" disabled={busy === a.id} onClick={() => call(a.id, 'claim_alert')}>I’m on it</button>}
                  <button className="btn quiet" disabled={busy === a.id} onClick={() => call(a.id, 'resolve_alert')}>{lead ? 'Resolve' : 'Done'}</button>
                </div>
              </div>
            ))}
          </section>
        )
      })}
    </>
  )
}

/* ---------- floor overview (supervisor + admin) ---------- */
const STATUS_LABEL = { pending: 'Due', given: 'Given', missed: 'Missed', refused: 'Refused', not_available: 'Not available', held: 'Held', resident_away: 'Away' }
const PROBLEM = ['missed', 'refused', 'not_available']

export function Floor({ me, alerts }) {
  const [res, setRes] = useState([])
  const [doses, setDoses] = useState([])
  const [covers, setCovers] = useState([])
  const [unit, setUnit] = useState('')
  const [vit, setVit] = useState([])     // flagged vitals, last 24 h
  const [vUnits, setVUnits] = useState({})
  const [err, setErr] = useState('')
  const names = alerts.names

  const load = useCallback(async () => {
    const start = istMidnight()
    const end = new Date(start.getTime() + 864e5)
    const [r, d, c] = await Promise.all([
      supabase.from('residents').select('id, full_name, room, unit_label, assigned_caregiver_id').eq('active', true).order('full_name'),
      supabase.from('dose_events').select('resident_id, status').eq('is_prn', false)
        .gte('scheduled_at', start.toISOString()).lt('scheduled_at', end.toISOString()).limit(1000),
      supabase.from('cover_assignments').select('*').gt('ends_at', new Date().toISOString()).order('starts_at'),
    ])
    const e = r.error || d.error || c.error
    if (e) { setErr(e.message); return }
    setErr(''); setRes(r.data); setDoses(d.data); setCovers(c.data)
    // flagged vitals are an extra: if they cannot load, the rest of the Floor still works
    const [v, vr] = await Promise.all([
      supabase.from('vitals').select('id, resident_id, taken_at, critical, flagged, flags, systolic, diastolic, heart_rate, temperature, spo2, glucose, weight_kg')
        .eq('flagged', true).is('voided_at', null).gte('taken_at', new Date(Date.now() - 864e5).toISOString())
        .order('taken_at', { ascending: false }).limit(300),
      supabase.from('vital_ranges').select('vital, unit'),
    ])
    if (!v.error && v.data) setVit(v.data)
    if (!vr.error && vr.data) setVUnits(Object.fromEntries(vr.data.map(x => [x.vital, x.unit])))
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const total = s => doses.filter(d => d.status === s).length
  const per = id => {
    const o = {}
    doses.filter(d => d.resident_id === id).forEach(d => { o[d.status] = (o[d.status] || 0) + 1 })
    return o
  }
  // newest flagged reading per resident; a resident with any critical one counts as critical
  const flagBy = {}
  vit.forEach(v => {
    const cur = flagBy[v.resident_id]
    if (!cur) flagBy[v.resident_id] = { latest: v, critical: !!v.critical }
    else if (v.critical) cur.critical = true
  })
  const flagList = Object.entries(flagBy).sort((a, b) => Number(b[1].critical) - Number(a[1].critical) || (a[1].latest.taken_at < b[1].latest.taken_at ? 1 : -1))
  const flagCrit = flagList.filter(([, x]) => x.critical).length
  const openFor = id => alerts.rows.filter(a => a.resident_id === id).length
  const resName = id => res.find(r => r.id === id)?.full_name ?? 'Resident'
  const units = [...new Set(res.map(r => r.unit_label).filter(Boolean))]
  const now = Date.now()
  const rowsShown = res.filter(r => !unit || r.unit_label === unit)
    .map(r => ({ r, c: per(r.id) }))
    .sort((a, b) => {
      const pa = PROBLEM.some(s => a.c[s]) || openFor(a.r.id) || flagBy[a.r.id] ? 1 : 0
      const pb = PROBLEM.some(s => b.c[s]) || openFor(b.r.id) || flagBy[b.r.id] ? 1 : 0
      return pb - pa
    })

  return (
    <>
      <h1>Floor overview</h1>
      <p className="sub">Today’s doses across all residents. Refreshes every 30 seconds.</p>
      {err && <p className="err" role="alert">{err}</p>}

      <div className="stats">
        <div className="stat"><b>{alerts.count}</b><span>Alerts waiting{alerts.critical > 0 && ` (${alerts.critical} critical)`}</span></div>
        <div className="stat"><b>{total('missed')}</b><span>Missed today</span></div>
        <div className="stat"><b>{total('refused')}</b><span>Refused today</span></div>
        <div className="stat"><b>{total('given')}</b><span>Given today</span></div>
        <div className="stat"><b>{total('pending')}</b><span>Still to give</span></div>
        <div className="stat"><b>{flagList.length}</b><span>Residents with flagged vitals (24 h){flagCrit > 0 && ` (${flagCrit} critical)`}</span></div>
      </div>

      {flagList.length > 0 && (
        <div className="card vt-floor">
          <h2>Flagged vitals, last 24 hours</h2>
          {flagList.map(([id, x]) => (
            <div className={`row${x.critical ? ' flag' : ''}`} key={id}>
              <span className="name">{resName(id)}</span>
              {x.critical && <span className="tag hot">Critical</span>}
              <span className="meta">{fmt(x.latest.taken_at)}</span>
              <Chips v={x.latest} units={vUnits} />
            </div>
          ))}
        </div>
      )}

      {covers.length > 0 && (
        <div className="card">
          <h2>Cover</h2>
          {covers.map(c => (
            <div className="row" key={c.id}>
              <span className="name">{resName(c.resident_id)}</span>
              <span className="meta">covered by {names[c.covering_caregiver_id] ?? 'a colleague'}</span>
              <span className="meta">{new Date(c.starts_at).getTime() <= now ? 'Now until' : `${fmt(c.starts_at)} to`} {fmt(c.ends_at)}</span>
            </div>
          ))}
        </div>
      )}

      {units.length > 0 && (
        <p><label>Unit filter{' '}
          <select value={unit} onChange={e => setUnit(e.target.value)}>
            <option value="">All units</option>
            {units.map(u => <option key={u}>{u}</option>)}
          </select></label></p>
      )}

      <div className="card">
        {rowsShown.length === 0 && <p className="empty">No residents to show.</p>}
        {rowsShown.map(({ r, c }) => {
          const flagged = PROBLEM.some(s => c[s]) || openFor(r.id) > 0 || !!flagBy[r.id]
          return (
            <div className={`row${flagged ? ' flag' : ''}`} key={r.id}>
              <span className="name">{r.full_name}</span>
              <span className="meta">{[r.room && `Room ${r.room}`, r.unit_label].filter(Boolean).join(', ') || '—'}</span>
              <span className="meta">{names[r.assigned_caregiver_id] ?? 'Unassigned'}</span>
              <span className="meta">
                {Object.keys(c).length === 0 ? 'No doses today'
                  : Object.entries(c).map(([s, n]) => `${STATUS_LABEL[s] ?? s} ${n}`).join(' · ')}
                {openFor(r.id) > 0 && ` · ${openFor(r.id)} alert${openFor(r.id) > 1 ? 's' : ''}`}
                {flagBy[r.id] && ' · vitals flagged'}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}

/* ---------- temporary cover ---------- */
export function Cover({ me }) {
  const [residents, setResidents] = useState([])
  const [people, setPeople] = useState([])
  const [names, setNames] = useState({})
  const [covers, setCovers] = useState([])
  const [f, setF] = useState({ resident: '', to: '', start: toLocalInput(new Date()), end: toLocalInput(new Date(Date.now() + 8 * 36e5)) })
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [r, p, n, c] = await Promise.all([
      supabase.from('residents').select('id, full_name').eq('active', true).order('full_name'),
      supabase.rpc('list_cover_candidates'),
      supabase.from('profiles').select('id, full_name'),
      supabase.from('cover_assignments').select('*').gt('ends_at', new Date().toISOString()).order('starts_at'),
    ])
    const e = r.error || p.error || c.error
    if (e) setErr(e.message)
    if (r.data) setResidents(r.data)
    if (p.data) setPeople(p.data)
    if (n.data) setNames(Object.fromEntries(n.data.map(x => [x.id, x.full_name])))
    if (c.data) setCovers(c.data)
  }, [])
  useEffect(() => { load() }, [load])

  const submit = async e => {
    e.preventDefault(); setBusy(true); setErr(''); setOk('')
    const { data, error } = await supabase.rpc('create_cover', {
      p_resident_id: f.resident, p_to: f.to,
      p_starts: new Date(f.start).toISOString(), p_ends: new Date(f.end).toISOString(),
    })
    setBusy(false)
    if (error) setErr(clean(error.message))
    else if (data === 'OK') { setOk('Cover arranged. Your colleague has been told.'); setF({ ...f, resident: '', to: '' }); load() }
    else setErr(clean(data))
  }

  const end = async id => {
    setErr(''); setOk('')
    const { data, error } = await supabase.rpc('end_cover', { p_cover_id: id })
    if (error) setErr(clean(error.message))
    else if (data !== 'OK') setErr('That cover had already ended.')
    load()
  }

  const resName = id => residents.find(r => r.id === id)?.full_name ?? 'Resident'
  const now = Date.now()

  return (
    <>
      <h1>Cover</h1>
      <p className="sub">Hand a resident to a colleague for a set period. Every dose still records who actually gave it.</p>
      {err && <p className="err" role="alert">{err}</p>}
      {ok && <p className="ok" role="status">{ok}</p>}

      <form className="card fields" onSubmit={submit}>
        <label>Resident
          <select value={f.resident} required onChange={e => setF({ ...f, resident: e.target.value })}>
            <option value="">Choose…</option>
            {residents.map(r => <option key={r.id} value={r.id}>{r.full_name}</option>)}
          </select></label>
        <label>Hand to
          <select value={f.to} required onChange={e => setF({ ...f, to: e.target.value })}>
            <option value="">Choose…</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.full_name} ({p.role})</option>)}
          </select></label>
        <label>From<input type="datetime-local" value={f.start} required onChange={e => setF({ ...f, start: e.target.value })} /></label>
        <label>Until<input type="datetime-local" value={f.end} required onChange={e => setF({ ...f, end: e.target.value })} /></label>
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Hand over'}</button>
      </form>

      <div className="card">
        <h2>Current and upcoming cover</h2>
        {covers.length === 0 && <p className="empty">No cover arranged.</p>}
        {covers.map(c => {
          const started = new Date(c.starts_at).getTime() <= now
          return (
            <div className="row" key={c.id}>
              <span className="name">{resName(c.resident_id)}</span>
              <span className="meta">covered by {names[c.covering_caregiver_id] ?? 'a colleague'}</span>
              <span className="meta">{started ? 'Now until' : `${fmt(c.starts_at)} to`} {fmt(c.ends_at)}</span>
              <button className="btn quiet" onClick={() => end(c.id)}>{started ? 'End now' : 'Cancel'}</button>
            </div>
          )
        })}
      </div>
    </>
  )
}
