import {useEffect,useState} from 'react'
import {supabase as db} from './supabase'
type Caller={id:string;display_name:string;active:boolean;role:string}
type Schedule={id:string;name:string;caller_id:string;status:string;batch_size:number;interval_seconds:number;next_at:string;work_start:string|null;work_end:string|null;counts:Record<string,number>}
const date=(v:string)=>new Date(v).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})
export default function AssignmentSchedules({ids,callers,initialCaller,onCreated,onChanged}:{ids:string[];callers:Caller[];initialCaller:string;onCreated:()=>void;onChanged:()=>void}){
 const [list,setList]=useState<Schedule[]>([]),[name,setName]=useState('Lead assignment'),[caller,setCaller]=useState(initialCaller==='unassigned'?'':initialCaller)
 const [mode,setMode]=useState('interval'),[batch,setBatch]=useState(1),[hours,setHours]=useState(2),[start,setStart]=useState(''),[working,setWorking]=useState(true),[from,setFrom]=useState('10:00'),[to,setTo]=useState('19:00')
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('')
 const [details,setDetails]=useState<{position:number;status:string;released_at:string|null;reason:string|null;leads:{customer_name:string}|null}[]>([]),[opened,setOpened]=useState('')
 async function load(){const {data,error}=await db.rpc('crm_assignment_summaries');if(error)throw error;setList(data||[])}
 async function run(fn:()=>Promise<void>){setBusy(true);setMessage('');try{await fn()}catch(e){setMessage(e&&typeof e==='object'&&'message'in e?String(e.message):String(e))}finally{setBusy(false)}}
 useEffect(()=>{void load().catch(e=>setMessage(e.message));const t=setInterval(()=>void load().catch(e=>setMessage(e.message)),30000);return()=>clearInterval(t)},[])
 async function create(){
  await run(async()=>{
   if(!caller)throw Error('Choose a caller.')
   const {error}=await db.rpc('crm_schedule_assignments',{p_ids:ids,p_caller:caller,p_name:name,p_mode:mode,p_batch:batch,p_hours:hours,p_start:start?new Date(start+':00+05:30').toISOString():null,p_work_start:working?from:null,p_work_end:working?to:null})
   if(error)throw error;onCreated();await load();setMessage('Schedule created. Reserved leads appear under Scheduled, not Unassigned, until released.')
  })
 }
 async function control(s:Schedule,action:string){
  if(action==='cancel'&&!confirm('Cancel remaining assignments? Already released leads stay assigned.'))return
  await run(async()=>{const {error}=await db.rpc('crm_control_schedule',{p_id:s.id,p_action:action});if(error)throw error;await load();onChanged();setMessage('Schedule updated.');setOpened('')})
 }
 return <section className="panel"><div className="section-heading"><div><h2>Assignment schedules</h2><p>Release leads automatically, even when the app is closed. Times use IST. Due batches are checked every minute.</p></div><button className="secondary" disabled={busy} onClick={()=>void run(load)}>Refresh</button></div>
 {message&&<p role="status" className="notice">{message}</p>}
 {ids.length>0?<><h3>Schedule {ids.length} selected leads</h3><p>Only your unassigned leads can be scheduled. Each lead can belong to one pending schedule.</p><div className="integration-form-grid">
 <label>Schedule name<input maxLength={150} value={name} onChange={e=>setName(e.target.value)}/></label>
 <label>Caller<select value={caller} onChange={e=>setCaller(e.target.value)}><option value="">Choose caller</option>{callers.filter(c=>c.role==='caller'&&c.active).map(c=><option key={c.id} value={c.id}>{c.display_name}</option>)}</select></label>
 <label>Release mode<select value={mode} onChange={e=>{setMode(e.target.value);setHours(e.target.value==='spread'?24:2)}}><option value="interval">Fixed interval</option><option value="spread">Spread across a duration</option></select></label>
 <label>Leads per batch<input type="number" min={1} max={100} value={batch} onChange={e=>setBatch(Number(e.target.value))}/></label>
 <label>{mode==='spread'?'Spread across (hours)':'Release every (hours)'}<input type="number" min={1} max={744} step={1} value={hours} onChange={e=>setHours(Number(e.target.value))}/></label>
 <label>Start date & time (IST)<input type="datetime-local" value={start} onChange={e=>setStart(e.target.value)}/><small>Leave blank to start at the next available slot.</small></label>
 </div><label className="b2b-check"><input type="checkbox" checked={working} onChange={e=>setWorking(e.target.checked)}/>Only release during working hours, every day</label>
 {working&&<div className="integration-form-grid"><label>From (IST)<input type="time" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>Until (IST)<input type="time" value={to} onChange={e=>setTo(e.target.value)}/></label></div>}
 <p>{mode==='spread'?'The first batch starts at your chosen slot; later batches are evenly spaced across the selected duration. Working hours, pauses or delays may extend the finish time.':'The first batch starts at your chosen slot; later batches wait the selected interval. Overnight releases move to the next opening time.'} No catch-up bursts after a pause.</p>
 <button disabled={busy||!caller||!name.trim()||batch<1||batch>100||hours<1||hours>744||(working&&to<=from)} onClick={()=>void create()}>Create assignment schedule</button></>:<p>Select unassigned leads in All leads, then choose Schedule selected. Use Assign now for immediate assignment.</p>}
 <div className="table-wrap"><table><thead><tr><th>Schedule / caller</th><th>Status</th><th>Progress</th><th>Next release (IST)</th><th>Actions</th></tr></thead><tbody>{list.map(s=><tr key={s.id}><td><strong>{s.name}</strong><small>{callers.find(c=>c.id===s.caller_id)?.display_name||'Caller'} · {s.batch_size} every {(s.interval_seconds/3600).toFixed(2)}h</small>{s.work_start&&<small>{s.work_start.slice(0,5)}–{s.work_end?.slice(0,5)} IST</small>}</td><td>{s.status}</td><td>{['Pending','Assigned','Skipped','Cancelled'].map(status=><small key={status}>{status}: {s.counts[status]||0}</small>)}</td><td>{s.status==='Active'?date(s.next_at):'—'}</td><td><div className="actions">{s.status==='Active'&&<button className="secondary" disabled={busy} onClick={()=>void control(s,'pause')}>Pause</button>}{s.status==='Paused'&&<button className="secondary" disabled={busy} onClick={()=>void control(s,'resume')}>Resume</button>}{['Active','Paused'].includes(s.status)&&<button className="secondary" disabled={busy} onClick={()=>void control(s,'cancel')}>Cancel remaining</button>}<button className="text-button" onClick={()=>void run(async()=>{const {data,error}=await db.from('assignment_items').select('position,status,released_at,reason,leads(customer_name)').eq('schedule_id',s.id).order('position').limit(100);if(error)throw error;setDetails(data as unknown as typeof details);setOpened(s.name)})}>View records</button></div></td></tr>)}</tbody></table></div>
 {opened&&<div><h3>{opened} · first 100 records</h3><div className="table-wrap"><table><thead><tr><th>Position</th><th>Name</th><th>Status</th><th>Released (IST)</th><th>Reason</th></tr></thead><tbody>{details.map(i=><tr key={i.position}><td>{i.position}</td><td>{i.leads?.customer_name||'Deleted lead'}</td><td>{i.status}</td><td>{i.released_at?date(i.released_at):'—'}</td><td>{i.reason||'—'}</td></tr>)}</tbody></table></div></div>}
 {!list.length&&<p>No schedules yet.</p>}
 </section>
}
