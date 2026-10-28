import {createClient} from 'npm:@supabase/supabase-js@2.57.0';
import {redactResponse,validateDestination,validateMapping,mapLead,type OutboundLead} from '../_shared/outbound.ts';
const base={'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Vary':'Origin'};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const safe=(c:Record<string,unknown>)=>{const {webhook_url,headers,...rest}=c;return {...rest,has_webhook:!!webhook_url,has_headers:Object.keys((headers||{}) as object).length>0}};

const validClock=(v:unknown)=>typeof v==='string'&&/^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(v);
function scheduleTransfer(entries:any[],schedule:any){
 if(!schedule||schedule.enabled!==true)return entries;
 if(schedule.mode!=='interval'&&schedule.mode!=='spread')throw Error('Choose a valid transfer release mode.');
 const batchSize=Number(schedule.batch_size),hours=Number(schedule.interval_hours);
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100)throw Error('Choose 1–100 leads per transfer batch.');
 if(!Number.isFinite(hours)||hours<1||hours>744)throw Error('Choose a transfer interval/duration from 1 to 744 hours.');
 const work=!!schedule.work_enabled, offset=330*60000;
 let from=0,to=24*60;
 if(work){
  if(!validClock(schedule.work_start)||!validClock(schedule.work_end))throw Error('Choose valid working hours.');
  const parts=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
  from=parts(schedule.work_start);to=parts(schedule.work_end);
  if(to<=from)throw Error('Working-hours end must be after the start.');
 }
 const align=(stamp:number)=>{
  if(!work)return stamp;
  const d=new Date(stamp+offset),mins=d.getUTCHours()*60+d.getUTCMinutes(),y=d.getUTCFullYear(),m=d.getUTCMonth(),day=d.getUTCDate();
  if(mins<from)return Date.UTC(y,m,day,Math.floor(from/60),from%60)-offset;
  if(mins>=to)return Date.UTC(y,m,day+1,Math.floor(from/60),from%60)-offset;
  return stamp;
 };
 let base=schedule.start_at?Date.parse(String(schedule.start_at)):Date.now();
 if(!Number.isFinite(base))throw Error('Choose a valid transfer start time.');
 base=align(Math.max(Date.now(),base));
 const sequence=new Map<number,string>();
 const eligible=entries.map((e,i)=>({e,i})).filter(({e})=>!e.error&&/^\\+91[6-9]\\d{9}$/.test(String(e.mobile||'')));
 const batchCount=Math.max(1,Math.ceil(eligible.length/batchSize));
 const times:string[]=[];
 for(let i=0;i<batchCount;i++){
  const delta=schedule.mode==='interval'?i*hours:(batchCount>1?i*hours/(batchCount-1):0);
  times.push(new Date(align(base+delta*3600000)).toISOString());
 }
 const positions=new Map<number,number>();
 eligible.forEach(({i},n)=>positions.set(i,Math.floor(n/batchSize)));
 return entries.map((e,i)=>({...e,scheduled_at:times[positions.get(i)||0]||new Date(base).toISOString()}));
}
Deno.serve(async(req:Request)=>{
 const headers:Record<string,string>={...base};const origin=req.headers.get('origin')||'';
 if(['https://abestate-crm.netlify.app','https://abestate.vercel.app','https://abestate.netlify.app'].includes(origin))headers['Access-Control-Allow-Origin']=origin;
 const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
 if(req.method==='OPTIONS')return new Response('ok',{headers});if(req.method!=='POST')return reply({error:'Method not allowed'},405);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const {data:{user},error:ae}=await db.auth.getUser((req.headers.get('Authorization')||'').replace(/^Bearer /,''));
 if(ae||!user)return reply({error:'Sign in first'},401);
 const {data:p}=await db.from('crm_profiles').select('role,active').eq('id',user.id).single();if(p?.role!=='admin'||!p.active)return reply({error:'Admin access required'},403);
 const owner=user.id;
 try{
  const reader=req.body?.getReader();if(!reader)return reply({error:'Empty request'},400);let len=0;const chunks:Uint8Array[]=[];
  while(true){const r=await reader.read();if(r.done)break;len+=r.value.length;if(len>6*1024*1024){await reader.cancel();return reply({error:'Send up to 6 MB at a time'},413)}chunks.push(r.value)}
  const bytes=new Uint8Array(len);let pos=0;for(const c of chunks){bytes.set(c,pos);pos+=c.length}
  const b=JSON.parse(new TextDecoder().decode(bytes));

  if(b.action==='group-rules'){
   const {data:rules,error}=await db.from('b2b_group_rules').select('group_id,connection_id,enabled').eq('owner_id',owner);if(error)throw error;
   const {data:connections,error:ce}=await db.from('b2bbricks_connections').select('id,name,active,contract_confirmed').eq('owner_id',owner).eq('archived',false);if(ce)throw ce;
   const {data:jobs,error:je}=await db.from('b2b_group_outbox').select('id,group_id,status,error_message,created_at').eq('owner_id',owner).in('status',['Failed','Pending']).order('created_at',{ascending:false}).limit(100);if(je)throw je;
   return reply({rules,connections,jobs});
  }
  if(b.action==='save-group-rule'){
   if(!uuid(b.group_id)||typeof b.enabled!=='boolean'||(b.enabled&&!uuid(b.connection_id)))throw Error('Choose a group and connection.');
   if(b.enabled){
    const {data:c}=await db.from('b2bbricks_connections').select('mapping').eq('id',b.connection_id).eq('owner_id',owner).single();
    if(!c)throw Error('Connection unavailable.');validateMapping(c.mapping);
    if(!c.mapping.some((m:any)=>m.kind==='project'))throw Error('In B2BBricks field mapping, mark the project field as Project first.');
   }
   const {error}=await db.rpc('b2b_set_group_rule',{p_owner:owner,p_group:b.group_id,p_connection:b.connection_id||null,p_enabled:b.enabled});if(error)throw Error(error.message);
   return reply({ok:true});
  }
  if(b.action==='retry-group-rule'){
   if(!uuid(b.group_id))throw Error('Choose a group.');
   const {data:r}=await db.from('b2b_group_rules').select('connection_id').eq('owner_id',owner).eq('group_id',b.group_id).eq('enabled',true).maybeSingle();if(!r)throw Error('Enable the group automation first.');
   const {error}=await db.from('b2b_group_outbox').update({status:'Pending',error_message:''}).eq('owner_id',owner).eq('group_id',b.group_id).eq('connection_id',r.connection_id).eq('status','Failed');if(error)throw error;
   return reply({ok:true});
  }
  if(b.action==='sample-dump'){
   if(b.confirm_send!==true||!uuid(b.connection_id))throw Error('Confirm one sample and choose a saved connection.');
   const {data:c,error:ce}=await db.from('b2bbricks_connections').select('*').eq('owner_id',owner).eq('id',b.connection_id).eq('archived',false).single();
   if(ce||!c)throw Error('Connection unavailable.');
   if(c.version!==b.version)throw Error('Connection settings changed. Reopen the sample form.');
   const url=validateDestination(c.webhook_url);
   const payload=b.payload;
   if(!payload||Array.isArray(payload)||typeof payload!=='object'||!Object.keys(payload).length||Object.keys(payload).length>40||JSON.stringify(payload).length>16000)throw Error('Enter one sample object, up to 40 fields and 16 KB.');
   for(const [key,value] of Object.entries(payload)){
    if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key)||['__proto__','constructor','prototype'].includes(key)||typeof value!=='string'||value.length>2000)throw Error('Use simple field names and text values of up to 2000 characters.');
   }
   if(!Object.values(payload).some(v=>String(v).trim()))throw Error('Fill in the sample before sending.');
   const {data:allowed,error:rateError}=await db.rpc('crm_intake_rate',{p_bucket:'b2b-sample:'+owner,p_max:5});
   if(rateError)throw Error('Sample service unavailable. Try again later.');
   if(!allowed)return reply({error:'Wait one minute before sending another sample.'},429);
   let http:number|null=null;
   try{
    const encoded=c.content_type==='application/json'?JSON.stringify(c.envelope?{[c.envelope]:payload}:payload):new URLSearchParams(payload).toString();
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
    try{
     const response=await fetch(url,{method:c.method,headers:{...c.headers,'Content-Type':c.content_type},body:encoded,redirect:'manual',signal:controller.signal});
     http=response.status;
     const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let total=0;
     if(reader)while(true){const r=await reader.read();if(r.done)break;total+=r.value.length;if(total>65536){await reader.cancel();throw Error('Large response');}chunks.push(r.value)}
     const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length}
     return reply({http,body:redactResponse(new TextDecoder().decode(result),c.webhook_url,c.headers),message:'One sample request was attempted. Check the B2BBricks HTTP dump to verify receipt; this HTTP response does not confirm CRM lead creation. No AB Estate delivery status was changed.'});
    }finally{clearTimeout(timeout)}
   }catch{return reply({http,body:'',message:'Receipt is uncertain. Check the B2BBricks HTTP dump before resending; the sample may have arrived. No automatic retry was made.'})}
  }

  if(b.action==='lead-tags'){
   const tags:Record<string,{id:string;name:string;sent_at:string|null}[]>={};
   const phoneToLeadIds=new Map<string,string[]>();
   // Include legacy deliveries that predate lead_id tracking by safely matching their mobile.
   for(let start=0;start<100000;start+=1000){
    const {data,error}=await db.from('leads').select('id,phone_numbers').eq('owner_id',owner).order('id').range(start,start+999);
    if(error)throw error;
    for(const lead of data||[]){
     for(const phone of lead.phone_numbers||[]){
      const digits=String(phone||'').replace(/\D/g,'');
      if(digits.length<10)continue;
      const key=digits.slice(-10),ids=phoneToLeadIds.get(key)||[];
      if(!ids.includes(lead.id))ids.push(lead.id);
      phoneToLeadIds.set(key,ids);
     }
    }
    if((data||[]).length<1000)break;
   }
   for(let start=0;start<100000;start+=1000){
    const {data,error}=await db.from('b2bbricks_deliveries').select('lead_id,mobile,connection_id,sent_at,created_at,b2bbricks_connections!inner(id,name)').eq('owner_id',owner).eq('status','Sent').eq('dedupe_exempt',false).order('sent_at',{ascending:false,nullsFirst:false}).order('created_at',{ascending:false}).range(start,start+999);
    if(error)throw error;
    for(const d of data||[]){
     const connection=(Array.isArray(d.b2bbricks_connections)?d.b2bbricks_connections[0]:d.b2bbricks_connections) as {id:string;name:string}|null;
     if(!connection?.id)continue;
     const digits=String(d.mobile||'').replace(/\D/g,'');
     const candidates=digits.length>=10?phoneToLeadIds.get(digits.slice(-10))||[]:[];
     const matchedIds=d.lead_id?[d.lead_id]:(candidates.length===1?candidates:[]);
     for(const leadId of matchedIds){
      const destinations=tags[leadId]||(tags[leadId]=[]);
      if(!destinations.some(item=>item.id===connection.id))destinations.push({id:connection.id,name:connection.name,sent_at:d.sent_at||null});
     }
    }
    if((data||[]).length<1000)break;
   }
   return reply({tags});
  }

  if(b.action==='connections'){
   const {data,error}=await db.from('b2bbricks_connections').select('*').eq('owner_id',owner).eq('archived',false).order('created_at');if(error)throw error;
   return reply({connections:(data||[]).map(safe)});
  }
  if(b.action==='save-connection'){
   const x=b.config;if(!x||typeof x.name!=='string'||!x.name.trim()||x.name.length>100)throw Error('Enter a connection name.');
   let old:any=null;if(b.id){if(!uuid(b.id))throw Error('Invalid connection');const r=await db.from('b2bbricks_connections').select('*').eq('owner_id',owner).eq('id',b.id).eq('archived',false).single();if(r.error)throw Error('Connection unavailable');old=r.data;}
   let template:any=null;
   if(b.duplicate_from){if(b.id||!uuid(b.duplicate_from))throw Error('Invalid duplicate source');const r=await db.from('b2bbricks_connections').select('*').eq('owner_id',owner).eq('id',b.duplicate_from).eq('archived',false).single();if(r.error)throw Error('Original connection unavailable');template=r.data;if(!x.webhook_url?.trim())throw Error('Enter the new webhook URL for this copy.');}
   const url=x.webhook_url?validateDestination(String(x.webhook_url).trim()):old?.webhook_url||'';
   const hs=x.headers===null||x.headers===undefined?old?.headers||template?.headers||{}:x.headers;
   if(!hs||Array.isArray(hs)||typeof hs!=='object'||Object.keys(hs).length>12)throw Error('Headers must be a JSON object with at most 12 entries.');
   for(const [k,v] of Object.entries(hs)){if(!/^[a-zA-Z0-9-]{1,80}$/.test(k)||typeof v!=='string'||v.length>2000||/[\r\n]/.test(v)||/^(host|cookie|set-cookie|content-length|content-type|connection|transfer-encoding|proxy-.+|x-forwarded-.+)$/i.test(k))throw Error('Unsupported header. Configure Content-Type separately.');}
   if(!['POST','PUT'].includes(x.method)||!['application/json','application/x-www-form-urlencoded'].includes(x.content_type)||!['national','country','e164'].includes(x.phone_format))throw Error('Choose the request method, body format and phone format.');
   if(!Array.isArray(x.success_codes)||!x.success_codes.length||!x.success_codes.every((n:unknown)=>Number.isInteger(n)&&Number(n)>=200&&Number(n)<=299))throw Error('Enter the documented successful HTTP status codes.');
   for(const k of ['default_project','default_source','default_remark','envelope','success_path','success_value'])if(typeof x[k]!=='string'||x[k].length>2000)throw Error('Invalid configuration field.');
   if(x.envelope&&(x.content_type!=='application/json'||!/^[a-zA-Z][\w-]{0,79}$/.test(x.envelope)))throw Error('The optional body wrapper needs a simple JSON field name.');
   if(x.success_path&&!/^[\w-]+(?:\.[\w-]+)*$/.test(x.success_path))throw Error('Use a dotted response field path such as data.success.');
   if(!Number.isInteger(x.delay_ms)||x.delay_ms<1000||x.delay_ms>10000)throw Error('Use a delay of 1000–10000 milliseconds.');
   if(!Array.isArray(x.mapping))throw Error('Invalid mapping.');validateMapping(x.mapping,!x.contract_confirmed&&!x.active);
   if(x.contract_confirmed){validateMapping(x.mapping);if(!url)throw Error('Provide the webhook URL before confirming the request contract.');}
   if(x.active&&!x.contract_confirmed)throw Error('Confirm the exact request and success rules before activating.');
   const config={name:x.name.trim(),webhook_url:url,headers:hs,method:x.method,content_type:x.content_type,envelope:x.envelope,success_codes:x.success_codes,success_path:x.success_path,success_value:x.success_value,phone_format:x.phone_format,default_project:x.default_project,default_source:x.default_source,default_remark:x.default_remark,mapping:x.mapping,contract_confirmed:!!x.contract_confirmed,active:!!x.active,delay_ms:x.delay_ms};
   const {data,error}=await db.rpc('b2b_save_connection',{p_owner:owner,p_id:b.id||null,p_expected:b.version||0,p_config:config});if(error)throw Error(error.message);return reply({id:data});
  }
  if(b.action==='toggle'||b.action==='archive'){
   const {data:c,error}=await db.from('b2bbricks_connections').select('id,contract_confirmed,webhook_url').eq('id',b.id).eq('owner_id',owner).single();if(error)throw Error('Connection unavailable.');
   if(b.action==='toggle'&&b.active&&(!c.contract_confirmed||!c.webhook_url))throw Error('Complete and confirm the connection configuration first.');
   if(b.action==='archive'){const {count}=await db.from('b2bbricks_deliveries').select('id',{count:'exact',head:true}).eq('connection_id',c.id).in('status',['Pending','Sending']);if(count)throw Error('Finish or cancel queued batches before deleting this connection.');}
   const {error:e}=await db.from('b2bbricks_connections').update(b.action==='archive'?{archived:true,active:false}:{active:!!b.active}).eq('id',c.id).eq('owner_id',owner);if(e)throw e;return reply({ok:true});
  }
  if(['preview','enqueue','test'].includes(b.action)){
   const {data:c,error:ce}=await db.from('b2bbricks_connections').select('*').eq('owner_id',owner).eq('id',b.connection_id).eq('archived',false).single();if(ce)throw Error('Choose a connection.');
   const mapping=b.mapping||c.mapping;validateMapping(mapping);
   let leads:OutboundLead[]=[];const groupId=b.group_id||null;
   if(groupId){if(!uuid(groupId))throw Error('Invalid group');const {data:g}=await db.from('lead_groups').select('id').eq('id',groupId).eq('owner_id',owner).maybeSingle();if(!g)throw Error('Group unavailable.');}
   if(b.mode==='group'){
    if(!groupId)throw Error('Choose a group.');
    for(let start=0;start<6000;start+=1000){const {data,error}=await db.from('leads').select('*').eq('owner_id',owner).eq('group_id',groupId).order('id').range(start,start+999);if(error)throw error;leads.push(...data);if(data.length<1000)break;}
   }else if(b.mode==='saved'){
    if(!Array.isArray(b.ids)||!b.ids.length||b.ids.length>5000||!b.ids.every(uuid))throw Error('Select 1–5000 saved leads.');
    const ids=[...new Set(b.ids)] as string[];for(let i=0;i<ids.length;i+=200){const {data,error}=await db.from('leads').select('*').eq('owner_id',owner).in('id',ids.slice(i,i+200));if(error)throw error;leads.push(...data)}if(leads.length!==ids.length)throw Error('Some leads are no longer available.');
   }else{
    if(!Array.isArray(b.leads))throw Error('Select imported leads.');
    leads=b.leads.map((l:any)=>{if(!l||typeof l!=='object')throw Error('Invalid imported row');const out:Record<string,unknown>={};for(const k of ['source_lead_id','customer_name','email','budget','source','campaign_name','remark','original_lead_date']){if(l[k]!=null&&typeof l[k]!=='string')throw Error('Invalid imported field');out[k]=l[k]??'';if(String(out[k]).length>5000)throw Error('Imported field is too long');}
     if(!Array.isArray(l.phone_numbers)||l.phone_numbers.length>10||!l.phone_numbers.every((x:unknown)=>typeof x==='string'&&x.length<=80))throw Error('Invalid phone field');out.phone_numbers=l.phone_numbers;
     if(l.imported_fields&&(!l.imported_fields||Array.isArray(l.imported_fields)||typeof l.imported_fields!=='object'||JSON.stringify(l.imported_fields).length>16000))throw Error('Imported columns exceed 16 KB per lead');out.imported_fields=l.imported_fields||{};
     return out as unknown as OutboundLead;});
   }
   if(!leads.length||leads.length>5000)throw Error('Send 1–5000 leads per batch.');if(b.action==='test'&&leads.length!==1)throw Error('Choose one test lead.');
   // Resolve group names from owned database rows, never client-supplied names.
   const savedMode=b.mode==='saved'||b.mode==='group';
   const groupIds=[...new Set(leads.map(l=>savedMode?l.group_id:groupId).filter(Boolean))] as string[];
   const groupNames=new Map<string,string>();
   for(let i=0;i<groupIds.length;i+=200){
    const {data,error}=await db.from('lead_groups').select('id,name').eq('owner_id',owner).in('id',groupIds.slice(i,i+200));
    if(error)throw error;for(const g of data||[])groupNames.set(g.id,g.name);
   }
   leads=leads.map(l=>({...l,group_name:groupNames.get((savedMode?l.group_id:groupId)||'')||''}));
   const entries=leads.map(l=>mapLead(l,{...c,mapping}));
   if(b.action==='preview'){
    const previous:any[]=[];const skipDedupe=!!b.test&&!b.track_test;const mobiles=[...new Set(entries.map(e=>e.mobile).filter(Boolean))];const ids=leads.map(l=>l.id).filter(Boolean) as string[];
    for(const [key,values] of (skipDedupe?[]:[['mobile',mobiles],['lead_id',ids]]) as [string,string[]][]){for(let i=0;i<values.length;i+=100){for(let start=0;;start+=1000){const {data,error}=await db.from('b2bbricks_deliveries').select('id,lead_id,mobile,status,requires_review').eq('connection_id',c.id).eq('dedupe_exempt',false).in(key,values.slice(i,i+100)).or('status.in.(Sent,Pending,Sending),requires_review.eq.true').range(start,start+999);if(error)throw error;previous.push(...data);if(data.length<1000)break;}}}
    const seen=new Set<string>();const result=entries.map((e,index)=>{const matches=previous.filter(d=>d.mobile===e.mobile||(e.lead.id&&d.lead_id===e.lead.id));const blocked=matches.some(d=>d.status!=='Sent'||d.requires_review);const sent=matches.some(d=>d.status==='Sent');const repeated=seen.has(e.mobile);if(e.mobile)seen.add(e.mobile);return {index,name:e.lead.customer_name,mobile:e.mobile,payload:e.payload,error:e.error,already_sent:sent,status:e.error?'Invalid':blocked||repeated||sent&&!b.force?'Duplicate':'Ready',reason:blocked?'Queued or awaiting verification':repeated?'Repeated in this selection':sent?'Previously sent':''}});
    return reply({entries:result,connection_version:c.version,total:result.length,already_sent:result.filter(e=>e.already_sent).length,invalid:result.filter(e=>e.status==='Invalid').length,duplicates:result.filter(e=>e.status==='Duplicate').length,ready:result.filter(e=>e.status==='Ready').length});
   }
   if(!uuid(b.batch_id))throw Error('Invalid batch identifier.');if(typeof b.name!=='string'||!b.name.trim()||b.name.length>150)throw Error('Enter a batch name.');
   const schedule=b.action==='enqueue'&&b.schedule?.enabled===true?b.schedule:null;const scheduledEntries=schedule?scheduleTransfer(entries,schedule):entries;const {data,error}=await db.rpc('b2b_enqueue',{p_owner:owner,p_connection:c.id,p_version:b.connection_version,p_batch:b.batch_id,p_name:b.name,p_group:groupId,p_mapping:mapping,p_entries:scheduledEntries,p_force:!!b.force,p_test:b.action==='test',p_track:b.action==='test'&&!!b.track_test});if(error)throw Error(error.message);
   return reply({batch_id:data});
  }
  if(b.action==='retry'||b.action==='cancel'){
   const {data:batch}=await db.from('b2bbricks_batches').select('id,connection_id,connection_version').eq('id',b.batch_id).eq('owner_id',owner).single();if(!batch)throw Error('Batch unavailable.');
   if(b.action==='retry'){
    const {data:c}=await db.from('b2bbricks_connections').select('version').eq('id',batch.connection_id).single();if(c?.version!==batch.connection_version)throw Error('Connection settings changed. Create a new batch using the updated mapping.');
    const {data,error}=await db.rpc('b2b_retry',{p_owner:owner,p_batch:batch.id,p_ack:!!b.acknowledge});if(error)throw Error(error.message);return reply({queued:data});
   }
   const {error}=await db.from('b2bbricks_deliveries').update({status:'Skipped',error_message:'Cancelled by administrator'}).eq('batch_id',batch.id).eq('status','Pending');if(error)throw error;
   await db.rpc('b2b_refresh_batch',{p_batch:batch.id});return reply({ok:true});
  }
  if(b.action==='history'){
   const f=b.filters||{},page=Math.max(0,Math.min(100000,Number(b.page)||0));
   let q=db.from('b2bbricks_deliveries').select('*,b2bbricks_batches!inner(name,group_id,is_test),b2bbricks_connections!inner(name)',{count:'exact'}).eq('owner_id',owner);
   if(f.status&&['Sent','Failed','Pending','Sending','Skipped','Duplicate'].includes(f.status))q=q.eq('status',f.status);
   for(const [key,value] of [['connection_id',f.connection_id],['batch_id',f.batch_id]])if(value){if(!uuid(value))throw Error('Invalid filter');q=q.eq(key,value)}
   if(f.group_id){if(!uuid(f.group_id))throw Error('Invalid group');q=q.eq('b2bbricks_batches.group_id',f.group_id)}
   if(f.project)q=q.ilike('project','%'+String(f.project).slice(0,150)+'%');
   if(f.from){if(!Number.isFinite(Date.parse(f.from)))throw Error('Invalid date');q=q.gte('created_at',f.from)}if(f.to){if(!Number.isFinite(Date.parse(f.to)))throw Error('Invalid date');q=q.lte('created_at',f.to)}
   if(f.search){const s=String(f.search).replace(/[^\p{L}\p{N}@+ -]/gu,'').slice(0,100);if(s){const {data:bs}=await db.from('b2bbricks_batches').select('id').eq('owner_id',owner).ilike('name','%'+s+'%').limit(100);q=q.or(`customer_name.ilike.*${s}*,mobile.ilike.*${s}*,email.ilike.*${s}*`+(bs?.length?`,batch_id.in.(${bs.map(x=>x.id).join(',')})`:''))}}
   const {data,error,count}=await q.order('created_at',{ascending:false}).order('id').range(page*50,page*50+49);if(error)throw error;
   let batches=db.from('b2bbricks_batches').select('*').eq('owner_id',owner).order('created_at',{ascending:false}).limit(100);if(f.batch_id)batches=batches.eq('id',f.batch_id);
   const {data:bs,error:be}=await batches;if(be)throw be;return reply({deliveries:data,total:count,batches:bs});
  }
  if(b.action==='attempts'){
   const {data,error}=await db.from('b2bbricks_attempts').select('*').eq('owner_id',owner).eq('delivery_id',b.delivery_id).order('created_at');if(error)throw error;return reply({attempts:data});
  }
  return reply({error:'Unknown action'},400);
 }catch(e){const message=e instanceof Error?e.message:'Could not complete the request';return reply({error:message.includes('http')||message.includes('SQL')?'Could not complete the request. Review the configuration and try again.':message},400)}
});
