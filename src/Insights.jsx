import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import './insights.css'

const TZ = 'Asia/Kolkata' // matches facility_tz() in the database
const fmt = ts => ts ? new Date(ts).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
const clean = m => String(m || '').replace(/^[A-Z_]+:\s*/, '')
const notReady = e => /AI_NOT_READY|Could not find the function|PGRST202/i.test(`${e?.code} ${e?.message}`)
const BAND = { high: 'High', elevated: 'Elevated', low: 'Low' }
const MODEL_NAME = { vital_anomaly: 'Unusual-reading check', risk_insight: 'Risk insight' }
const pc = v => v == null ? '—' : `${Math.round(v * 100)}%`

const Problem = ({ err, setup }) => (err || setup) ? (
  <p className="err" role="alert">{setup
    ? 'The AI database script (ai_10a.sql) has not been run yet. Run it in Supabase, then refresh this page.'
    : err}</p>
) : null

/* one resident: what is usual for them + which recent readings were unusual */
function Detail({ rid, name }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    supabase.rpc('ai_vital_check', { p_resident: rid, p_days: 14 }).then(({ data, error }) => {
      if (!live) return
      if (error) setErr(clean(error.message)); else setD(data)
    })
    return () => { live = false }
  }, [rid])
  if (err) return <p className="err" role="alert">{err}</p>
  if (!d) return <p className="empty">Loading…</p>
  const rd = d.readings || []
  const unusual = rd.filter(r => r.unusual)
  const learning = rd.filter(r => r.learning).length
  return (
    <div className="in-detail">
      <h3>Usual values for {name}</h3>
      {d.baseline.length === 0
        ? <p className="empty">Not enough readings yet to learn what is usual for {name}. It needs at least 5 earlier readings of the same kind within 30 days.</p>
        : <ul className="in-usual">{d.baseline.map(b => (
            <li key={b.vital}><b>{b.label}</b> usually {b.usual} {b.unit}<small> (range {b.low} to {b.high})</small></li>))}</ul>}
      <h3>Last 14 days</h3>
      {rd.length === 0 && <p className="empty">No readings in the last 14 days.</p>}
      {rd.length > 0 && <p className="in-note">{unusual.length} of {rd.length} readings were unusual for {name}.{learning > 0 && ` ${learning} ${learning === 1 ? 'reading is' : 'readings are'} too early to judge.`}</p>}
      {unusual.map(r => (
        <div className="in-reading" key={r.vital_id}>
          <strong>{fmt(r.taken_at)}</strong>
          <ul className="in-why">{r.reasons.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      ))}
    </div>
  )
}

/* ---------- Insights tab ---------- */
export function Insights({ me }) {
  const lead = me.role === 'admin' || me.role === 'supervisor'
  const [data, setData] = useState(null)
  const [info, setInfo] = useState([])
  const [err, setErr] = useState('')
  const [setup, setSetup] = useState(false)
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState('')

  const load = useCallback(async () => {
    const { data: d, error } = await supabase.rpc('ai_risk', { p_resident: null })
    if (error) { setErr(clean(error.message)); setSetup(notReady(error)); return }
    setErr(''); setSetup(false); setData(d)
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, 60000)
    supabase.rpc('ai_model_info').then(({ data: m }) => { if (Array.isArray(m)) setInfo(m) })
    return () => clearInterval(t)
  }, [load])

  const list = data?.residents || []
  const attention = list.filter(r => r.band !== 'low')
  const shown = all ? list : attention
  const nHigh = list.filter(r => r.band === 'high').length

  return (
    <>
      <h1>Insights <span className="in-proto">Prototype</span></h1>
      <p className="sub">Early-warning prompts from a prototype trained on simulated data. They suggest where to look. They never diagnose, and a person always decides.</p>
      <Problem err={err} setup={setup} />

      {data && (
        <p className="in-summary">
          {attention.length === 0
            ? 'No resident needs a closer look right now.'
            : `${attention.length} ${attention.length === 1 ? 'resident' : 'residents'} to take a closer look at${nHigh > 0 ? ` (${nHigh} high)` : ''}.`}
          {' '}<small>{lead ? 'Based on the last 7 days.' : 'For your residents, based on the last 7 days.'}</small>
        </p>
      )}
      {list.length > attention.length && (
        <p><button className="btn quiet" onClick={() => setAll(!all)}>{all ? 'Show only those to look at' : `Show all ${list.length} residents`}</button></p>
      )}

      {shown.map(r => (
        <div key={r.resident_id} className={`card in-card ${r.band}`}>
          <div className="in-head">
            <strong>{r.name}{r.room && ` (Room ${r.room})`}</strong>
            <span className={`in-band ${r.band}`}>{BAND[r.band]}</span>
          </div>
          <ul className="in-why">{r.reasons.map((t, i) => <li key={i}>{t}</li>)}</ul>
          <button className="btn quiet" aria-expanded={open === r.resident_id}
            onClick={() => setOpen(open === r.resident_id ? '' : r.resident_id)}>{open === r.resident_id ? 'Hide readings' : 'See readings'}</button>
          {open === r.resident_id && <Detail rid={r.resident_id} name={r.name} />}
        </div>
      ))}

      <details className="card in-about">
        <summary>About these models</summary>
        <p className="in-note">Both models are small and explainable. Their numbers come from simulated data, so they show that the method works, not how it would perform on real residents.</p>
        {info.map(m => (
          <div key={m.name} className="in-model">
            <h3>{MODEL_NAME[m.name] ?? m.name} <small>version {m.version}</small></h3>
            <p>{m.note}</p>
            <p className="in-note">Trained on: {m.trained_on}.</p>
            <p className="in-note">
              {m.name === 'vital_anomaly'
                ? `On simulated test data: it caught ${pc(m.metrics?.recall)} of unusual readings, and ${pc(m.metrics?.precision)} of its flags were right (false alarms on ${pc(m.metrics?.false_alarm_rate)} of normal readings).`
                : `On simulated test data: it caught ${pc(m.metrics?.elevated_or_higher?.recall)} of simulated declines at Elevated or higher, and ${pc(m.metrics?.high?.precision)} of High flags were right.`}
            </p>
          </div>
        ))}
        {info.length === 0 && <p className="empty">Model details are not available.</p>}
      </details>
    </>
  )
}
