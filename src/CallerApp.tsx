import {unlockReminderSound,playReminderSound} from './reminderSound'
import {useEffect,useState,useRef} from 'react'
import {supabase as db} from './supabase'
async function pushApi(body:Record<string,unknown>){const {data,error}=await db.functions.invoke('caller-push',{body});if(error||data?.error)throw Error(data?.error||'Could not update notifications. Check your connection and try again.');return data}
export async function stopDevicePush(){
 if(!('serviceWorker'in navigator))return
 const r=await navigator.serviceWorker.getRegistration('/'),s=await r?.pushManager?.getSubscription()
 if(s){try{await pushApi({action:'unsubscribe',endpoint:s.endpoint})}finally{await s.unsubscribe()}}
}
export default function CallerApp({userId,onOpen,onViewFollowups}:{userId:string;onOpen:(id:string)=>void;onViewFollowups:()=>void}){
 const [message,setMessage]=useState(''),[enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[show,setShow]=useState(false)
 const [sound,setSound]=useState(false),soundRef=useRef(false),seen=useRef<Set<string>|null>(null)
 const [notes,setNotes]=useState<{id:string;lead_id:string;created_at:string;read_at:string|null;kind:string}[]>([])
 useEffect(()=>{
  let stop=false
  if('serviceWorker'in navigator)void navigator.serviceWorker.register('/sw.js').then(async r=>{
   const s=await r.pushManager?.getSubscription();if(s&&'Notification'in window&&Notification.permission==='granted'){await pushApi({action:'subscribe',subscription:s.toJSON()});if(!stop)setEnabled(true)}
  }).catch(()=>{if(!stop)setMessage('Notifications could not connect. Use Enable notifications to retry.')})
  const load=async()=>{const {data,error}=await db.from('crm_assignment_notifications').select('id,lead_id,created_at,read_at,kind').order('created_at',{ascending:false}).limit(30);if(!stop){if(error)setMessage('Could not load lead alerts.');else {const rows=data||[];if(seen.current&&rows.some(n=>n.kind==='follow_up'&&!n.read_at&&!seen.current!.has(n.id))){if(soundRef.current&&document.visibilityState==='visible')playReminderSound();}seen.current=new Set(rows.map(n=>n.id));setNotes(rows)}}}
  void load();const t=setInterval(()=>void load(),30000)
  return()=>{stop=true;clearInterval(t)}
 },[userId])
 async function enable(){
  setBusy(true);setMessage('')
  try{
   if(!('Notification'in window)||!('PushManager'in window)||!('serviceWorker'in navigator))throw Error('This browser cannot enable push here. On iPhone, add AB Estate to your Home Screen using Safari, then open the installed app.')
   const permission=await Notification.requestPermission();if(permission!=='granted')throw Error('Allow notifications in your browser or phone settings, then try again.')
   const {publicKey}=await pushApi({action:'key'});const r=await navigator.serviceWorker.ready
   const key=Uint8Array.from(atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))
   const s=await r.pushManager.getSubscription()||await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key})
   await pushApi({action:'subscribe',subscription:s.toJSON()});setEnabled(true);setMessage('Notifications enabled on this device. Assignments and follow-up reminders will appear here too.')
  }catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
 }
 const followups=notes.filter(n=>n.kind==='follow_up')
 return <section className="caller-alerts compact-followups"><div className="alerts-toolbar"><div className="actions"><button className="secondary" aria-expanded={show} onClick={()=>setShow(!show)}>Follow-ups{followups.filter(n=>!n.read_at).length>0?` (${followups.filter(n=>!n.read_at).length} due)`:''}</button></div></div>{show&&<div className="followup-options"><div className="actions"><button className="secondary" onClick={()=>{setShow(false);onViewFollowups()}}>View all pending follow-ups</button></div><details><summary>Reminder settings</summary><div className="actions"><button disabled={busy} className="secondary" onClick={()=>{if(enabled){setBusy(true);void stopDevicePush().then(()=>{setEnabled(false);setMessage('Notifications disabled on this device.')}).catch(()=>setMessage('Could not disable notifications. Try again.')).finally(()=>setBusy(false))}else void enable()}}>{busy?'Please wait…':enabled?'Disable notifications':'Enable notifications'}</button><button className="secondary" aria-pressed={sound} onClick={()=>{if(sound){soundRef.current=false;setSound(false)}else void unlockReminderSound().then(()=>{soundRef.current=true;setSound(true);setMessage('Chime enabled while this page is open. Background sound and vibration follow your phone settings.')}).catch(()=>setMessage('Sound is unavailable in this browser. Push reminders still work on supported devices.'))}}>{sound?'Mute chime & vibration':'Enable chime & vibration'}</button></div>
 <small>Follow-up reminders arrive at the scheduled time, usually within 1–2 minutes. Enable notifications for alerts when the app is closed. Sound and vibration depend on your device; chime needs enabling each visit.</small></details>
 {message&&<p role="status" className="notice">{message}</p>}
 <div>{followups.length?followups.map(n=><button className="recent-row" key={n.id} onClick={()=>{void db.rpc('crm_read_notification',{p_id:n.id}).then(({error})=>{if(!error)setNotes(old=>old.map(x=>x.id===n.id?{...x,read_at:new Date().toISOString()}:x))});onOpen(n.lead_id)}}><strong>{n.kind==='follow_up'?'Follow-up due':n.read_at?'Lead assigned':'New lead assigned'}</strong><small>{new Date(n.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST</small><span>Open lead →</span></button>):<p>No follow-ups due yet.</p>}</div></div>}
 </section>
}
