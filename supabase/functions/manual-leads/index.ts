import {createClient} from 'npm:@supabase/supabase-js@2.57.0';
Deno.serve(async(req:Request)=>{
 const headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin','Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'};
 const origin=req.headers.get('origin')||'';if(['https://abestate.vercel.app','https://abestate.netlify.app','https://abestate-crm.netlify.app'].includes(origin))headers['Access-Control-Allow-Origin']=origin;
 const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
 if(req.method==='OPTIONS')return new Response('ok',{headers});if(req.method!=='POST')return reply({error:'Method not allowed'},405);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const {data:{user},error}=await db.auth.getUser((req.headers.get('Authorization')||'').replace(/^Bearer /,''));if(error||!user)return reply({error:'Sign in first'},401);
 try{
  const reader=req.body?.getReader();if(!reader)return reply({error:'Empty request'},400);let text='',size=0;const decoder=new TextDecoder();
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();return reply({error:'Request too large'},413)}text+=decoder.decode(value,{stream:true})}text+=decoder.decode();
  const b=JSON.parse(text);if(!b||Array.isArray(b))return reply({error:'Invalid request'},400);
  let result;
  if(b.action==='permissions'){
   if(typeof b.can_add_lead!=='boolean'||typeof b.can_create_group!=='boolean')return reply({error:'Choose permissions'},400);
   result=await db.rpc('crm_set_caller_creation_permissions',{p_actor:user.id,p_caller:b.id,p_add:b.can_add_lead,p_group:b.can_create_group});
  }else if(b.action==='group'){
   if(typeof b.name!=='string')return reply({error:'Enter a group name'},400);
   result=await db.rpc('crm_create_manual_group',{p_actor:user.id,p_name:b.name});
  }else if(b.action==='lead'){
   if(typeof b.name!=='string'||typeof b.phone!=='string')return reply({error:'Enter name and phone'},400);
   result=await db.rpc('crm_create_manual_lead',{p_actor:user.id,p_name:b.name,p_phone:b.phone,p_group:b.group_id||null});
  }else return reply({error:'Unknown action'},400);
  if(result.error)return reply({error:result.error.code==='P0001'?result.error.message:'Could not save. Refresh and check the fields.'},400);
  return reply({ok:true,result:result.data});
 }catch{return reply({error:'Could not save. Check the fields and try again.'},400)}
});
