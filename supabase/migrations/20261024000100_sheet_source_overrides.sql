create or replace function public.crm_receive_lead(p_integration uuid,p_lead jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare i public.crm_integrations; lid uuid; ph text; sid text; result text;
begin
 select * into i from public.crm_integrations where id=p_integration and active for update;
 if not found then raise exception 'Connection unavailable'; end if;
 if nullif(p_lead->>'_group_id','') is not null then
  if i.source<>'Google Sheets' then raise exception 'Group override requires Google Sheets'; end if;
  i.group_id=(p_lead->>'_group_id')::uuid;
  if not exists(select 1 from public.lead_groups where id=i.group_id and owner_id=i.owner_id) then raise exception 'Group unavailable'; end if;
 end if;
 if exists(select 1 from public.crm_api_settings where owner_id=i.owner_id and not active) then raise exception 'API service is paused'; end if;
 if not exists(select 1 from public.crm_profiles where id=i.owner_id and role='admin' and active) then raise exception 'Connection unavailable'; end if;
 if not exists(select 1 from public.lead_groups where id=i.group_id and owner_id=i.owner_id) then raise exception 'Group unavailable'; end if;
 if i.assigned_to is not null and not exists(select 1 from public.crm_profiles where id=i.assigned_to and role='caller' and active) then raise exception 'Assigned caller is inactive'; end if;
 ph=p_lead->>'phone';
 if ph is null or ph !~ '^[+][1-9][0-9]{7,14}$' or length(coalesce(p_lead->>'name','')) not between 1 and 100 then raise exception 'Invalid lead'; end if;
 -- Serialize intake across connections owned by the same administrator.
 perform pg_advisory_xact_lock(hashtextextended(i.owner_id::text,0));
 sid=case when coalesce(p_lead->>'external_id','')<>'' then i.source||':'||i.id::text||':'||(p_lead->>'external_id') else null end;
 select l.id into lid from public.leads l where l.owner_id=i.owner_id and (
 (sid is not null and l.source_lead_id=sid) or exists(select 1 from unnest(l.phone_numbers) n where
 case when length(regexp_replace(n,'[^0-9]','','g'))=10 then '91'||regexp_replace(n,'[^0-9]','','g')
 when length(regexp_replace(n,'[^0-9]','','g'))=11 and left(regexp_replace(n,'[^0-9]','','g'),1)='0' then '91'||right(regexp_replace(n,'[^0-9]','','g'),10)
 else regexp_replace(n,'[^0-9]','','g') end=substring(ph from 2))) order by l.created_at limit 1;
 if lid is null then
 insert into public.leads(owner_id,group_id,source_lead_id,customer_name,phone_numbers,email,budget,source,campaign_name,original_lead_date,assigned_to,assigned_at,remark)
 values(i.owner_id,i.group_id,sid,p_lead->>'name',array[ph],coalesce(p_lead->>'email',''),coalesce(p_lead->>'budget',''),i.source,coalesce(p_lead->>'campaign',''),now(),i.assigned_to,case when i.assigned_to is not null then now() end,coalesce(p_lead->>'message','')) returning id into lid;
 result='created';
 else result='duplicate'; end if;
 insert into public.crm_intake_events(integration_id,lead_id,outcome) values(i.id,lid,result);
 update public.crm_integrations set last_received_at=now(),received_count=received_count+1 where id=i.id;
 delete from public.crm_intake_events where integration_id=i.id and created_at<now()-interval '30 days';
 return jsonb_build_object('ok',true,'outcome',result,'lead_id',lid);
end $$;
revoke all on function public.crm_receive_lead(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.crm_receive_lead(uuid,jsonb) to service_role;
-- Atomic CRM insert + outbound enqueue. A failed enqueue rolls back the import,
-- allowing the Sheet adapter to retry without dropping or double-sending the lead.
create or replace function public.crm_receive_routed_lead(p_integration uuid,p_lead jsonb,p_entry jsonb,p_version integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare i public.crm_integrations; c public.b2bbricks_connections; r jsonb; batch uuid;
begin
 select * into i from public.crm_integrations where id=p_integration and active for update;
 if not found then raise exception 'Connection unavailable'; end if;
 if nullif(p_lead->>'_group_id','') is not null then
  if i.source<>'Google Sheets' then raise exception 'Group override requires Google Sheets'; end if;
  i.group_id=(p_lead->>'_group_id')::uuid;
  if not exists(select 1 from public.lead_groups where id=i.group_id and owner_id=i.owner_id) then raise exception 'Group unavailable'; end if;
 end if;
 r=public.crm_receive_lead(p_integration,p_lead);
 if i.b2b_connection_id is not null and r->>'outcome'='created' then
  select * into c from public.b2bbricks_connections where id=i.b2b_connection_id and owner_id=i.owner_id;
  if not found or p_entry is null or coalesce(p_entry->>'error','')<>'' then raise exception 'Check B2BBricks connection and field mapping'; end if;
  p_entry=jsonb_set(p_entry,'{lead,id}',to_jsonb(r->>'lead_id'));
  batch=public.b2b_enqueue(i.owner_id,c.id,p_version,gen_random_uuid(),left(i.name||' · automatic import',150),i.group_id,c.mapping,jsonb_build_array(p_entry),false,false,false);
  r=r||jsonb_build_object('b2b_batch_id',batch);
 end if;
 return r;
end $$;
revoke all on function public.crm_receive_routed_lead(uuid,jsonb,jsonb,integer) from public,anon,authenticated;
grant execute on function public.crm_receive_routed_lead(uuid,jsonb,jsonb,integer) to service_role;
