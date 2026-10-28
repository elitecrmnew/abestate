alter table public.crm_integrations drop constraint crm_integrations_source_check;
alter table public.crm_integrations add constraint crm_integrations_source_check check(source in ('Website','99acres','API'));
create table public.crm_api_settings (
 owner_id uuid primary key references public.crm_profiles(id),
 active boolean not null default true
);
alter table public.crm_api_settings enable row level security;
revoke all on public.crm_api_settings from anon,authenticated;
grant select on public.crm_api_settings to authenticated;
grant all on public.crm_api_settings to service_role;
create policy api_settings_admin_read on public.crm_api_settings for select to authenticated
 using(owner_id=(select auth.uid()) and (select crm_private.is_admin()));
create or replace function public.crm_receive_lead(p_integration uuid,p_lead jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare i public.crm_integrations; lid uuid; ph text; sid text; result text;
begin
 select * into i from public.crm_integrations where id=p_integration and active for update;
 if not found then raise exception 'Connection unavailable'; end if;
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
 return jsonb_build_object('ok',true,'outcome',result);
end $$;
revoke all on function public.crm_receive_lead(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.crm_receive_lead(uuid,jsonb) to service_role;
