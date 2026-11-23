import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import './vitals.css'

const TZ = 'Asia/Kolkata' // matches facility_tz() in the database
const fmt = ts => ts ? new Date(ts).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
const clean = m => String(m || '').replace(/^[A-Z_]+:\s*/, '')
const toLocalInput = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
const isLead = me => me.role === 'admin' || me.role === 'supervisor'
const num = s => (s === '' || s == null || Number.isNaN(Number(s))) ? null : Number(s)
const show = x => x == null ? '' : String(x)

const ORDER = ['systolic', 'diastolic', 'heart_rate', 'temperature', 'spo2', 'glucose']
const NAME = { systolic: 'Systolic (top BP)', diastolic: 'Diastolic (bottom BP)', heart_rate: 'Pulse', temperature: 'Temperature', spo2: 'Oxygen (SpO2)', glucose: 'Blood sugar' }
const UNIT = { systolic: 'mmHg', diastolic: 'mmHg', heart_rate: 'bpm', temperature: '°C', spo2: '%', glucose: 'mg/dL' }
const RESULT = {
  OK: 'Saved. All readings are in range.',
  FLAGGED: 'Saved. Some readings are outside the normal range and are marked in the history.',
  CRITICAL: 'Saved. A reading is critical, so an urgent alert went to the supervisor.',
}

/* How bad is one stored flag? '' = fine, 'warn' = outside range, 'crit' = critical.
   Tolerant on purpose: the flags column can be a string, an object or a list per vital. */
export function levelOf(v, key) {
  let f = v?.flags?.[key]
  if (Array.isArray(v?.flags)) f = v.flags.find(x => x && (x.vital === key || x.name === key))
  if (f == null || f === false) return ''
  const s = typeof f === 'object' ? JSON.stringify(f) : String(f)
  if (/^(false|ok|normal|in_range)$/i.test(s)) return ''
  return /crit/i.test(s) ? 'crit' : 'warn'
}
const worst = (...l) => l.includes('crit') ? 'crit' : l.includes('warn') ? 'warn' : ''

/* one reading row -> short coloured chips, used here and on the Floor screen */
export function readings(v, units = {}) {
  const u = k => units[k] ?? UNIT[k]
  const out = []
  if (v.systolic != null || v.diastolic != null)
    out.push({ key: 'bp', label: 'BP', text: `${v.systolic ?? '?'}/${v.diastolic ?? '?'} ${u('systolic')}`, level: worst(levelOf(v, 'systolic'), levelOf(v, 'diastolic')) })
  if (v.heart_rate != null) out.push({ key: 'hr', label: 'Pulse', text: `${v.heart_rate} ${u('heart_rate')}`, level: levelOf(v, 'heart_rate') })
  if (v.temperature != null) out.push({ key: 'temp', label: 'Temp', text: `${v.temperature} ${u('temperature')}`, level: levelOf(v, 'temperature') })
  if (v.spo2 != null) out.push({ key: 'spo2', label: 'SpO2', text: `${v.spo2}${u('spo2')}`, level: levelOf(v, 'spo2') })
  if (v.glucose != null) out.push({ key: 'glu', label: 'Sugar', text: `${v.glucose} ${u('glucose')}`, level: levelOf(v, 'glucose') })
  if (v.weight_kg != null) out.push({ key: 'wt', label: 'Weight', text: `${v.weight_kg} kg`, level: '' })
  return out
}
export const Chips = ({ v, units }) => (
  <span className="vt-vals">
    {readings(v, units).map(r => <span key={r.key} className={`vt-val ${r.level}`}>{r.label} {r.text}</span>)}
  </span>
)

