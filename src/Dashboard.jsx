import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import './dashboard.css'

const TZ = 'Asia/Kolkata' // matches facility_tz() in the database
const fmt = ts => ts ? new Date(ts).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }) : ''
const clean = m => String(m || '').replace(/^[A-Z_]+:\s*/, '')
const missing = e => /Could not find the function|PGRST202/i.test(`${e?.code} ${e?.message}`)
const pct = v => v == null ? '—' : `${v}%`
const isLead = me => me.role === 'admin' || me.role === 'supervisor'
const PERIODS = [[7, 'Last 7 days'], [14, 'Last 14 days'], [30, 'Last 30 days']]
const SEGS = [['given', 'Given'], ['refused', 'Refused'], ['missed', 'Missed'], ['not_available', 'Not available']]

/* call one database function, refresh every minute */
function useRpc(fn, args) {
  const [s, setS] = useState({ data: null, err: '', setup: false, loading: true })
  const key = JSON.stringify(args || {})
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc(fn, args || {})
    if (error) setS(p => ({ ...p, err: clean(error.message), setup: missing(error), loading: false }))
    else setS({ data, err: '', setup: false, loading: false })
  }, [fn, key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load()
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [load])
  return { ...s, reload: load }
}

const Problem = ({ r }) => (r.err || r.setup) ? (
  <p className="err" role="alert">{r.setup
    ? 'The dashboards database script (dashboards_8a.sql) has not been run yet. Run it in Supabase, then refresh this page.'
    : r.err}</p>
) : null

function Tile({ label, value, hint, hot, onClick }) {
  const body = (<><b>{value ?? '—'}</b><span>{label}</span>{hint && <small>{hint}</small>}</>)
  const cls = `db-tile${hot ? ' hot' : ''}`
  return onClick ? <button className={cls} onClick={onClick}>{body}</button> : <div className={cls}>{body}</div>
}

/* ---------- caregiver: today for my residents ---------- */
function MyToday() {
  const r = useRpc('dash_my_doses')
  const d = r.data
  return (
    <section>
      <h2>Your residents today</h2>
      <Problem r={r} />
      {d && (
        <>
          <div className="db-tiles">
            <Tile label="Still to give" value={d.due} hint={d.next_due_at ? `Next at ${fmtTime(d.next_due_at)}` : 'Nothing due soon'} />
            <Tile label="Given" value={d.given} />
            <Tile label="Missed" value={d.missed} hot={d.missed > 0} />
            <Tile label="Refused" value={d.refused} hot={d.refused > 0} />
            <Tile label="Held or not available" value={d.not_given} />
            <Tile label="Your adherence, 7 days" value={pct(d.week_adherence_pct)} />
          </div>
          <p className="db-note">You recorded {d.recorded_by_me_today} dose{d.recorded_by_me_today === 1 ? '' : 's'} and {d.vitals_by_me_today} vitals reading{d.vitals_by_me_today === 1 ? '' : 's'} today.</p>
        </>
      )}
    </section>
  )
}

/* ---------- supervisor + admin: what needs attention now ---------- */
function Attention({ go }) {
  const r = useRpc('dash_supervisor')
  const d = r.data
  return (
    <section>
      <h2>Needs attention now</h2>
      <Problem r={r} />
      {d && (
        <div className="db-tiles">
          <Tile label="Critical alerts" value={d.alerts_critical} hot={d.alerts_critical > 0} onClick={() => go('alerts')} />
          <Tile label="Alerts nobody has claimed" value={d.alerts_unclaimed}
            hint={d.oldest_unclaimed_minutes != null ? `Oldest waiting ${d.oldest_unclaimed_minutes} min` : 'None waiting'}
            hot={d.alerts_unclaimed > 0} onClick={() => go('alerts')} />
          <Tile label="Changes waiting for a decision" value={d.pending_changes}
            hint={d.pending_urgent > 0 ? `${d.pending_urgent} urgent` : 'None urgent'} hot={d.pending_urgent > 0} onClick={() => go('approvals')} />
          <Tile label="Missed today" value={d.missed_today} hot={d.missed_today > 0} onClick={() => go('floor')} />
          <Tile label="Refused today" value={d.refused_today} hint={`${d.refused_7d} in 7 days`} onClick={() => go('floor')} />
          <Tile label="Residents with flagged vitals (24 h)" value={d.flagged_residents_24h}
            hint={d.critical_vitals_24h > 0 ? `${d.critical_vitals_24h} critical reading${d.critical_vitals_24h === 1 ? '' : 's'}` : 'None critical'}
            hot={d.critical_vitals_24h > 0} onClick={() => go('floor')} />
          <Tile label="Cover in place now" value={d.covers_active} onClick={() => go('cover')} />
        </div>
      )}
    </section>
  )
}

