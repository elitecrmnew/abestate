import {createClient} from 'npm:@supabase/supabase-js@2.57.0';
import webpush from 'npm:web-push@3.6.7';
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
function endpointAllowed(value:unknown){
 try{const u=new URL(String(value));return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&!u.hash&&(
 u.hostname==='fcm.googleapis.com'||u.hostname==='updates.push.services.mozilla.com'||u.hostname.endsWith('.push.services.mozilla.com')||u.hostname==='web.push.apple.com'||u.hostname.endsWith('.notify.windows.com'));
 }catch{return false}
}
Deno.serve(async req=>{
 const headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Vary':'Origin'};
 if(req.headers.get('origin')==='https://abestate.vercel.app')headers['Access-Control-Allow-Origin']='https://abestate.vercel.app';
 const reply=(x:unknown,status=200)=>new Response(JSON.stringify(x),{status,headers});
 if(req.method==='OPTIONS')return reply({});
 if(req.method!=='POST')return reply({error:'POST required'},405);
 try{
  const worker=req.headers.get('x-worker-token');
  if(worker){
   const {data:settings,error}=await db.rpc('crm_push_settings');if(error||!settings)return reply({error:'Service unavailable'},503);
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(worker)))).map(x=>x.toString(16).padStart(2,'0')).join('');
   if(hash!==settings.worker_hash)return reply({error:'Unauthorized'},401);
   const {data:jobs,error:ce}=await db.rpc('crm_claim_push');if(ce)throw ce;
   // Small concurrent groups keep execution bounded; claims are database-locked.
   for(let offset=0;offset<(jobs||[]).length;offset+=5)await Promise.all(jobs.slice(offset,offset+5).map(async(job:any)=>{
    const [{data:n},{data:s}]=await Promise.all([
     db.from('crm_assignment_notifications').select('*').eq('id',job.notification_id).maybeSingle(),
     db.from('crm_push_subscriptions').select('*').eq('id',job.subscription_id).maybeSingle()
    ]);
    const {data:l}=n?await db.from('leads').select('assigned_to,assigned_at,owner_id,follow_up_at,follow_up_done').eq('id',n.lead_id).maybeSingle():{data:null};
    const {data:p}=n?await db.from('crm_profiles').select('active').eq('id',n.user_id).maybeSingle():{data:null};
    const valid=n?.kind==='follow_up'?l&&!l.follow_up_done&&l.follow_up_at===n.follow_up_at&&(l.assigned_to||l.owner_id)===n.user_id:l?.assigned_to===n?.user_id&&l?.assigned_at===n?.assigned_at;
    if(!n||!s||!p?.active||!valid||n.read_at||s.user_id!==n.user_id||!endpointAllowed(s.endpoint)){
     await db.from('crm_push_outbox').update({status:'Skipped',error:'Assignment or device no longer available'}).eq('id',job.id);return;
    }
    try{
     await webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth_key}},JSON.stringify({kind:n.kind,title:n.kind==='follow_up'?'Follow-up due':'New lead assigned',body:n.kind==='follow_up'?'Time to follow up. Open AB Estate to view the lead.':'Open AB Estate to view your new lead.',lead_id:n.lead_id,id:n.id}),{TTL:3600,timeout:8000,topic:n.id.replace(/-/g,''),vapidDetails:{subject:'https://abestate.vercel.app',publicKey:settings.public_key,privateKey:settings.private_key}});
     await db.from('crm_push_outbox').update({status:'Sent',error:null}).eq('id',job.id);
    }catch(e){
     const status=Number((e as any)?.statusCode)||0;
     if(status===404||status===410){await db.from('crm_push_subscriptions').delete().eq('id',s.id);return}
     await db.from('crm_push_outbox').update({status:job.attempts>=5?'Failed':'Pending',error:status?'Push service HTTP '+status:'Push service unavailable',next_at:new Date(Date.now()+Math.min(3600,60*2**job.attempts)*1000).toISOString()}).eq('id',job.id);
    }
   }));
   return reply({processed:jobs?.length||0});
  }
  const {data:{user}}=await db.auth.getUser((req.headers.get('Authorization')||'').replace(/^Bearer /,''));
  if(!user)return reply({error:'Sign in first'},401);
  const {data:profile}=await db.from('crm_profiles').select('active').eq('id',user.id).maybeSingle();
  if(!profile?.active)return reply({error:'Active account required'},403);
  const text=await req.text();if(text.length>12000)return reply({error:'Request too large'},413);
  const b=JSON.parse(text);
  if(b.action==='key'){
   const {data:s}=await db.rpc('crm_push_settings');if(!s)return reply({error:'Notifications are not configured'},503);
   return reply({publicKey:s.public_key});
  }
  if(b.action==='unsubscribe'){
   const {error}=await db.from('crm_push_subscriptions').delete().eq('endpoint',String(b.endpoint)).eq('user_id',user.id);if(error)throw error;return reply({ok:true});
  }
  if(b.action==='subscribe'){
   const s=b.subscription;
   if(!s||!endpointAllowed(s.endpoint)||s.endpoint.length>3000||!/^[-_A-Za-z0-9]{87}=?$/.test(s.keys?.p256dh||'')||!/^[-_A-Za-z0-9]{22}={0,2}$/.test(s.keys?.auth||''))return reply({error:'Unsupported or invalid push subscription'},400);
   const {count}=await db.from('crm_push_subscriptions').select('id',{count:'exact',head:true}).eq('user_id',user.id);
   const {data:old}=await db.from('crm_push_subscriptions').select('id').eq('endpoint',s.endpoint).maybeSingle();
   if(!old&&(count||0)>=10)return reply({error:'Maximum 10 devices. Disable notifications on an older device first.'},400);
   const {error}=await db.from('crm_push_subscriptions').upsert({user_id:user.id,endpoint:s.endpoint,p256dh:s.keys.p256dh,auth_key:s.keys.auth},{onConflict:'endpoint'});if(error)throw error;
   return reply({ok:true});
  }
  return reply({error:'Unknown action'},400);
 }catch{return reply({error:'Could not update notifications. Please try again.'},400)}
});
