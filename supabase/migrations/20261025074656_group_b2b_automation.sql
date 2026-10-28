-- Capture only new leads. No backfill and no webhook secrets in browser-accessible data.
create schema if not exists crm_private;
revoke all on schema crm_private from public,anon,authenticated;
create table public.b2b_group_rules (
 group_id uuid primary key references public.lead_groups(id) on delete cascade,
 owner_id uuid not null references public.crm_profiles(id),
 connection_id uuid not null references public.b2bbricks_connections(id),
 enabled boolean not null default false,
 updated_at timestamptz not null default now()
);
create table public.b2b_group_outbox (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references public.crm_profiles(id),
 group_id uuid not null references public.lead_groups(id) on delete cascade,
 lead_id uuid not null references public.leads(id) on delete cascade,
 connection_id uuid not null references public.b2bbricks_connections(id),
 status text not null default 'Pending' check(status in ('Pending','Queued','Failed','Skipped')),
 error_message text not null default '',
 created_at timestamptz not null default now(),
 unique(lead_id,connection_id)
);
create index b2b_group_outbox_pending on public.b2b_group_outbox(created_at) where status='Pending';
create index b2b_group_outbox_owner on public.b2b_group_outbox(owner_id,group_id);
alter table public.b2b_group_rules enable row level security;
alter table public.b2b_group_outbox enable row level security;
revoke all on public.b2b_group_rules,public.b2b_group_outbox from public,anon,authenticated;
grant all on public.b2b_group_rules,public.b2b_group_outbox to service_role;
-- A private trigger must write on behalf of imports, without granting callers queue access.
create function crm_private.capture_group_b2b() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.b2b_group_outbox(owner_id,group_id,lead_id,connection_id)
 select new.owner_id,new.group_id,new.id,r.connection_id from public.b2b_group_rules r
 join public.lead_groups g on g.id=r.group_id and g.owner_id=r.owner_id
 where r.group_id=new.group_id and r.owner_id=new.owner_id and r.enabled
 on conflict(lead_id,connection_id) do nothing;
 return new;
end $$;
revoke all on function crm_private.capture_group_b2b() from public,anon,authenticated;
create trigger capture_group_b2b after insert on public.leads for each row execute function crm_private.capture_group_b2b();
-- All rule changes go through the already authenticated admin Edge Function.
create function public.b2b_set_group_rule(p_owner uuid,p_group uuid,p_connection uuid,p_enabled boolean) returns void language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from public.crm_profiles where id=p_owner and role='admin' and active) then raise exception 'Admin access required'; end if;
 perform 1 from public.lead_groups where id=p_group and owner_id=p_owner for update;
 if not found then raise exception 'Group unavailable'; end if;
 if p_enabled and not exists(select 1 from public.b2bbricks_connections where id=p_connection and owner_id=p_owner and active and contract_confirmed and not archived and webhook_url<>'') then raise exception 'Choose an active configured B2BBricks connection'; end if;
 if p_enabled then
  insert into public.b2b_group_rules(group_id,owner_id,connection_id,enabled) values(p_group,p_owner,p_connection,true)
  on conflict(group_id) do update set connection_id=excluded.connection_id,enabled=true,updated_at=now();
 else
  update public.b2b_group_rules set enabled=false,updated_at=now() where group_id=p_group and owner_id=p_owner;
 end if;
 update public.b2b_group_outbox set status='Skipped',error_message='Group automation disabled or destination changed'
 where group_id=p_group and owner_id=p_owner and status in ('Pending','Failed') and (not p_enabled or connection_id<>p_connection);
end $$;
revoke all on function public.b2b_set_group_rule(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.b2b_set_group_rule(uuid,uuid,uuid,boolean) to service_role;
-- Enqueue + acknowledgment in one transaction; the outbox ID is the idempotency key.
create function public.b2b_enqueue_group_item(p_id uuid,p_version integer,p_mapping jsonb,p_entry jsonb) returns uuid language plpgsql set search_path='' as $$
declare o public.b2b_group_outbox; g public.lead_groups; batch uuid;
begin
 select * into o from public.b2b_group_outbox where id=p_id for update;
 if not found then return null; end if;
 if o.status='Queued' then return o.id; end if;
 if o.status<>'Pending' then return null; end if;
 select * into g from public.lead_groups where id=o.group_id and owner_id=o.owner_id for update;
 if not found or not exists(select 1 from public.b2b_group_rules where group_id=o.group_id and owner_id=o.owner_id and connection_id=o.connection_id and enabled)
 or not exists(select 1 from public.leads where id=o.lead_id and owner_id=o.owner_id and group_id=o.group_id) then
  update public.b2b_group_outbox set status='Skipped',error_message='Lead moved or automation disabled' where id=o.id; return null;
 end if;
 if p_entry->'lead'->>'id' is distinct from o.lead_id::text then raise exception 'Lead mismatch'; end if;
 batch=public.b2b_enqueue(o.owner_id,o.connection_id,p_version,o.id,left(g.name||' · group automation',150),g.id,p_mapping,jsonb_build_array(p_entry),false,false,false);
 update public.b2b_group_outbox set status='Queued',error_message='' where id=o.id;
 return batch;
end $$;
revoke all on function public.b2b_enqueue_group_item(uuid,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.b2b_enqueue_group_item(uuid,integer,jsonb,jsonb) to service_role;

-- A group rule takes priority over connection-level routing.
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
 if i.b2b_connection_id is not null and r->>'outcome'='created' and not exists(select 1 from public.b2b_group_rules where group_id=i.group_id and owner_id=i.owner_id and enabled) then
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
