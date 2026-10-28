import Papa from 'papaparse'
import {normalizeIndianPhone} from '../supabase/functions/_shared/outbound'
import * as XLSX from 'xlsx'

export type Lead = { source_lead_id: string | null; customer_name: string; budget: string; phone_numbers: string[]; email: string; source: string; campaign_name: string; remark: string; original_lead_date: string | null; imported_fields?: Record<string,unknown> }
type RecordRow = Record<string, unknown>
const normalized = (s: string) => s.replace(/^\uFEFF/, '').replace(/\u00a0/g,' ').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')
const value = (r: RecordRow, keys: string[]) => {
  const entry = Object.entries(r).find(([k,v]) => keys.includes(normalized(k)) && v !== null && v !== undefined && String(v).trim() !== '')
  return entry && !/^[-–—]+$/.test(String(entry[1]).trim()) ? String(entry[1]).trim() : ''
}
const phoneKeys = new Set(['phone','phone_no','phone_number','mobile','mobile_number','whatsapp','whatsapp_number','work_phone','work_phone_number','alternate_phone','contact_number','other_phone'])
const phonesFrom = (r: RecordRow): string[] => {
  const results: string[] = []
  for (const [key, field] of Object.entries(r)) {
    if (!phoneKeys.has(normalized(key)) || field == null) continue
    for (const candidate of String(field).replace(/<br\s*\/?\s*>/gi,';').split(/[;,\n/]/)) {
      const n=normalizeIndianPhone(candidate)
      if(!n && candidate.trim() && !/^[-–—]+$/.test(candidate.trim())){results.push(candidate.trim());continue}
      if(n){const formatted=`+91 ${n.slice(3,8)} ${n.slice(8)}`;if(!results.includes(formatted))results.push(formatted)}
    }
  }
  return results
}
const budgetFormat = (v: string) => {
  if (!v) return ''
  const clean = v.replace(/_/g,' ').replace(/\s+/g,' ').trim()
  const range = clean.match(/^(\d+(?:\.\d+)?)\s*(?:lac|lakh)\s*to\s*(\d+(?:\.\d+)?)\s*(?:lac|lakh)$/i)
  if (range) return `₹${range[1]}–${range[2]} Lakh`
  const single = clean.match(/^(\d+(?:\.\d+)?)\s*(?:lac|lakh)$/i)
  return single ? `₹${single[1]} Lakh` : v
}
const sourceFormat = (v: string) => ({fb:'Facebook',facebook:'Facebook',ig:'Instagram',instagram:'Instagram'}[v.toLowerCase()] || v)
const toLead = (r: RecordRow): Lead => {
  const fullName = value(r,['full_name','fullname','name','customer_name','client_name','contact_name'])
  const name = fullName || [value(r,['first_name']),value(r,['last_name'])].filter(Boolean).join(' ')
  const date = value(r,['created_time','created_at','lead_date'])
  const timestamp = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : date || null
  const budgetKey = Object.keys(r).find(k => normalized(k).includes('budget'))
  const email = value(r,['email','email_address']).replace(/\\@/g,'@')
  return {imported_fields:Object.fromEntries(Object.entries(r).map(([k,v])=>[k,String(v??'')])),source_lead_id:value(r,['id','lead_id'])||null,customer_name:name,budget:budgetFormat(budgetKey ? String(r[budgetKey]??'') : ''),phone_numbers:phonesFrom(r),email,source:sourceFormat(value(r,['platform','source','lead_source'])),campaign_name:value(r,['campaign_name','ad_name','project','project_name']),remark:value(r,['remark','remarks','note','notes','comment','comments']),original_lead_date:timestamp}
}
// Recognize the compact Meta export only when the first row is clearly data.
// Unknown layouts continue to use their first row as headers.
const compactHeaders = ['platform','budget','email','full_name','whatsapp_number','work_phone_number','phone_number']
const rowsFromGrid = (grid: string[][]): RecordRow[] => {
  const rows = grid.filter(row=>row.some(cell=>cell.trim()))
  if (!rows.length) return []
  const first = rows[0].map(cell=>cell.trim())
  const compact = first.length===7 && /^(ig|fb|instagram|facebook)$/i.test(first[0])
    && /^\d+(?:\.\d+)?[ _]*(?:lac|lakh|lacs|lakhs|crore|cr)(?:[ _].*)?$/i.test(first[1])
    && (!first[2] || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(first[2]))
    && !!first[3] && first.slice(4).some(cell=>!!normalizeIndianPhone(cell))
  const used=new Set<string>();
  const headers = (compact ? compactHeaders : first).map((h,i)=>{const base=h||'Column '+(i+1);let key=base,n=2;while(used.has(key))key=base+' ('+(n++)+')';used.add(key);return key})
  return (compact ? rows : rows.slice(1)).map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]??''])))
}
const parseMarkdown = (text: string): RecordRow[] => {
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.startsWith('|') && l.endsWith('|'))
  const grid = lines.map(line=>line.slice(1,-1).split('|').map(x=>x.trim()))
    .filter(row=>!row.every(x=>/^:?-+:?$/.test(x)))
  return rowsFromGrid(grid)
}
export function extractFromText(text: string): Lead[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  let rows: RecordRow[] = []
  if (trimmed.startsWith('|')) rows = parseMarkdown(trimmed)
  else {
    const parsed = Papa.parse<string[]>(trimmed.replace(/^\uFEFF/,''), {header:false,skipEmptyLines:true,delimiter: trimmed.includes('\t') ? '\t' : ''})
    rows = rowsFromGrid(parsed.data)
  }
  return rows.filter(row=>Object.values(row).some(x=>String(x??'').trim())).map(toLead)
}
export async function extractFromFile(file: File): Promise<Lead[]> {
  if (/\.csv$/i.test(file.name)) return extractFromText(await file.text())
  if (!/\.xlsx?$/i.test(file.name)) throw new Error('Upload .csv, .xlsx or .xls')
  const workbook = XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true})
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) return []
  const grid = XLSX.utils.sheet_to_json<string[]>(sheet,{header:1,defval:'',raw:false})
  return rowsFromGrid(grid).map(toLead)
}