/* ---------- charts (plain SVG and CSS, no extra libraries) ---------- */
function Breakdown({ o }) {
  const total = o.expected
  return (
    <>
      <div className="db-bar" role="img"
        aria-label={SEGS.map(([k, l]) => `${l} ${o[k]}`).join(', ')}>
        {SEGS.map(([k, l]) => o[k] > 0 && <span key={k} className={`seg ${k}`} style={{ flex: o[k] }} title={`${l}: ${o[k]} of ${total}`} />)}
      </div>
      <ul className="db-legend">
        {SEGS.map(([k, l]) => <li key={k}><i className={`seg ${k}`} aria-hidden="true" />{l} <b>{o[k]}</b></li>)}
      </ul>
    </>
  )
}

function TrendChart({ rows }) {
  const W = 600, H = 190, top = 20, bottom = 24, n = rows.length
  const slot = W / n, bw = Math.min(40, slot * 0.7)
  const step = n > 20 ? 5 : n > 10 ? 2 : 1
  return (
    <svg className="db-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Adherence per day over ${n} days`}>
      <line className="axis" x1="0" x2={W} y1={H - bottom} y2={H - bottom} />
      {rows.map((r, i) => {
        const x = i * slot + (slot - bw) / 2
        const h = r.adherence_pct == null ? 0 : (r.adherence_pct / 100) * (H - top - bottom)
        const [, m, dd] = String(r.day).split('-')
        return (
          <g key={r.day}>
            <title>{`${dd}/${m}: ${r.adherence_pct == null ? 'no doses' : `${r.adherence_pct}% (${r.given} of ${r.expected})`}`}</title>
            {r.adherence_pct == null
              ? <rect className="bar none" x={x} y={H - bottom - 3} width={bw} height="3" />
              : <rect className="bar" x={x} y={H - bottom - h} width={bw} height={Math.max(h, 1)} rx="3" />}
            {n <= 14 && r.adherence_pct != null && <text className="val" x={x + bw / 2} y={H - bottom - h - 5} textAnchor="middle">{Math.round(r.adherence_pct)}</text>}
            {i % step === 0 && <text className="lab" x={x + bw / 2} y={H - 7} textAnchor="middle">{`${dd}/${m}`}</text>}
          </g>
        )
      })}
    </svg>
  )
}

