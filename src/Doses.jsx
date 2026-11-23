import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import './doses.css'

const REASONS = {
  refused: ['Did not want it', 'Felt unwell', 'Trouble swallowing', 'Side effects', 'Other'],
  held: ['Doctor or nurse instruction', 'Low blood pressure', 'Procedure or test', 'Other'],
  not_available: ['Out of stock', 'Not delivered', 'Other'],
  resident_away: ['Hospital', 'Family visit', 'Outing', 'Other'],
}
const LABEL = { given: 'Given', later: 'Later', refused: 'Refused', held: 'Held',
  not_available: 'Not available', resident_away: 'Resident away', pending: 'Due', missed: 'Missed' }
const nice = m => m.replace('ALREADY_RECORDED: ', 'Already ').replace(/^[A-Z_]+: /, '')
const hm = d => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function MyDay({ me }) {
  // The dose log ("Given by X at 8:05") is for supervisors and admin only.
  const seesLog = me?.role === 'admin' || me?.role === 'supervisor'
  const [rows, setRows] = useState([])
  const [err, setErr] = useState('')
  const [pick, setPick] = useState(null) // { id, mode: 'record' | 'correct', outcome, reason }

  const load = async () => {
    await supabase.rpc('generate_dose_events')
    const a = new Date(); a.setHours(0, 0, 0, 0)
    const b = new Date(a); b.setDate(b.getDate() + 1)
    const { data, error } = await supabase.from('dose_events')
      .select('id, status, scheduled_at, postponed_until, is_prn, medications(drug_name, dose_text, time_critical), residents(full_name, room), dose_records(outcome, reason, recorded_at, who:profiles!recorded_by(full_name))')
      .gte('scheduled_at', a.toISOString()).lt('scheduled_at', b.toISOString()).order('scheduled_at')
    if (error) setErr(error.message); else setRows(data)
  }
  useEffect(() => { load() }, [])

  const call = async (fn, args) => {
    const { error } = await supabase.rpc(fn, args)
    setErr(error ? nice(error.message) : ''); setPick(null); load()
  }
  const record = (id, o, reason = null) => call('record_dose', { p_event: id, p_outcome: o, p_reason: reason })

  let prev = ''
  return (
    <>
      <h1>My day</h1>
      <p className="sub">Today’s doses for your residents. The first person to record a dose wins.</p>
      {err && <p className="err" role="alert">{err}</p>}
      {rows.length === 0 && <p className="empty">No doses scheduled today for your residents.</p>}
      {rows.map(r => {
        const t = hm(r.scheduled_at), head = t !== prev; prev = t
        const last = [...r.dose_records].filter(x => x.outcome !== 'later')
          .sort((x, y) => (x.recorded_at < y.recorded_at ? 1 : -1))[0]
        const open = r.status === 'pending' || r.status === 'missed'
        const p = pick?.id === r.id ? pick : null
        return (
          <div key={r.id}>
            {head && <h2 className="timehead">{t}</h2>}
            <div className="card dose">
              <div className="top">
                <strong>{r.residents.full_name}{r.residents.room && ` (Room ${r.residents.room})`}</strong>
                <span>{r.medications.drug_name} {r.medications.dose_text}</span>
                {r.medications.time_critical && <span className="chip">Time-critical</span>}
                <span className="chip" data-s={r.status}>{LABEL[r.status]}</span>
              </div>
              {seesLog && last && <p className="note">{LABEL[last.outcome]} by {last.who?.full_name} at {hm(last.recorded_at)}{last.reason && ` · ${last.reason}`}</p>}
              {open && r.postponed_until && <p className="note">Later: try again after {hm(r.postponed_until)}</p>}

              {open && !p && (
                <div className="acts">
                  <button className="btn" onClick={() => record(r.id, 'given')}>Given</button>
                  <button className="btn quiet" onClick={() => record(r.id, 'later')}>Later</button>
                  <button className="btn quiet" onClick={() => setPick({ id: r.id, mode: 'record', outcome: 'refused', reason: '' })}>Refused</button>
                  <select aria-label="Not given" value="" onChange={e => e.target.value && setPick({ id: r.id, mode: 'record', outcome: e.target.value, reason: '' })}>
                    <option value="">Not given…</option>
                    <option value="held">Held</option>
                    <option value="not_available">Not available</option>
                    <option value="resident_away">Resident away</option>
                  </select>
                </div>
              )}
              {!open && !p && <div className="acts"><button className="btn quiet" onClick={() => setPick({ id: r.id, mode: 'correct', outcome: 'given', reason: '' })}>Correct</button></div>}

              {p && (
                <div className="acts">
                  {p.mode === 'correct' ? (
                    <>
                      <select aria-label="Correct outcome" value={p.outcome} onChange={e => setPick({ ...p, outcome: e.target.value })}>
                        {['given', 'refused', 'held', 'not_available', 'resident_away'].map(o => <option key={o} value={o}>{LABEL[o]}</option>)}
                      </select>
                      <input aria-label="Reason for correction" placeholder="Reason for correction" value={p.reason} onChange={e => setPick({ ...p, reason: e.target.value })} />
                    </>
                  ) : (
                    <select aria-label="Reason" value={p.reason} onChange={e => setPick({ ...p, reason: e.target.value })}>
                      <option value="">{LABEL[p.outcome]}: choose a reason…</option>
                      {REASONS[p.outcome].map(x => <option key={x}>{x}</option>)}
                    </select>
                  )}
                  <button className="btn" disabled={!p.reason.trim()}
                    onClick={() => p.mode === 'correct'
                      ? call('correct_dose', { p_event: r.id, p_new_outcome: p.outcome, p_reason: p.reason })
                      : record(r.id, p.outcome, p.reason)}>Confirm</button>
                  <button className="btn quiet" onClick={() => setPick(null)}>Cancel</button>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}

export function Meds({ me }) {
  const isAdmin = me.role === 'admin'
  const blank = { drug: '', dose: '', times: '', prn: false, crit: false }
  const [res, setRes] = useState([])
  const [rid, setRid] = useState('')
  const [meds, setMeds] = useState([])
  const [f, setF] = useState(blank)
  const [prn, setPrn] = useState(null) // { id, reason }
  const [err, setErr] = useState('')

  useEffect(() => {
    supabase.from('residents').select('id, full_name').eq('active', true).order('full_name')
      .then(({ data }) => { setRes(data || []); if (data?.[0]) setRid(data[0].id) })
  }, [])
  const load = async () => {
    if (!rid) return
    const { data, error } = await supabase.from('medications').select('*, schedule_times(time_of_day)')
      .eq('resident_id', rid).neq('status', 'discontinued').order('drug_name')
    if (error) setErr(error.message); else setMeds(data)
  }
  useEffect(() => { load() }, [rid])

  const add = async e => {
    e.preventDefault()
    const times = f.prn ? [] : f.times.split(',').map(s => s.trim()).filter(s => /^\d{1,2}:\d{2}$/.test(s))
    if (!f.prn && times.length === 0) return setErr('Add at least one time, like 08:00 or 08:00, 20:00.')
    const { data, error } = await supabase.from('medications').insert({
      resident_id: rid, drug_name: f.drug, dose_text: f.dose, is_prn: f.prn,
      time_critical: f.crit, window_minutes: f.crit ? 30 : 60 }).select('id').single()
    if (error) return setErr(error.message)
    if (times.length) {
      const t = await supabase.from('schedule_times').insert(times.map(time_of_day => ({ medication_id: data.id, time_of_day })))
      if (t.error) return setErr(t.error.message)
    }
    setErr(''); setF(blank); load()
  }
  const givePrn = async () => {
    const { error } = await supabase.rpc('record_prn', { p_medication: prn.id, p_reason: prn.reason })
    setErr(error ? nice(error.message) : ''); setPrn(null)
  }

  return (
    <>
      <h1>Medications</h1>
      <p className="sub">{isAdmin ? 'Add medications and times for a resident.' : 'Medications for your residents.'}</p>
      {err && <p className="err" role="alert">{err}</p>}
      <p><label>Resident{' '}
        <select value={rid} onChange={e => setRid(e.target.value)}>
          {res.map(r => <option key={r.id} value={r.id}>{r.full_name}</option>)}
        </select></label></p>

      {isAdmin && rid && (
        <form className="card fields" onSubmit={add}>
          <label>Medication<input value={f.drug} required onChange={e => setF({ ...f, drug: e.target.value })} /></label>
          <label>Dose<input value={f.dose} required placeholder="e.g. 5 mg" onChange={e => setF({ ...f, dose: e.target.value })} /></label>
          <label>Times<input value={f.times} disabled={f.prn} placeholder="08:00, 20:00" onChange={e => setF({ ...f, times: e.target.value })} /></label>
          <label><span>As needed (PRN)</span><input type="checkbox" checked={f.prn} onChange={e => setF({ ...f, prn: e.target.checked })} /></label>
          <label><span>Time-critical</span><input type="checkbox" checked={f.crit} onChange={e => setF({ ...f, crit: e.target.checked })} /></label>
          <button className="btn">Add medication</button>
        </form>
      )}

      <div className="card">
        {meds.length === 0 && <p className="empty">No medications for this resident yet.</p>}
        {meds.map(m => (
          <div className="row" key={m.id}>
            <span className="name">{m.drug_name} {m.dose_text}</span>
            <span className="meta">{m.is_prn ? 'As needed' : m.schedule_times.map(s => s.time_of_day.slice(0, 5)).sort().join(', ')}{m.time_critical && ' · Time-critical'}</span>
            {m.is_prn && (prn?.id === m.id ? (
              <>
                <input aria-label="Reason given" placeholder="Why was it given?" value={prn.reason} onChange={e => setPrn({ ...prn, reason: e.target.value })} />
                <button className="btn" disabled={!prn.reason.trim()} onClick={givePrn}>Confirm</button>
                <button className="btn quiet" onClick={() => setPrn(null)}>Cancel</button>
              </>
            ) : <button className="btn quiet" onClick={() => setPrn({ id: m.id, reason: '' })}>Give now</button>)}
          </div>
        ))}
      </div>
    </>
  )
}