export const importFields = [
 ['full_name','Full name'],['first_name','First name'],['last_name','Last name'],
 ['phone','Phone / WhatsApp'],['email','Email'],['campaign_name','Project / campaign'],
 ['budget','Budget'],['source','Source'],['remark','Lead Remarks'],['created_time','Original lead date'],['id','Original lead ID']
] as const
export type ImportMapping = Record<string,string>
export function suggestImportMapping(leads:Lead[]):ImportMapping {
 const columns=Object.keys(leads[0]?.imported_fields||{})
 const aliases:Record<string,string[]>={remark:['remark','remarks','note','notes','comment','comments','work_number','work_phone_number','alternate_phone','alternate_number','other_phone','other_number'],full_name:['full_name','fullname','name','customer_name','client_name','contact_name'],first_name:['first_name'],last_name:['last_name'],email:['email','email_address'],campaign_name:['campaign_name','project','project_name','ad_name'],source:['source','platform','lead_source'],created_time:['created_time','created_at','lead_date'],id:['id','lead_id']}
 return Object.fromEntries(columns.map(column=>{
  const key=normalized(column)
  const field=phoneKeys.has(key)?'phone':key.includes('budget')?'budget':Object.entries(aliases).find(([,names])=>names.includes(key))?.[0]||''
  return [column,field]
 }))
}
export function applyImportMapping(leads:Lead[],mapping:ImportMapping):Lead[] {
 const selected=Object.values(mapping).filter(Boolean)
 if(!selected.includes('full_name')&&!selected.includes('first_name'))throw Error('Map a Full name or First name column.')
 if(!selected.includes('phone'))throw Error('Map at least one Phone / WhatsApp column.')
 for(const field of new Set(selected))if(!['phone','remark'].includes(field)&&selected.filter(x=>x===field).length>1)throw Error('Map only one column to '+(importFields.find(([key])=>key===field)?.[1]||field)+'.')
 return leads.map(lead=>{
  const raw=lead.imported_fields||{},mapped:RecordRow=Object.create(null)
  for(const [column,field] of Object.entries(mapping)){
   if(!field)continue
   const val=String(raw[column]??'').trim()
   if(field==='phone')mapped[field]=[mapped[field],val].filter(Boolean).join(';')
   else if(field==='remark'){if(val&&!/^[-–—]+$/.test(val))mapped[field]=[String(mapped[field]||''),`${column}: ${val}`].filter(Boolean).join('\n')}
   else mapped[field]=val
  }
  return {...toLead(mapped),imported_fields:raw}
 })
}
