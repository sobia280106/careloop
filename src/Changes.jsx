import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import './changes.css'

const TZ = 'Asia/Kolkata'
const fmt = ts => ts ? new Date(ts).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
const clean = m => String(m || '').replace(/^[A-Z_]+:\s*/, '')
const KIND_LABEL = { change_time: 'Change times', change_dose: 'Change dose', pause: 'Pause', resume: 'Resume', stop: 'Stop medication' }
const RESULT = {
  APPLIED: 'Change applied.',
  PENDING: 'Request sent for approval.',
  PENDING_HELD: 'Urgent request sent. The next dose is on hold.',
  PENDING_NO_DOSE: 'Urgent request sent. There was no dose due to hold.',
  PENDING_NOT_HELD: 'Urgent request sent, but the dose could not be held. Please check My day.',
}

/* count of waiting requests, for the Approvals tab (supervisor + admin) */
export function usePending(me) {
  const lead = !!me && !!me.active && (me.role === 'admin' || me.role === 'supervisor')
  const [rows, setRows] = useState([])
  const reload = useCallback(async () => {
    if (!lead) return
    const { data, error } = await supabase.from('schedule_proposals').select('id').eq('status', 'pending')
    if (!error && data) setRows(data)
  }, [lead])
  useEffect(() => {
    if (!lead) return
    reload()
    const ch = supabase.channel('proposals-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_proposals' }, reload).subscribe()
    const t = setInterval(reload, 30000)
    return () => { clearInterval(t); supabase.removeChannel(ch) }
  }, [lead, reload])
  return { count: rows.length, reload }
}

