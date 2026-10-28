import {mapLead,validateMapping,type Mapping} from './outbound.ts';
export function groupMapping(mapping:Mapping[]):Mapping[]{
 validateMapping(mapping);
 if(!mapping.some(m=>m.kind==='project'))throw Error('Mark the destination project field as Project in connection mapping.');
 return mapping.map(m=>m.kind==='project'?{...m,source:'group_name',value:'',fallback:''}:m);
}
// Runs under the existing worker lease. Stable outbox IDs make restart/retry idempotent.
export async function prepareGroupAutomations(db:any,deadline:number){
 const {data:items,error}=await db.from('b2b_group_outbox').select('*').eq('status','Pending').order('created_at').limit(20);
 if(error)throw error;
 for(const item of items||[]){
  if(Date.now()>deadline)break;
  try{
   const {data:rule,error:re}=await db.from('b2b_group_rules').select('enabled,connection_id').eq('group_id',item.group_id).eq('owner_id',item.owner_id).maybeSingle();if(re)throw re;
   const {data:lead,error:le}=await db.from('leads').select('*').eq('id',item.lead_id).eq('owner_id',item.owner_id).maybeSingle();if(le)throw le;
   if(!rule?.enabled||rule.connection_id!==item.connection_id||!lead||lead.group_id!==item.group_id){
    const {error:e}=await db.from('b2b_group_outbox').update({status:'Skipped',error_message:'Lead moved or automation disabled'}).eq('id',item.id).eq('status','Pending');if(e)throw e;continue;
   }
   const {data:c,error:ce}=await db.from('b2bbricks_connections').select('*').eq('id',item.connection_id).eq('owner_id',item.owner_id).single();if(ce)throw ce;
   if(!c.active||c.archived||!c.contract_confirmed)throw Error('Connection inactive. Activate it, then retry preparation.');
   const {data:g,error:ge}=await db.from('lead_groups').select('name').eq('id',item.group_id).eq('owner_id',item.owner_id).single();if(ge)throw ge;
   const mapping=groupMapping(c.mapping),entry=mapLead({...lead,group_name:g.name},{...c,mapping});
   const {error:e}=await db.rpc('b2b_enqueue_group_item',{p_id:item.id,p_version:c.version,p_mapping:mapping,p_entry:entry});if(e)throw e;
  }catch(e){
   // No provider response/secrets enter this preparation error; delivery errors use existing history.
   const message=e instanceof Error?e.message:'Could not prepare delivery. Check the connection and retry.';
   const {error:saveError}=await db.from('b2b_group_outbox').update({status:'Failed',error_message:message.slice(0,250)}).eq('id',item.id).eq('status','Pending');if(saveError)throw saveError;
  }
 }
}