/* ---------- adherence (everyone; caregivers see only their residents) ---------- */
function AdherencePanel({ days }) {
  const a = useRpc('dash_adherence', { p_days: days })
  const t = useRpc('dash_trend', { p_days: Math.min(days, 30) })
  const [all, setAll] = useState(false)
  const o = a.data?.overall
  const res = a.data?.by_resident || []
  const shown = all ? res : res.slice(0, 8)
  return (
    <>
      <Problem r={a} />
      <div className="card">
        <h2>Adherence</h2>
        {!o && !a.err && <p className="empty">Loading…</p>}
        {o && o.expected === 0 && <p className="empty">No doses to measure in this period yet.</p>}
        {o && o.expected > 0 && (
          <>
            <p className="db-big"><b>{pct(o.adherence_pct)}</b> <span>{o.given} given out of {o.expected} expected</span></p>
            <Breakdown o={o} />
            <p className="db-note">Not counted: {o.held} held, {o.away} resident away, {o.pending} still due.</p>
          </>
        )}
      </div>

      {t.data && t.data.length > 0 && (
        <div className="card">
          <h2>Adherence per day</h2>
          <TrendChart rows={t.data} />
          <p className="db-note">Percentage of expected doses given each day. Today is the last bar and may still change.</p>
        </div>
      )}
      <Problem r={t} />

      {res.length > 0 && (
        <div className="card">
          <h2>By resident</h2>
          <p className="db-note">Lowest adherence first.</p>
          {shown.map(x => (
            <div className="db-row" key={x.resident_id}>
              <span className="name">{x.name}{x.room && <small> Room {x.room}</small>}</span>
              <span className="mini" aria-hidden="true"><i style={{ width: `${x.adherence_pct ?? 0}%` }} /></span>
              <b>{pct(x.adherence_pct)}</b>
              <span className="meta">{x.given} of {x.expected}{x.refused > 0 && ` · ${x.refused} refused`}{x.missed > 0 && ` · ${x.missed} missed`}</span>
            </div>
          ))}
          {res.length > 8 && <button className="btn quiet" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${res.length}`}</button>}
        </div>
      )}
    </>
  )
}

/* ---------- admin: team ---------- */
function Team({ days }) {
  const a = useRpc('dash_adherence', { p_days: days })
  const w = useRpc('dash_workload', { p_days: days })
  const cg = a.data?.by_caregiver || []
  const rows = w.data || []
  const max = Math.max(1, ...rows.map(x => x.doses_recorded))
  const mins = m => m == null ? '—' : m >= 0 ? `${m} min after` : `${-m} min before`
  return (
    <>
      <Problem r={a} /><Problem r={w} />
      <div className="card">
        <h2>Adherence by caregiver</h2>
        <p className="db-note">Counted for each caregiver’s assigned residents.</p>
        {cg.length === 0 && <p className="empty">No data in this period.</p>}
        {cg.map(x => (
          <div className="db-row" key={x.caregiver_id ?? 'none'}>
            <span className="name">{x.name}<small> {x.residents} resident{x.residents === 1 ? '' : 's'}</small></span>
            <span className="mini" aria-hidden="true"><i style={{ width: `${x.adherence_pct ?? 0}%` }} /></span>
            <b>{pct(x.adherence_pct)}</b>
            <span className="meta">{x.given} of {x.expected} · {x.missed} missed · {x.refused} refused</span>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Workload</h2>
        <p className="db-note">Counted for whoever actually recorded the dose, including cover. Timing is the typical gap from the due time.</p>
        {rows.length === 0 && <p className="empty">No caregivers yet.</p>}
        {rows.map(x => (
          <div className="db-row" key={x.caregiver_id}>
            <span className="name">{x.name}<small> {x.residents} resident{x.residents === 1 ? '' : 's'}</small></span>
            <span className="mini" aria-hidden="true"><i style={{ width: `${(x.doses_recorded / max) * 100}%` }} /></span>
            <b>{x.doses_recorded}</b>
            <span className="meta">doses recorded · {mins(x.typical_minutes_from_due)} · {x.vitals_entered} vitals</span>
          </div>
        ))}
      </div>
    </>
  )
}

/* ---------- admin: audit log ---------- */
const PAGE = 50
function Audit() {
  const [rows, setRows] = useState([])
  const [types, setTypes] = useState([])
  const [entity, setEntity] = useState('')
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [setup, setSetup] = useState(false)

  const load = useCallback(async (before, append) => {
    setBusy(true)
    const { data, error } = await supabase.rpc('dash_audit', { p_limit: PAGE, p_before: before ?? null, p_entity: entity || null })
    setBusy(false)
    if (error) { setErr(clean(error.message)); setSetup(missing(error)); return }
    setErr(''); setSetup(false)
    setRows(prev => append ? [...prev, ...data] : data)
    setMore(data.length === PAGE)
    setTypes(prev => [...new Set([...prev, ...data.map(x => x.entity_type)])].sort())
  }, [entity])
  useEffect(() => { load(null, false) }, [load])

  const short = d => {
    if (d == null || (typeof d === 'object' && Object.keys(d).length === 0)) return null
    return JSON.stringify(d, null, 2)
  }
  return (
    <div className="card">
      <h2>Audit log</h2>
      <p className="db-note">Every change made in the app, newest first. Admin only.</p>
      <Problem r={{ err, setup }} />
      <p className="db-filter"><label>Show{' '}
        <select value={entity} onChange={e => setEntity(e.target.value)}>
          <option value="">Everything</option>
          {types.map(t => <option key={t} value={t}>{t}</option>)}
        </select></label>{' '}
        <button className="btn quiet" disabled={busy} onClick={() => load(null, false)}>Refresh</button></p>
      {rows.length === 0 && !busy && !err && <p className="empty">Nothing logged yet.</p>}
      {rows.map(x => (
        <div className="db-row audit" key={x.id}>
          <span className="meta when">{fmt(x.created_at)}</span>
          <span className="name">{x.actor_name}</span>
          <span className="meta">{x.action} · {x.entity_type}</span>
          {short(x.details) && <details><summary>Details</summary><pre>{short(x.details)}</pre></details>}
        </div>
      ))}
      {more && <button className="btn quiet" disabled={busy} onClick={() => load(rows[rows.length - 1].created_at, true)}>{busy ? 'Loading…' : 'Load older entries'}</button>}
    </div>
  )
}

/* ---------- the Dashboard tab ---------- */
export function Dashboard({ me, go }) {
  const lead = isLead(me)
  const admin = me.role === 'admin'
  const [days, setDays] = useState(7)
  const [view, setView] = useState('adherence')
  const shown = admin ? view : 'adherence'
  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">{admin ? 'The whole care home at a glance.' : lead ? 'What needs attention, and how doses are going.' : 'How today is going for your residents.'}</p>

      {lead ? <Attention go={go} /> : <MyToday />}

      <div className="db-toolbar">
        {admin && (
          <div className="db-seg" role="group" aria-label="Dashboard view">
            {[['adherence', 'Adherence'], ['team', 'Team'], ['audit', 'Audit log']].map(([k, l]) => (
              <button key={k} className="btn quiet" aria-pressed={shown === k} onClick={() => setView(k)}>{l}</button>
            ))}
          </div>
        )}
        {shown !== 'audit' && (
          <label>Period{' '}
            <select value={days} onChange={e => setDays(Number(e.target.value))}>
              {PERIODS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
            </select></label>
        )}
      </div>

      {shown === 'adherence' && <AdherencePanel days={days} />}
      {shown === 'team' && <Team days={days} />}
      {shown === 'audit' && <Audit />}
    </>
  )
}