/* ask for (or, for admin, make) a change to one medication */
export function ChangeForm({ med, rid, me, paused, onDone, onCancel }) {
  const isAdmin = me.role === 'admin'
  const kinds = med.is_prn ? ['change_dose', 'stop']
    : paused ? ['resume', 'change_time', 'change_dose', 'stop']
    : ['change_time', 'change_dose', 'pause', 'stop']
  const current = (med.schedule_times || []).map(s => s.time_of_day.slice(0, 5)).sort().join(', ')
  const [kind, setKind] = useState(kinds[0])
  const [times, setTimes] = useState(current)
  const [dose, setDose] = useState('')
  const [until, setUntil] = useState('')
  const [reason, setReason] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async e => {
    e.preventDefault(); setBusy(true); setErr('')
    const payload = kind === 'change_time' ? { times: times.split(',').map(s => s.trim()).filter(Boolean) }
      : kind === 'change_dose' ? { dose_text: dose }
      : kind === 'pause' ? { until: until ? new Date(until).toISOString() : null } : {}
    const { data, error } = await supabase.rpc('propose_change', {
      p_resident: rid, p_medication: med.id, p_kind: kind, p_payload: payload,
      p_reason: reason, p_urgent: urgent && !isAdmin && kind !== 'resume',
    })
    setBusy(false)
    if (error) setErr(clean(error.message)); else onDone(RESULT[data] || String(data))
  }

  return (
    <form className="card fields change" onSubmit={submit}>
      {err && <p className="err" role="alert">{err}</p>}
      <label>What to change
        <select value={kind} onChange={e => { setKind(e.target.value); if (e.target.value === 'resume') setUrgent(false) }}>
          {kinds.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select></label>
      {kind === 'change_time' && <label>New times<input value={times} required placeholder="07:30, 19:30" onChange={e => setTimes(e.target.value)} /></label>}
      {kind === 'change_dose' && <label>New dose<input value={dose} required placeholder={med.dose_text} onChange={e => setDose(e.target.value)} /></label>}
      {kind === 'pause' && <label>Pause until (optional)<input type="datetime-local" value={until} onChange={e => setUntil(e.target.value)} /></label>}
      <label>Reason<input value={reason} required placeholder="Why is this needed?" onChange={e => setReason(e.target.value)} /></label>
      {!isAdmin && kind !== 'resume' && (
        <label className="check"><input type="checkbox" checked={urgent} onChange={e => setUrgent(e.target.checked)} />
          <span>Urgent: put the next dose on hold until someone decides</span></label>
      )}
      <div className="acts">
        <button className="btn" disabled={busy}>{busy ? 'Sending…' : isAdmin ? 'Apply change' : 'Send request'}</button>
        <button type="button" className="btn quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

/* ask for a brand-new medication (admin adds directly on the Medications tab) */
export function NewMedRequest({ rid, onDone }) {
  const blank = { drug: '', dose: '', times: '', prn: false, crit: false, reason: '' }
  const [f, setF] = useState(blank)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const submit = async e => {
    e.preventDefault(); setBusy(true); setErr('')
    const { data, error } = await supabase.rpc('propose_change', {
      p_resident: rid, p_medication: null, p_kind: 'add', p_reason: f.reason, p_urgent: false,
      p_payload: { drug_name: f.drug, dose_text: f.dose, is_prn: f.prn, time_critical: f.crit,
        times: f.prn ? [] : f.times.split(',').map(s => s.trim()).filter(Boolean) },
    })
    setBusy(false)
    if (error) setErr(clean(error.message)); else { setF(blank); onDone(RESULT[data] || String(data)) }
  }
  return (
    <form className="card fields" onSubmit={submit}>
      <h2>Request a new medication</h2>
      {err && <p className="err" role="alert">{err}</p>}
      <label>Medication<input value={f.drug} required onChange={e => setF({ ...f, drug: e.target.value })} /></label>
      <label>Dose<input value={f.dose} required placeholder="e.g. 5 mg" onChange={e => setF({ ...f, dose: e.target.value })} /></label>
      <label>Times<input value={f.times} disabled={f.prn} placeholder="08:00, 20:00" onChange={e => setF({ ...f, times: e.target.value })} /></label>
      <label><span>As needed (PRN)</span><input type="checkbox" checked={f.prn} onChange={e => setF({ ...f, prn: e.target.checked })} /></label>
      <label><span>Time-critical</span><input type="checkbox" checked={f.crit} onChange={e => setF({ ...f, crit: e.target.checked })} /></label>
      <label>Reason<input value={f.reason} required placeholder="e.g. new prescription from the doctor" onChange={e => setF({ ...f, reason: e.target.value })} /></label>
      <button className="btn" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
    </form>
  )
}

/* supervisor + admin: decide waiting requests */
export function Approvals({ me, onChange }) {
  const [pending, setPending] = useState([])
  const [recent, setRecent] = useState([])
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [rej, setRej] = useState(null) // { id, note }
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    const sel = '*, residents(full_name, room), proposer:profiles!proposed_by(full_name), decider:profiles!decided_by(full_name)'
    const [p, r] = await Promise.all([
      supabase.from('schedule_proposals').select(sel).eq('status', 'pending').order('created_at'),
      supabase.from('schedule_proposals').select(sel).neq('status', 'pending').order('decided_at', { ascending: false }).limit(15),
    ])
    const e = p.error || r.error
    if (e) { setErr(e.message); return }
    setErr('')
    setPending([...p.data].sort((a, b) => Number(b.urgent) - Number(a.urgent)))
    setRecent(r.data)
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const decide = async (id, approve, note) => {
    setBusy(id); setMsg(''); setErr('')
    const { data, error } = await supabase.rpc('decide_proposal', { p_id: id, p_approve: approve, p_note: note || null })
    setBusy('')
    if (error) setErr(clean(error.message))
    else if (data !== 'OK') setMsg('Already decided: ' + clean(data))
    else setRej(null)
    load(); if (onChange) onChange()
  }

  return (
    <>
      <h1>Approvals</h1>
      <p className="sub">Requests from the team to change medications. Urgent ones have the next dose on hold.</p>
      {err && <p className="err" role="alert">{err}</p>}
      {msg && <p className="err" role="status">{msg}</p>}
      {pending.length === 0 && <div className="card"><p className="empty">Nothing waiting. All requests are decided.</p></div>}

      {pending.map(p => {
        const own = p.proposed_by === me.id
        const needsAdmin = ['stop', 'add'].includes(p.kind) && me.role !== 'admin'
        const blocked = own ? 'This is your own request, so someone else must decide it.'
          : needsAdmin ? 'Only an admin can decide this kind of request.' : ''
        return (
          <div key={p.id} className={`req${p.urgent ? ' req-urgent' : ''}`}>
            <div className="req-main">
              <p className="req-sum">
                {p.urgent && <span className="tag hot">Urgent</span>}
                {['stop', 'add'].includes(p.kind) && <span className="tag">Admin decides</span>}
                {p.summary.charAt(0).toUpperCase() + p.summary.slice(1)}
              </p>
              <p className="req-meta">{p.residents?.full_name}{p.residents?.room && ` (Room ${p.residents.room})`} · asked by {p.proposer?.full_name ?? 'a colleague'} · {fmt(p.created_at)}</p>
              <p className="req-meta">Reason: {p.reason}</p>
              {p.held_dose_event_id && <p className="req-meta">The next dose is on hold until this is decided.</p>}
              {blocked && <p className="req-meta">{blocked}</p>}
            </div>
            <div className="req-actions">
              {rej?.id === p.id ? (
                <>
                  <input aria-label="Reason for rejecting" placeholder="Why are you rejecting it?" value={rej.note} onChange={e => setRej({ ...rej, note: e.target.value })} />
                  <button className="btn" disabled={!rej.note.trim() || busy === p.id} onClick={() => decide(p.id, false, rej.note)}>Confirm reject</button>
                  <button className="btn quiet" onClick={() => setRej(null)}>Back</button>
                </>
              ) : (
                <>
                  <button className="btn" disabled={!!blocked || busy === p.id} onClick={() => decide(p.id, true)}>Approve</button>
                  <button className="btn quiet" disabled={!!blocked || busy === p.id} onClick={() => setRej({ id: p.id, note: '' })}>Reject</button>
                </>
              )}
            </div>
          </div>
        )
      })}

      {recent.length > 0 && (
        <div className="card">
          <h2>Recently decided</h2>
          {recent.map(p => (
            <div className="row" key={p.id}>
              <span className={`tag ${p.status === 'approved' ? 'ok' : ''}`}>{p.status}</span>
              <span className="name">{p.summary}</span>
              <span className="meta">{p.residents?.full_name} · {p.auto_applied ? 'applied by admin' : `by ${p.decider?.full_name ?? '—'}`} · {fmt(p.decided_at)}{p.decision_note && ` · ${p.decision_note}`}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