/* ---------- main screen ---------- */
export function Vitals({ me }) {
  const lead = isLead(me)
  const blank = () => ({ systolic: '', diastolic: '', heart_rate: '', temperature: '', spo2: '', glucose: '', weight: '', note: '', taken: toLocalInput(new Date()) })
  const [res, setRes] = useState([])
  const [rid, setRid] = useState('')
  const [view, setView] = useState('readings')
  const [rows, setRows] = useState([])
  const [defaults, setDefaults] = useState({})   // vital -> default range row
  const [overrides, setOverrides] = useState({}) // vital -> this resident's range row
  const [f, setF] = useState(blank)
  const [voidIt, setVoidIt] = useState(null)     // { id, reason }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')

  useEffect(() => {
    supabase.from('residents').select('id, full_name, room').eq('active', true).order('full_name')
      .then(({ data }) => { setRes(data || []); if (data?.[0]) setRid(data[0].id) })
  }, [])

  const loadDefaults = useCallback(async () => {
    const { data } = await supabase.from('vital_ranges').select('*')
    if (data) setDefaults(Object.fromEntries(data.map(r => [r.vital, r])))
  }, [])
  useEffect(() => { loadDefaults() }, [loadDefaults])

  const load = useCallback(async () => {
    if (!rid) return
    const [v, o] = await Promise.all([
      supabase.from('vitals').select('*, who:profiles!recorded_by(full_name)').eq('resident_id', rid)
        .order('taken_at', { ascending: false }).limit(60),
      supabase.from('resident_vital_ranges').select('*').eq('resident_id', rid),
    ])
    if (v.error) { setErr(clean(v.error.message)); return }
    setRows(v.data)
    if (o.data) setOverrides(Object.fromEntries(o.data.map(r => [r.vital, r])))
  }, [rid])
  useEffect(() => { setRows([]); setOverrides({}); setVoidIt(null); setOk(''); setErr(''); load() }, [load])

  const units = Object.fromEntries(Object.values(defaults).map(r => [r.vital, r.unit]))
  const range = k => {
    const d = defaults[k], o = overrides[k]
    if (!d && !o) return null
    return { low: o?.low ?? d?.low, high: o?.high ?? d?.high, own: !!o }
  }

  const submit = async e => {
    e.preventDefault(); setErr(''); setOk('')
    const n = k => num(f[k])
    const vals = ['systolic', 'diastolic', 'heart_rate', 'temperature', 'spo2', 'glucose', 'weight'].map(n)
    if (vals.every(x => x === null)) return setErr('Enter at least one reading.')
    if ((n('systolic') === null) !== (n('diastolic') === null)) return setErr('Blood pressure needs both numbers, top and bottom.')
    setBusy(true)
    const { data, error } = await supabase.rpc('record_vitals', {
      p_resident: rid, p_taken_at: new Date(f.taken).toISOString(),
      p_systolic: n('systolic'), p_diastolic: n('diastolic'), p_heart_rate: n('heart_rate'),
      p_temperature: n('temperature'), p_spo2: n('spo2'), p_glucose: n('glucose'),
      p_weight: n('weight'), p_note: f.note.trim() || null,
    })
    setBusy(false)
    if (error) return setErr(clean(error.message))
    if (!RESULT[data]) return setErr(clean(data))
    setOk(RESULT[data]); setF(blank()); load()
  }

  const doVoid = async () => {
    setErr(''); setOk('')
    const { data, error } = await supabase.rpc('void_vitals', { p_id: voidIt.id, p_reason: voidIt.reason.trim() })
    if (error) setErr(clean(error.message))
    else if (data !== 'OK') setErr(clean(data))
    else { setOk('Entry voided. It stays in the history, marked as voided.'); setVoidIt(null) }
    load()
  }

  const now = new Date()
  const field = (k, label, extra = {}) => {
    const r = range(k)
    return (
      <label className="vt-lab" key={k}>{label}
        <input type="number" inputMode="decimal" step="any" value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} {...extra} />
        {r && r.low != null && <small>{r.own ? 'This resident: ' : 'Normal: '}{r.low} to {r.high} {units[k] ?? UNIT[k]}</small>}
      </label>
    )
  }
  const lbl = k => defaults[k]?.label ?? NAME[k]

  return (
    <>
      <h1>Vitals</h1>
      <p className="sub">Record readings and check each resident’s history. Wrong entries are voided, never edited.</p>
      {err && <p className="err" role="alert">{err}</p>}
      {ok && <p className="ok" role="status">{ok}</p>}

      <p><label>Resident{' '}
        <select value={rid} onChange={e => setRid(e.target.value)}>
          {res.map(r => <option key={r.id} value={r.id}>{r.full_name}{r.room ? ` (Room ${r.room})` : ''}</option>)}
        </select></label></p>
      {res.length === 0 && <div className="card"><p className="empty">No residents to show yet.</p></div>}

      {lead && rid && (
        <div className="vt-seg" role="group" aria-label="Vitals view">
          <button className="btn quiet" aria-pressed={view === 'readings'} onClick={() => setView('readings')}>Readings</button>
          <button className="btn quiet" aria-pressed={view === 'ranges'} onClick={() => setView('ranges')}>Normal ranges</button>
        </div>
      )}

      {rid && view === 'readings' && (
        <>
          <form className="card" onSubmit={submit}>
            <h2>New reading</h2>
            <div className="vt-grid">
              {field('systolic', lbl('systolic'))}
              {field('diastolic', lbl('diastolic'))}
              {field('heart_rate', lbl('heart_rate'))}
              {field('temperature', lbl('temperature'))}
              {field('spo2', lbl('spo2'))}
              {field('glucose', lbl('glucose'))}
              <label className="vt-lab">Weight (kg)
                <input type="number" inputMode="decimal" step="any" value={f.weight} onChange={e => setF({ ...f, weight: e.target.value })} /></label>
              <label className="vt-lab">Taken at
                <input type="datetime-local" value={f.taken} required
                  min={toLocalInput(new Date(now.getTime() - 48 * 36e5))} max={toLocalInput(now)}
                  onChange={e => setF({ ...f, taken: e.target.value })} />
                <small>Up to 48 hours back.</small></label>
            </div>
            <label className="vt-lab">Note (optional)
              <input value={f.note} placeholder="e.g. measured after a walk" onChange={e => setF({ ...f, note: e.target.value })} /></label>
            <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save reading'}</button>
          </form>

          <div className="card">
            <h2>History</h2>
            {rows.length === 0 && <p className="empty">No readings yet for this resident. Add the first one above.</p>}
            {rows.map(v => {
              const gone = !!v.voided_at
              const top = v.critical ? 'crit' : v.flagged ? 'warn' : ''
              return (
                <div key={v.id} className={`vt-item${gone ? ' gone' : ''}`}>
                  <div className="vt-head">
                    <strong>{fmt(v.taken_at)}</strong>
                    <span className="meta">by {v.who?.full_name ?? 'a colleague'}</span>
                    {!gone && top === 'crit' && <span className="tag hot">Critical</span>}
                    {!gone && top === 'warn' && <span className="tag vt-warn">Out of range</span>}
                    {gone && <span className="tag">Voided</span>}
                  </div>
                  <Chips v={v} units={units} />
                  {v.note && <p className="meta">Note: {v.note}</p>}
                  {gone && <p className="meta">Voided {fmt(v.voided_at)}{v.void_reason && `: ${v.void_reason}`}</p>}
                  {!gone && (voidIt?.id === v.id ? (
                    <div className="acts">
                      <input aria-label="Reason for voiding" placeholder="Why is this entry wrong?" value={voidIt.reason}
                        onChange={e => setVoidIt({ ...voidIt, reason: e.target.value })} />
                      <button className="btn" disabled={!voidIt.reason.trim()} onClick={doVoid}>Confirm void</button>
                      <button className="btn quiet" onClick={() => setVoidIt(null)}>Cancel</button>
                    </div>
                  ) : <div className="acts"><button className="btn quiet" onClick={() => setVoidIt({ id: v.id, reason: '' })}>Void</button></div>)}
                </div>
              )
            })}
          </div>
        </>
      )}

      {rid && view === 'ranges' && lead && (
        <Ranges me={me} rid={rid} resName={res.find(r => r.id === rid)?.full_name}
          defaults={defaults} overrides={overrides} lbl={lbl} units={units}
          reload={async () => { await loadDefaults(); await load() }} />
      )}
    </>
  )
}

