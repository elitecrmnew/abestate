import { createClient } from 'npm:@supabase/supabase-js@2.57.0';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Content-Type':'application/json'};
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
 if(req.method!=='POST')return reply({error:'Method not allowed'},405);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer /,'');
 const {data:{user},error:authError}=await db.auth.getUser(token);
 if(authError||!user)return reply({error:'Sign in first'},401);
 const {data:admin}=await db.from('crm_profiles').select('role,active').eq('id',user.id).single();
 if(admin?.role!=='admin'||!admin.active)return reply({error:'Admin access required'},403);
 try{
 const body=await req.json();
 if(body.action==='create'){
  const username=String(body.username||'').trim().toLowerCase();
  const name=String(body.name||'').trim();
  const password=String(body.password||'');
  if(!/^[a-z0-9._-]{3,40}$/.test(username)||!name||name.length>100||password.length<8||password.length>128)return reply({error:'Use a valid username, name and a password of 8–128 characters'},400);
  const {data:created,error}=await db.auth.admin.createUser({email:username+'@callers.leadextract.app',password,email_confirm:true});
  if(error)return reply({error:error.message},400);
  const {error:profileError}=await db.from('crm_profiles').insert({id:created.user.id,username,display_name:name,role:'caller'});
  if(profileError){await db.auth.admin.deleteUser(created.user.id);return reply({error:'Username already exists or profile could not be created'},400);}
  return reply({ok:true});
 }
 const {data:target}=await db.from('crm_profiles').select('id,role').eq('id',body.id).single();
 if(!target||target.role!=='caller')return reply({error:'Caller not found'},404);
 if(body.action==='toggle'){
  if(typeof body.active!=='boolean')return reply({error:'Invalid state'},400);
  const {error}=await db.from('crm_profiles').update({active:body.active}).eq('id',body.id);if(error)throw error;
 }else if(body.action==='password'){
  if(typeof body.password!=='string'||body.password.length<8||body.password.length>128)return reply({error:'Use 8–128 characters'},400);
  const {error}=await db.auth.admin.updateUserById(body.id,{password:body.password});if(error)throw error;
 }else return reply({error:'Unknown action'},400);
 return reply({ok:true});
 }catch{return reply({error:'Could not complete caller management request'},500);}
});
