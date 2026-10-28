begin;
create temp table fixture(admin uuid,caller uuid,gid uuid,l1 uuid,l2 uuid,conn uuid,inbound uuid);
insert into fixture select gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid();
insert into auth.users(id,email) select admin,admin::text||'@fixture.invalid' from fixture union all select caller,caller::text||'@fixture.invalid' from fixture;
insert into public.crm_profiles(id,username,display_name,role,active) select admin,'fx_'||substr(md5(admin::text),1,12),'Fixture admin','admin',true from fixture union all select caller,'fx_'||substr(md5(caller::text),1,12),'Fixture caller','caller',true from fixture;
insert into public.lead_groups(id,owner_id,name) select gid,admin,'Sheets fixture' from fixture;
insert into public.leads(id,owner_id,group_id,customer_name,assigned_to,assigned_at,follow_up_at)
 select l1,admin,gid,'Caller reminder',caller,now(),now()-interval '1 minute' from fixture union all
 select l2,admin,gid,'Admin reminder',null,null,now()-interval '1 minute' from fixture;
select crm_private.queue_followup_reminders();
select crm_private.queue_followup_reminders();
do $$declare f fixture; begin
 select * into f from fixture;
 if (select count(*) from public.crm_assignment_notifications where lead_id in(f.l1,f.l2) and kind='follow_up')<>2 then raise exception 'Reminder deduplication failed';end if;
 if not exists(select 1 from public.crm_assignment_notifications where lead_id=f.l2 and user_id=f.admin and kind='follow_up') then raise exception 'Admin routing failed';end if;
end $$;
grant select on fixture to authenticated;
select set_config('request.jwt.claim.sub',(select caller::text from fixture),true);
set local role authenticated;
do $$begin
 if (select count(*) from public.crm_assignment_notifications where lead_id in(select l1 from fixture union all select l2 from fixture) and kind='follow_up')<>1 then raise exception 'Caller reminder visibility failed';end if;
end $$;
update public.leads set follow_up_done=true where id=(select l1 from fixture);
do $$begin
 if exists(select 1 from public.crm_assignment_notifications where lead_id=(select l1 from fixture) and kind='follow_up') then raise exception 'Completed reminder still visible';end if;
end $$;
reset role;
insert into public.b2bbricks_connections(id,owner_id,name,active,contract_confirmed,webhook_url) select conn,admin,'Fixture B2B',true,true,'https://connector.b2bbricks.com/api/Integration/fixture' from fixture;
insert into public.crm_integrations(id,owner_id,name,source,group_id,secret_hash,b2b_connection_id) select inbound,admin,'Fixture Sheet','Google Sheets',gid,'fixture',conn from fixture;
do $$declare f fixture;r jsonb;payload jsonb;entry jsonb;before_count int; begin
 select * into f from fixture;
 payload=jsonb_build_object('name','Sheet fixture','phone','+919000000001','external_id','row-1');
 entry=jsonb_build_object('lead',jsonb_build_object('customer_name','Sheet fixture','email',''),'mobile','+919000000001','payload','{}'::jsonb,'project','Sheets fixture','error','');
 r=public.crm_receive_routed_lead(f.inbound,payload,entry,1);
 if r->>'outcome'<>'created' or r->>'b2b_batch_id' is null then raise exception 'Routing failed';end if;
 r=public.crm_receive_routed_lead(f.inbound,payload,entry,1);
 if r->>'outcome'<>'duplicate' then raise exception 'Duplicate failed';end if;
 if (select count(*) from public.b2bbricks_deliveries where connection_id=f.conn)<>1 then raise exception 'Duplicate sent';end if;
 select count(*) into before_count from public.leads where owner_id=f.admin;
 begin
  perform public.crm_receive_routed_lead(f.inbound,payload||'{"phone":"+919000000002","external_id":"row-2"}'::jsonb,entry,999);
  raise exception 'BAD: invalid version accepted';
 exception when raise_exception then if sqlerrm like 'BAD:%' then raise;end if;end;
 if (select count(*) from public.leads where owner_id=f.admin)<>before_count then raise exception 'Failed enqueue did not roll back import';end if;
 update public.crm_integrations set b2b_connection_id=null,assigned_to=f.caller where id=f.inbound;
 r=public.crm_receive_routed_lead(f.inbound,payload||'{"phone":"+919000000003","external_id":"row-3"}'::jsonb,null,null);
 if not exists(select 1 from public.leads where id=(r->>'lead_id')::uuid and assigned_to=f.caller) then raise exception 'Caller routing failed';end if;
 update public.crm_integrations set assigned_to=null where id=f.inbound;
 r=public.crm_receive_routed_lead(f.inbound,payload||'{"phone":"+919000000004","external_id":"row-4"}'::jsonb,null,null);
 if not exists(select 1 from public.leads where id=(r->>'lead_id')::uuid and assigned_to is null) then raise exception 'Admin inbox routing failed';end if;
 if has_function_privilege('authenticated','public.crm_receive_routed_lead(uuid,jsonb,jsonb,integer)','execute') then raise exception 'Unsafe routing permission';end if;
end $$;
rollback;
select 'PASS: reminder dedupe/RLS/completion and atomic routing/admin/caller/B2B/retries' result;
