-- Website form and server webhook intake. Only service_role can write connections.
create table public.crm_integrations (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references public.crm_profiles(id),
 name text not null check(length(name) between 1 and 100),
 source text not null check(source in ('Website','99acres')),
 group_id uuid not null references public.lead_groups(id),
 assigned_to uuid references public.crm_profiles(id),
 website_origin text,
 field_mapping jsonb not null default '{}',
 secret_hash text not null,
 active boolean not null default true,
 created_at timestamptz not null default now(),
 last_received_at timestamptz,
 received_count integer not null default 0
);
alter table public.crm_integrations enable row level security;
revoke all on public.crm_integrations from anon,authenticated;
grant select(id,owner_id,name,source,group_id,assigned_to,website_origin,field_mapping,active,created_at,last_received_at,received_count) on public.crm_integrations to authenticated;
grant all on public.crm_integrations to service_role;
create policy integration_admin_read on public.crm_integrations for select to authenticated using(owner_id=(select auth.uid()) and (select crm_private.is_admin()));
create index crm_integrations_owner_idx on public.crm_integrations(owner_id);
create index crm_integrations_group_idx on public.crm_integrations(group_id);
create index crm_integrations_caller_idx on public.crm_integrations(assigned_to);
create table public.crm_intake_events (
 id bigint generated always as identity primary key,
 integration_id uuid not null references public.crm_integrations(id) on delete cascade,
 lead_id uuid references public.leads(id) on delete set null,
 outcome text not null check(outcome in ('created','duplicate')),
 created_at timestamptz not null default now()
);
alter table public.crm_intake_events enable row level security;
revoke all on public.crm_intake_events from anon,authenticated;
grant select on public.crm_intake_events to authenticated;
grant all on public.crm_intake_events to service_role;
grant usage,select on sequence public.crm_intake_events_id_seq to service_role;
create policy intake_admin_read on public.crm_intake_events for select to authenticated using(exists(select 1 from public.crm_integrations i where i.id=integration_id and i.owner_id=(select auth.uid()) and (select crm_private.is_admin())));
create index crm_intake_events_integration_idx on public.crm_intake_events(integration_id,created_at desc);
create index crm_intake_events_lead_idx on public.crm_intake_events(lead_id);
create table public.crm_intake_limits (
 bucket text primary key,
 window_start timestamptz not null,
 requests integer not null
);
alter table public.crm_intake_limits enable row level security;
revoke all on public.crm_intake_limits from anon,authenticated;
grant all on public.crm_intake_limits to service_role;
create function public.crm_intake_rate(p_bucket text,p_max integer) returns boolean
 language plpgsql security invoker set search_path='' as $$
declare n integer; begin
 insert into public.crm_intake_limits(bucket,window_start,requests) values(p_bucket,date_trunc('minute',now()),1)
 on conflict(bucket) do update set requests=case when crm_intake_limits.window_start=date_trunc('minute',now()) then crm_intake_limits.requests+1 else 1 end,window_start=date_trunc('minute',now()) returning requests into n;
 delete from public.crm_intake_limits where window_start<now()-interval '1 day';
 return n<=p_max;
end $$;
revoke all on function public.crm_intake_rate(text,integer) from public,anon,authenticated;
grant execute on function public.crm_intake_rate(text,integer) to service_role;
create function public.crm_receive_lead(p_integration uuid,p_lead jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare i public.crm_integrations; lid uuid; ph text; sid text; result text;
begin
 select * into i from public.crm_integrations where id=p_integration and active for update;
 if not found then raise exception 'Connection unavailable'; end if;
 if not exists(select 1 from public.crm_profiles where id=i.owner_id and role='admin' and active) then raise exception 'Connection unavailable'; end if;
 if not exists(select 1 from public.lead_groups where id=i.group_id and owner_id=i.owner_id) then raise exception 'Group unavailable'; end if;
 if i.assigned_to is not null and not exists(select 1 from public.crm_profiles where id=i.assigned_to and role='caller' and active) then raise exception 'Assigned caller is inactive'; end if;
 ph=p_lead->>'phone';
 if ph is null or ph !~ '^\+[1-9][0-9]{7,14}$' or length(coalesce(p_lead->>'name','')) not between 1 and 100 then raise exception 'Invalid lead'; end if;
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
