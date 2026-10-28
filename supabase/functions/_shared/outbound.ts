export type Mapping={target:string;source:string;value:string;fallback:string;kind:'text'|'name'|'mobile'|'alternate'|'project'|'email'}
export type OutboundLead={id?:string;group_id?:string|null;group_name?:string;source_lead_id?:string|null;customer_name:string;phone_numbers:string[];email:string;budget?:string;source?:string;campaign_name?:string;remark?:string;original_lead_date?:string|null;imported_fields?:Record<string,unknown>}
export type Contract={mapping:Mapping[];default_project:string;default_source:string;default_remark:string;phone_format:'national'|'e164'|'country'}
export function normalizeIndianPhone(input:unknown):string {
 const raw=String(input??'').trim().replace(/^p:\s*/i,'');
 if(!raw||/[a-z]/i.test(raw)||!/^[+\d\s().-]+$/.test(raw))return '';
 let n=raw.replace(/\D/g,'');if(n.startsWith('0091')&&n.length===14)n=n.slice(4);
 else if(n.startsWith('91')&&n.length===12)n=n.slice(2);else if(n.startsWith('0')&&n.length===11)n=n.slice(1);
 return /^[6-9]\d{9}$/.test(n)?'+91'+n:'';
}
export function validateMapping(mapping:unknown,allowIncomplete=false):asserts mapping is Mapping[]{
 if(!Array.isArray(mapping)||(!allowIncomplete&&!mapping.length)||mapping.length>40)throw Error('Add 1–40 field mappings.');
 const seen=new Set<string>();let mobile=0,name=0;
 for(const m of mapping){
  if(!m||typeof m.target!=='string'||(!allowIncomplete&&!m.target.trim())||m.target.length>80||/^(?:__proto__|constructor|prototype)$/.test(m.target)||/[\r\n\0]/.test(m.target))throw Error('Enter a valid destination field for each mapping.');
  if(!allowIncomplete&&seen.has(m.target))throw Error('Destination fields must be unique.');seen.add(m.target);
  if(!['text','name','mobile','alternate','project','email'].includes(m.kind)||typeof m.source!=='string'||typeof m.value!=='string'||typeof m.fallback!=='string'||m.source.length>200||m.value.length>2000||m.fallback.length>2000)throw Error('Invalid field mapping.');
  if(m.kind==='mobile')mobile++;if(m.kind==='name')name++;
 }
 if(!allowIncomplete&&(mobile!==1||name!==1))throw Error('Mark exactly one mapping as Primary mobile and one as Full name.');
}
export function sourceValue(l:OutboundLead,key:string,c:Contract):string{
 if(key.startsWith('raw:'))return String(l.imported_fields?.[key.slice(4)]??'');
 const v:Record<string,unknown>={customer_name:l.customer_name,phone:l.phone_numbers?.[0]||'',alternate_phone:l.phone_numbers?.[1]||'',email:l.email,budget:l.budget,campaign_name:l.campaign_name,group_name:l.group_name,source:l.source,remark:l.remark,source_lead_id:l.source_lead_id,original_lead_date:l.original_lead_date,default_project:c.default_project,default_source:c.default_source,default_remark:c.default_remark};
 return String(v[key]??'');
}
export function mapLead(lead:OutboundLead,c:Contract){
 const payload:Record<string,string>=Object.create(null);let mobile='',name='',error='',project=c.default_project||lead.campaign_name||'',email=lead.email;
 for(const m of c.mapping){
  let value=(m.source==='static'?m.value:sourceValue(lead,m.source,c)).trim()||m.fallback.trim();
  if(m.kind==='mobile'||m.kind==='alternate'){
   const n=normalizeIndianPhone(value);
   if((value||m.kind==='mobile')&&!n)error='Missing or invalid '+(m.kind==='mobile'?'primary':'alternate')+' Indian mobile';
   if(m.kind==='mobile')mobile=n;
   value=n?(c.phone_format==='e164'?n:c.phone_format==='country'?n.slice(1):n.slice(3)):'';
  }
  if(m.kind==='name'){name=value;if(!name||name.length>100)error='Full name is required (maximum 100 characters)';}
  if(m.kind==='project'||m.source==='default_project')project=value;
  if(m.source==='group_name'&&!value)error='Choose a lead group before sending its name as the project';
  if(m.kind==='email'){email=value;if(value&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))error='Invalid email address';}
  if(value.length>2000)error='A mapped field exceeds 2,000 characters';
  payload[m.target]=value;
 }
 return {lead:{...lead,customer_name:name||lead.customer_name,email},mobile,payload,project,error};
}
export function validateDestination(url:string){
 let u:URL;try{u=new URL(url)}catch{throw Error('Enter the exact HTTPS B2BBricks webhook URL.');}
 // Exact provider host prevents arbitrary server requests and credential forwarding.
 if(u.protocol!=='https:'||u.hostname!=='connector.b2bbricks.com'||u.port||u.username||u.password||u.hash||!u.pathname.startsWith('/api/Integration/'))throw Error('Use an HTTPS connector.b2bbricks.com/api/Integration/ webhook URL. Other hosts require a reviewed adapter.');
 return u.toString();
}
export function redactResponse(text:string,url:string,headers:Record<string,string>){
 let s=text;const secrets=[url,...Object.values(headers)];
 try{const u=new URL(url);secrets.push(...u.pathname.split('/').filter(x=>x.length>15),...u.searchParams.values())}catch{}
 for(const v of secrets.filter(v=>v.length>=4))s=s.split(v).join('[REDACTED]');
 s=s.replace(/https?:\/\/[^\s"'<>]+/gi,'[URL REDACTED]').replace(/((?:authorization|api[_-]?key|token|secret|password)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,'$1[REDACTED]');
 return s.slice(0,8000);
}
export function responseAccepted(status:number,text:string,c:{success_codes:number[];success_path:string;success_value:string}){
 if(!c.success_codes.includes(status))return false;
 if(!c.success_path)return true;
 try{let v:unknown=JSON.parse(text);for(const key of c.success_path.split('.')){if(!v||typeof v!=='object')return false;v=(v as Record<string,unknown>)[key]};return String(v)===c.success_value}catch{return false}
}
