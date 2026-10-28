import {createClient} from 'npm:@supabase/supabase-js@2.57.0';
const baseHeaders={'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Content-Type':'application/json','Cache-Control':'no-store'};
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get('origin')||'';
 const headers:Record<string,string>={...baseHeaders,'Vary':'Origin','Access-Control-Allow-Methods':'POST,OPTIONS'};
 if(['https://abestate.netlify.app','https://abestate-crm.netlify.app','https://abestate.vercel.app'].includes(origin))headers['Access-Control-Allow-Origin']=origin;
 const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return reply({error:'Method not allowed'},405);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer /,'');
 const {data:{user},error}=await db.auth.getUser(token);
 if(error||!user)return reply({error:'Sign in first'},401);
 const {data:admin}=await db.from('crm_profiles').select('role,active').eq('id',user.id).single();
 if(admin?.role!=='admin'||!admin.active)return reply({error:'Admin access required'},403);
 try{
  const raw=await req.text();if(raw.length>10000)return reply({error:'Request too large'},413);
  const b=JSON.parse(raw);
  if(b.action==='service-status'){
   if(typeof b.active!=='boolean')return reply({error:'Choose a service status'},400);
   const {error:e}=await db.from('crm_api_settings').upsert({owner_id:user.id,active:b.active});if(e)throw e;
   return reply({ok:true});
  }
  if(b.action==='create'){
   if(!['Website','99acres','API','Google Sheets'].includes(b.source)||typeof b.name!=='string'||!b.name.trim()||b.name.length>100)return reply({error:'Enter a connection name and source'},400);
   const {data:group}=await db.from('lead_groups').select('id').eq('id',b.group_id).eq('owner_id',user.id).maybeSingle();
   if(!group)return reply({error:'Select one of your lead groups'},400);
   if(b.assigned_to){const {data:p}=await db.from('crm_profiles').select('id').eq('id',b.assigned_to).eq('role','caller').eq('active',true).maybeSingle();if(!p)return reply({error:'Choose an active caller'},400);}
   if(b.b2b_connection_id){
    if(b.assigned_to)return reply({error:'Choose one destination: caller or B2BBricks'},400);
    const {data:out}=await db.from('b2bbricks_connections').select('id').eq('id',b.b2b_connection_id).eq('owner_id',user.id).eq('active',true).eq('archived',false).eq('contract_confirmed',true).maybeSingle();
    if(!out)return reply({error:'Choose an active, configured B2BBricks connection'},400);
   }
   let origin=null;
   if(b.source==='Website'){try{const u=new URL(b.website_origin);if(u.protocol!=='https:'||u.username||u.password)throw Error();origin=u.origin;}catch{return reply({error:'Enter the HTTPS address of your website'},400);}}
   const mapping:Record<string,string>={};for(const k of ['name','phone','email','budget','campaign','message','external_id']){const v=b.field_mapping?.[k];if(v){if(typeof v!=='string'||!/^\w[\w .-]{0,79}$/.test(v))return reply({error:'Use simple top-level field names for mapping'},400);mapping[k]=v;}}
   const secret=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
   const {data,error:e}=await db.from('crm_integrations').insert({owner_id:user.id,name:b.name.trim(),source:b.source,group_id:b.group_id,assigned_to:b.assigned_to||null,website_origin:origin,b2b_connection_id:b.b2b_connection_id||null,field_mapping:mapping,secret_hash:await hash(secret)}).select('id').single();
   if(e)throw e;return reply({id:data.id,...(b.source!=='Website'?{secret}:{})});
  }
  const {data:c}=await db.from('crm_integrations').select('id,source').eq('id',b.id).eq('owner_id',user.id).maybeSingle();if(!c)return reply({error:'Connection not found'},404);
  if(b.action==='save-sheet-mapping'){
   if(c.source!=='Google Sheets')return reply({error:'Choose a Google Sheets connection'},400);
   const mapping:Record<string,string>={};
   for(const field of ['name','phone','email','budget','campaign','message']){
    const value=b.field_mapping?.[field]??'';
    if(typeof value!=='string'||value.length>1000||/[\r\n\0]/.test(value))return reply({error:'Invalid column mapping'},400);
    const parts=[...new Set(value.split(',').map((h:string)=>h.trim()).filter(Boolean))];
    if(parts.length>20||parts.some(h=>h.length>200))return reply({error:'Use up to 20 headers per field, maximum 200 characters each'},400);
    mapping[field]=parts.join(', ');
   }
   if(!mapping.name||!mapping.phone)return reply({error:'Name and phone mappings are required'},400);
   const {data,error:e}=await db.from('crm_integrations').update({field_mapping:mapping}).eq('id',c.id).eq('owner_id',user.id).select('field_mapping').single();
   if(e)throw e;return reply({ok:true,field_mapping:data.field_mapping});
  }
  if(b.action==='toggle'&&typeof b.active==='boolean'){const {error:e}=await db.from('crm_integrations').update({active:b.active}).eq('id',c.id);if(e)throw e;return reply({ok:true});}
  if(b.action==='rotate'&&c.source!=='Website'){const secret=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');const {error:e}=await db.from('crm_integrations').update({secret_hash:await hash(secret)}).eq('id',c.id);if(e)throw e;return reply({id:c.id,secret});}
  return reply({error:'Unknown action'},400);
 }catch{return reply({error:'Could not save integration. Check the fields and try again.'},400);}
});