/* ---------- normal ranges (admin: defaults, supervisor + admin: per resident) ---------- */
function Ranges({ me, rid, resName, defaults, overrides, lbl, units, reload }) {
  const admin = me.role === 'admin'
  const [d, setD] = useState({})
  const [o, setO] = useState({})
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => {
    setD(Object.fromEntries(ORDER.map(k => [k, { crit_low: show(defaults[k]?.crit_low), low: show(defaults[k]?.low), high: show(defaults[k]?.high), crit_high: show(defaults[k]?.crit_high) }])))
  }, [defaults])
  useEffect(() => {
    setO(Object.fromEntries(ORDER.map(k => [k, { low: show(overrides[k]?.low), high: show(overrides[k]?.high) }])))
  }, [overrides, rid])

  const rpc = async (key, fn, args, done) => {
    setBusy(key); setErr(''); setOk('')
    const { data, error } = await supabase.rpc(fn, args)
    setBusy('')
    if (error) setErr(clean(error.message))
    else if (data && data !== 'OK') setErr(clean(data))
    else { setOk(done); await reload() }
  }

  const saveDefault = k => {
    const x = d[k]
    const four = [num(x.crit_low), num(x.low), num(x.high), num(x.crit_high)]
    const set = four.filter(v => v !== null)
    if (set.some((v, i) => i > 0 && v < set[i - 1])) return setErr(`${lbl(k)}: the numbers must go from lowest to highest (critical low, low, high, critical high).`)
    if (four[1] !== null && four[2] !== null && four[1] >= four[2]) return setErr(`${lbl(k)}: low must be below high.`)
    rpc(k, 'set_default_range', { p_vital: k, p_low: four[1], p_high: four[2], p_crit_low: four[0], p_crit_high: four[3] },
      `${lbl(k)} default saved. It applies to new readings only; earlier flags stay as recorded.`)
  }
  const saveOwn = k => {
    const lo = num(o[k].low), hi = num(o[k].high)
    if (lo === null || hi === null) return setErr(`${lbl(k)}: enter both a low and a high.`)
    if (lo >= hi) return setErr(`${lbl(k)}: low must be below high.`)
    rpc(k, 'set_resident_range', { p_resident: rid, p_vital: k, p_low: lo, p_high: hi },
      `${lbl(k)} range saved for ${resName}. It applies to new readings only.`)
  }
  const clearOwn = k => rpc(k, 'clear_resident_range', { p_resident: rid, p_vital: k },
    `${resName} now uses the default for ${lbl(k)}.`)

  const inp = (state, set, k, field, label) => (
    <input type="number" step="any" aria-label={`${label} for ${lbl(k)}`} value={state[k]?.[field] ?? ''}
      onChange={e => set({ ...state, [k]: { ...state[k], [field]: e.target.value } })} />
  )

  return (
    <>
      {err && <p className="err" role="alert">{err}</p>}
      {ok && <p className="ok" role="status">{ok}</p>}

      <div className="card">
        <h2>Ranges for {resName}</h2>
        <p className="meta">Leave blank to use the default. Critical limits always come from the defaults.</p>
        {ORDER.map(k => (
          <div className="vt-range" key={k}>
            <strong>{lbl(k)}</strong>
            <span className="meta">Default {show(defaults[k]?.low)} to {show(defaults[k]?.high)} {units[k] ?? UNIT[k]}</span>
            <span className="vt-inputs">
              {inp(o, setO, k, 'low', 'Low')}
              {inp(o, setO, k, 'high', 'High')}
              <button className="btn" disabled={busy === k} onClick={() => saveOwn(k)}>Save</button>
              {overrides[k] && <button className="btn quiet" disabled={busy === k} onClick={() => clearOwn(k)}>Use default</button>}
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Default ranges for everyone</h2>
        {!admin && <p className="meta">Only an admin can change these.</p>}
        {ORDER.map(k => (
          <div className="vt-range" key={k}>
            <strong>{lbl(k)} <span className="meta">({units[k] ?? UNIT[k]})</span></strong>
            <span className="vt-inputs vt-four">
              {['crit_low', 'low', 'high', 'crit_high'].map(fld => (
                <label key={fld} className="vt-mini">{{ crit_low: 'Critical low', low: 'Low', high: 'High', crit_high: 'Critical high' }[fld]}
                  <input type="number" step="any" disabled={!admin} value={d[k]?.[fld] ?? ''}
                    aria-label={`${{ crit_low: 'Critical low', low: 'Low', high: 'High', crit_high: 'Critical high' }[fld]} default for ${lbl(k)}`}
                    onChange={e => setD({ ...d, [k]: { ...d[k], [fld]: e.target.value } })} /></label>
              ))}
              {admin && <button className="btn" disabled={busy === k} onClick={() => saveDefault(k)}>Save</button>}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
