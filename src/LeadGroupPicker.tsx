import {useMemo,useState} from 'react'
import {Layers,ArrowUpRight,Phone} from 'lucide-react'
import {groupCards} from './leadGroups'
type Props={groups:{id:string;name:string}[];leads:{group_id:string|null;created_at:string;assigned_at:string|null}[];admin:boolean;value:string;onChange:(id:string)=>void;onDelete?:(id:string)=>Promise<void>;onCreate?:(name:string)=>Promise<void>}
export default function LeadGroupPicker({groups,leads,admin,value,onChange,onCreate,onDelete}:Props){
 const [deleting,setDeleting]=useState(false)
 const [groupSearch,setGroupSearch]=useState('')
 const [creating,setCreating]=useState(false),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const cards=useMemo(()=>groupCards(groups,leads,admin,Date.now(),true),[groups,leads,admin])
 const today=new Date(Date.now()+330*60000).toISOString().slice(0,10)
 const newCount=leads.filter(l=>{const t=Date.parse(admin?l.created_at:l.assigned_at||'');return Number.isFinite(t)&&t<=Date.now()&&new Date(t+330*60000).toISOString().slice(0,10)===today}).length
 return <section className="lead-group-picker" aria-label="Choose lead group"><div className="group-picker-heading"><div><h2>Choose a group</h2><p>All your leads, neatly organized. New activity appears first.</p></div>{onCreate&&<button className="secondary" onClick={()=>{setCreating(!creating);setError('')}} aria-expanded={creating}>+ Create group</button>}</div>
 {admin&&value&&onDelete&&<div className="group-delete-action"><button className="text-button" disabled={deleting} onClick={async()=>{const selected=groups.find(g=>g.id===value);if(!selected||!confirm(`Delete group “${selected.name}”? Its leads will stay in All leads with their caller assignments, remarks and follow-ups. Group automation will be removed. B2BBricks batches already queued will continue.`))return;setDeleting(true);setError('');try{await onDelete(value)}catch(e){setError(e instanceof Error?e.message:'Unable to delete group')}finally{setDeleting(false)}}}>{deleting?'Deleting…':'Delete group · keep leads'}</button></div>}
 {error&&!creating&&<p role="alert" className="notice">{error}</p>}
 {creating&&onCreate&&<form className="create-group-form" onSubmit={async e=>{e.preventDefault();if(!name.trim()||busy)return;setBusy(true);setError('');try{await onCreate(name.trim());setName('');setCreating(false)}catch(e){setError(e instanceof Error?e.message:String((e as {message?:string}).message||e))}finally{setBusy(false)}}}><label>Group name<input autoFocus required maxLength={100} value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Jubilee Imperia"/></label><button disabled={busy||!name.trim()}>{busy?'Creating…':'Create group'}</button><button type="button" className="secondary" disabled={busy} onClick={()=>setCreating(false)}>Cancel</button>{error&&<p role="alert">{error}</p>}</form>}
 {groups.length>6&&<input className="group-search" aria-label="Find a group" placeholder="Find a group…" value={groupSearch} onChange={e=>setGroupSearch(e.target.value)}/>}
 <div className="group-cards"><button className={'group-card all-group '+(!value?'chosen':'')} aria-pressed={!value} onClick={()=>onChange('')}><span className="group-card-icon"><Phone size={20}/></span><strong>All leads</strong><span className="group-card-count">{leads.length} leads</span>{newCount>0&&<span className="new-leads-badge">{newCount} new today</span>}<ArrowUpRight className="group-arrow" size={18}/></button>
 {cards.filter(g=>g.name.toLowerCase().includes(groupSearch.toLowerCase())).map(g=><button key={g.id} className={'group-card '+(value===g.id?'chosen':'')} aria-pressed={value===g.id} onClick={()=>onChange(g.id)}><span className="group-card-icon"><Layers size={20}/></span><strong>{g.name}</strong><span className="group-card-count">{g.total} {g.total===1?'lead':'leads'}</span>{g.newToday>0&&<span className="new-leads-badge">{g.newToday} new today</span>}<ArrowUpRight className="group-arrow" size={18}/></button>)}</div>
 <small className="group-time-note">{admin?'New today = imported today.':'New today = assigned to you today.'} Times follow IST.</small>
 </section>
}
