import {useState} from 'react'
import {supabase as db} from './supabase'
import {fillMissingBudgets,missingBudget} from './importBudget'
type Lead={id:string;budget:string;updated_at:string;imported_fields?:Record<string,unknown>}
export default function LeadBudgetEditor({leads,selected,onSaved}:{leads:Lead[];selected:string[];onSaved:()=>Promise<void>}){
 const [min,setMin]=useState(''),[max,setMax]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
 const chosen=new Set(selected),scope=selected.length?leads.filter(l=>chosen.has(l.id)):leads
 const missing=scope.filter(l=>missingBudget(l.budget))
 async function apply(){setMessage('');setBusy(true);try{
  const updates=fillMissingBudgets(missing,min,max)
  if(!confirm(`Fill ${updates.length} missing budgets in ${selected.length?'selected':'filtered'} leads with random admin estimates between ₹${min}–${max} lakh? Existing budgets stay unchanged.`))return
  const {data,error}=await db.rpc('crm_fill_missing_budgets',{p_updates:updates.map(l=>({id:l.id,updated_at:l.updated_at,budget:l.budget,range:`${min}–${max}`}))})
  if(error)throw error
  await onSaved();setMessage(`${data.updated} budgets saved. ${data.skipped} skipped because the lead changed or is unavailable. Existing budgets were preserved.`)
 }catch(e){setMessage(e instanceof Error?e.message:String((e as {message?:string})?.message||e))}finally{setBusy(false)}}
 return <details className="budget-disclosure"><summary><strong>Add missing budgets · {missing.length} {selected.length?'selected':'filtered'} leads</strong></summary><p>Uses {selected.length?'selected leads in the current list':'all leads matching your current filters'}. Only blank budgets are filled, in ₹10 lakh steps (60, 70, 80, 90). Values are marked as random admin estimates.</p><div className="actions"><label>Minimum (₹ lakh)<input type="number" min="0.01" step="0.01" value={min} disabled={busy} onChange={e=>setMin(e.target.value)} placeholder="60"/></label><label>Maximum (₹ lakh)<input type="number" min="0.01" step="0.01" value={max} disabled={busy} onChange={e=>setMax(e.target.value)} placeholder="90"/></label><button disabled={busy||!missing.length||missing.length>5000} onClick={()=>void apply()}>{busy?'Saving budgets…':`Fill ${missing.length} missing budgets`}</button></div>{missing.length>5000&&<p>Select up to 5,000 missing budgets at a time.</p>}<small>For one lead, click its budget or open its details to enter a budget manually.</small>{message&&<p role="status">{message}</p>}</details>
}
