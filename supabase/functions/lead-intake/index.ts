import {mapLead,validateMapping} from '../_shared/outbound.ts';
import {createClient} from 'npm:@supabase/supabase-js@2.57.0';
const homes=['https://abestate.netlify.app','https://abestate-crm.netlify.app','https://abestate.vercel.app'];
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get('origin')||'';
 const headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin','Access-Control-Allow-Headers':'content-type,x-integration-key','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
 const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
 const u=new URL(req.url),id=u.searchParams.get('id')||'';
 if(!/^[0-9a-f-]{36}$/i.test(id))return reply({error:'Form unavailable'},404);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const {data:c,error:ce}=await db.from('crm_integrations').select('*').eq('id',id).eq('active',true).maybeSingle();
 if(ce||!c)return reply({error:'Form unavailable'},404);
 const {data:owner}=await db.from('crm_profiles').select('active,role').eq('id',c.owner_id).maybeSingle();
 if(!owner?.active||owner.role!=='admin')return reply({error:'Form unavailable'},404);
 if(c.source==='Website'){
  if(origin&&![...homes,c.website_origin].includes(origin))return reply({error:'Website not allowed'},403);
  if(origin)headers['Access-Control-Allow-Origin']=origin;
 }else if(origin)return reply({error:'Use a server connection for this webhook'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 const {data:settings,error:se}=await db.from('crm_api_settings').select('active').eq('owner_id',c.owner_id).maybeSingle();
 if(se)return reply({error:'Service unavailable'},503);
 if(settings?.active===false)return reply({error:'API service is paused'},503);
 if(req.method==='GET'&&c.source==='Website')return reply({name:c.name});
 if(req.method!=='POST')return reply({error:'Method not allowed'},405);
 if(c.source!=='Website'){
  const key=req.headers.get('x-integration-key')||'';
  if(key.length!==64||await hash(key)!==c.secret_hash)return reply({error:'Invalid integration key'},401);
 }else if(!origin)return reply({error:'Submit this form from the website'},403);
 try{
  // Bounded body reading also protects requests with no Content-Length.
  const reader=req.body?.getReader();if(!reader)return reply({error:'Empty request'},400);
  const chunks:Uint8Array[]=[];let bytes=0;
  while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>16384){await reader.cancel();return reply({error:'Request too large'},413);}chunks.push(value);}
  const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
  const raw=new TextDecoder().decode(body),ct=req.headers.get('content-type')||'';
  let b:Record<string,unknown>;
  if(ct.includes('application/json'))b=JSON.parse(raw);
  else if(ct.includes('application/x-www-form-urlencoded'))b=Object.fromEntries(new URLSearchParams(raw));
  else return reply({error:'Send JSON or URL-encoded form data'},415);
  if(!b||Array.isArray(b)||typeof b!=='object')return reply({error:'Send one lead object per request'},400);
  if(c.source==='Website'&&b.company_website)return reply({ok:true});
  const bucket=c.source==='Website'?'web:':'api:';
  const {data:allowed,error:re}=await db.rpc('crm_intake_rate',{p_bucket:bucket+id,p_max:c.source==='Website'?30:120});
  if(re)throw re;if(!allowed)return reply({error:'Too many submissions. Try again in a minute.'},429);
  if(c.source==='Website'){
   const ip=req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
   const {data:ok,error:e}=await db.rpc('crm_intake_rate',{p_bucket:id+':'+await hash(ip+id),p_max:5});if(e)throw e;if(!ok)return reply({error:'Please wait a minute before submitting again.'},429);
   if(b.consent!==true&&b.consent!=='true'&&b.consent!=='on')return reply({error:'Please agree to be contacted about your enquiry'},400);
  }
  const aliases:Record<string,string[]>={name:['name','full_name','customer_name','NAME'],phone:['phone','phone_number','mobile','mobile_number','PHONE','MOBILE'],email:['email','EMAIL'],budget:['budget','BUDGET'],campaign:['campaign','campaign_name','project','property_id','PROPERTY_ID'],message:['message','remark','query','QUERY'],external_id:['external_id','lead_id','id','LEAD_ID']};
  const lead:Record<string,string>={};
  for(const [key,keys] of Object.entries(aliases)){const mapped=c.source==='Google Sheets'?undefined:c.field_mapping?.[key];const v=mapped?b[mapped]:keys.map(k=>b[k]).find(v=>v!==undefined&&v!==null&&String(v).trim());lead[key]=v==null?'':String(v).trim();}
  if(lead.email==='-')lead.email='';
  let digits=lead.phone.replace(/[^0-9]/g,'');if(digits.length===11&&digits.startsWith('0'))digits=digits.slice(1);if(digits.length===10)digits='91'+digits;
  lead.phone='+'+digits;
  if(!/^[1-9]\d{7,14}$/.test(digits)||!lead.name||lead.name.length>100||lead.email.length>254||lead.budget.length>200||lead.campaign.length>200||lead.message.length>2000||lead.external_id.length>200)return reply({error:'Enter a name and valid phone number; keep other fields within their limits'},400);
  if(lead.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email))return reply({error:'Enter a valid email address'},400);
  let groupId=c.group_id;
  if(c.source==='Google Sheets'&&b.crm_group!==undefined&&b.crm_group!==''){
   if(typeof b.crm_group!=='string'||b.crm_group.length>200)return reply({error:'CRM Group must be an existing group name or ID'},422);
   const group=b.crm_group.trim();
   if(group){
    const byId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(group);
    const {data:groups,error:ge}=await db.from('lead_groups').select('id').eq('owner_id',c.owner_id).eq(byId?'id':'name',group).limit(2);
    if(ge)return reply({error:'Could not check CRM Group; retry later'},503);
    if(groups?.length!==1)return reply({error:'CRM Group not found or ambiguous. Enter an existing exact group name or ID in AB Sources.'},422);
    groupId=groups[0].id;lead._group_id=groupId;
   }
  }
  let entry=null,version=null;
  const {data:groupRule,error:groupRuleError}=await db.from('b2b_group_rules').select('enabled').eq('group_id',groupId).eq('owner_id',c.owner_id).maybeSingle();
  if(groupRuleError)return reply({error:'Group routing unavailable; retry later'},503);
  if(c.b2b_connection_id&&!groupRule?.enabled){
   const {data:out}=await db.from('b2bbricks_connections').select('*').eq('id',c.b2b_connection_id).eq('owner_id',c.owner_id).eq('active',true).eq('archived',false).eq('contract_confirmed',true).maybeSingle();
   if(!out)return reply({error:'B2BBricks routing is paused. Ask the admin to activate its connection; this row will retry.'},503);
   validateMapping(out.mapping);
   const {data:g}=await db.from('lead_groups').select('name').eq('id',groupId).eq('owner_id',c.owner_id).maybeSingle();
   entry=mapLead({customer_name:lead.name,phone_numbers:[lead.phone],email:lead.email,budget:lead.budget,source:c.source,campaign_name:lead.campaign,remark:lead.message,group_name:g?.name||''},out);
   if(entry.error)return reply({error:'B2BBricks mapping: '+entry.error},422);
   version=out.version;
  }
  const {data,error}=await db.rpc('crm_receive_routed_lead',{p_integration:id,p_lead:lead,p_entry:entry,p_version:version});
  if(error)return reply({error:'Import could not finish. Check the group, active caller and B2BBricks settings; this row will retry.'},503);
  // Public submissions never reveal whether a phone already exists in the CRM.
  return reply(c.source==='Website'?{ok:true}:data);
 }catch{return reply({error:'Unable to accept this enquiry. Check the fields or contact the CRM administrator.'},400);}
});
