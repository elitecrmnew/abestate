import {useMemo,useState} from 'react'
import {applyImportMapping,importFields,suggestImportMapping,type Lead} from './extract'
import {importIssues} from './importValidation'
type Props={rows:Lead[];onApply:(leads:Lead[])=>void}
export default function ImportMapper({rows,onApply}:Props){
 const [mapping,setMapping]=useState(()=>suggestImportMapping(rows))
 const [message,setMessage]=useState('')
 const columns=Object.keys(rows[0]?.imported_fields||{})
 const result=useMemo(()=>{
  try{return {leads:applyImportMapping(rows,mapping),error:''}}
  catch(e){return {leads:[] as Lead[],error:e instanceof Error?e.message:String(e)}}
 },[rows,mapping])
 const invalid=result.leads.filter(l=>importIssues(l).length).length
 function apply(){if(!result.leads.length)return;onApply(result.leads);setMessage('Mapping applied. Review all extracted rows below before saving.')}
 return <section className="panel"><div className="section-heading"><div><h2>Map your columns</h2><p>{rows.length} rows detected. Suggestions use column names; review or change every field. Choose Skip for columns you do not need.</p></div><button className="secondary" onClick={()=>{setMapping(suggestImportMapping(rows));setMessage('')}}>Reset suggestions</button></div>
 <div className="table-wrap"><table><thead><tr><th>Your column</th><th>Sample values</th><th>AB Estate field</th></tr></thead><tbody>{columns.map(column=><tr key={column}><td><strong>{column}</strong></td><td>{rows.slice(0,3).map((r,i)=><small key={i}>{String(r.imported_fields?.[column]??'')||'—'}</small>)}</td><td><select aria-label={'Map '+column} value={mapping[column]||''} onChange={e=>{setMapping({...mapping,[column]:e.target.value});setMessage('Mapping changed. Apply again to update the extracted rows.')}}><option value="">Skip this column</option>{importFields.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></td></tr>)}</tbody></table></div>
 <p>Multiple phone columns can be combined, and multiple columns can be appended to Lead Remarks with their original column names. A dash in Email becomes blank. Project is stored as Project / campaign; your B2BBricks connection still sends the lead group name as its project.</p>
 {result.error?<p role="alert" className="notice">{result.error}</p>:<><h3>Mapped preview · first 5 rows</h3><p>{invalid} rows need attention. Invalid and international phone numbers remain visible for correction.</p><div className="table-wrap"><table><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Project / campaign</th><th>Lead Remarks</th></tr></thead><tbody>{result.leads.slice(0,5).map((l,i)=><tr key={i}><td>{l.customer_name||'Missing name'}</td><td>{l.phone_numbers.join(', ')||'Missing phone'}</td><td>{l.email||'—'}</td><td>{l.campaign_name||'—'}</td><td><small>{l.remark||'—'}</small></td></tr>)}</tbody></table></div></>}
 {message&&<p role="status">{message}</p>}<button disabled={!!result.error||!result.leads.length} onClick={apply}>Apply mapping & review {rows.length} leads</button><small>Reapplying replaces unsaved edits in the extracted preview below.</small>
 </section>
}
