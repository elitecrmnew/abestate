import {prepareGroupAutomations} from '../_shared/groupAutomation.ts';
import {createClient} from 'npm:@supabase/supabase-js@2.57.0';
import {validateDestination,redactResponse,responseAccepted} from '../_shared/outbound.ts';
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');
Deno.serve(async(req:Request)=>{
 const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 if(req.method!=='POST')return reply({error:'Method not allowed'},405);
 const secret=req.headers.get('x-worker-token')||'';if(secret.length!==64)return reply({error:'Unauthorized'},401);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const {data:state,error:se}=await db.from('b2bbricks_worker_state').select('token_hash').eq('id',true).single();
 if(se||state.token_hash!==await hash(secret))return reply({error:'Unauthorized'},401);
 const lease=crypto.randomUUID();const {data:locked,error:le}=await db.rpc('b2b_worker_lease',{p_lease:lease});if(le)return reply({error:'Queue unavailable'},503);if(!locked)return reply({busy:true});
 const start=Date.now();let processed=0;
 try{
  await prepareGroupAutomations(db,start+8000);
  while(processed<10&&Date.now()-start<35000){
   const {data:d,error}=await db.rpc('b2b_claim',{p_lease:lease});if(error)throw error;if(!d)break;
   const {data:c,error:ce}=await db.from('b2bbricks_connections').select('*').eq('id',d.connection_id).single();if(ce)throw ce;
   let status='Failed',http:number|null=null,body='',message='',uncertain=false,delay=c.delay_ms;
   try{
    const url=validateDestination(c.webhook_url);
    const payload=c.envelope?{[c.envelope]:d.payload}:d.payload;
    const headers={...c.headers,'Content-Type':c.content_type};
    const encoded=c.content_type==='application/json'?JSON.stringify(payload):new URLSearchParams(d.payload).toString();
    // Redirects are deliberately rejected: no webhook credentials leave this provider.
    const response=await fetch(url,{method:c.method,headers,body:encoded,redirect:'manual',signal:AbortSignal.timeout(10000)});
    http=response.status;
    const reader=response.body?.getReader();let bytes=0;const chunks:Uint8Array[]=[];
    if(reader)while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>65536){await reader.cancel();throw Error('Response exceeded 64 KB; verify receipt before retrying.');}chunks.push(r.value)}
    const buf=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buf.set(chunk,offset);offset+=chunk.length}
    const raw=new TextDecoder().decode(buf);body=redactResponse(raw,c.webhook_url,c.headers);
    if(responseAccepted(http,raw,c)){status='Sent'}else{message='Response did not match the configured success rule (HTTP '+http+').';uncertain=http>=200&&http<300||http>=500;}
    if(http===429){const retry=response.headers.get('retry-after')||'';const seconds=/^\d+$/.test(retry)?Number(retry):Math.max(0,(Date.parse(retry)-Date.now())/1000);delay=Math.min(3600000,Math.max(60000,(seconds||60)*1000));message='Rate limited. Retry failed leads after the provider cooldown.';}
   }catch{message='No conclusive response. Check B2BBricks before retrying; the lead may have arrived.';uncertain=true;}
   const {error:fe}=await db.rpc('b2b_finish',{p_id:d.id,p_status:status,p_http:http,p_body:body,p_error:message,p_uncertain:uncertain,p_delay_ms:delay});if(fe)throw fe;
   processed++;if(Date.now()-start<35000)await new Promise(r=>setTimeout(r,Math.min(c.delay_ms,10000)));
  }
  return reply({processed});
 }catch{return reply({error:'Worker interrupted; queue state retained',processed},503)}
 finally{await db.from('b2bbricks_worker_state').update({lease_until:new Date().toISOString()}).eq('id',true).eq('lease_id',lease);}
});
