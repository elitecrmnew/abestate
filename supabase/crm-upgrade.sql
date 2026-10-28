
create table public.crm_profiles(
 id uuid primary key references auth.users(id) on delete cascade,
 username text not null unique check(username ~ '^[a-z0-9._-]{3,40}$'),
 display_name text not null,
 role text not null check(role in ('admin','caller')),
 active boolean not null default true,
 created_at timestamptz not null default now()
);
alter table public.crm_profiles enable row level security;
create schema if not exists crm_private;
revoke all on schema crm_private from public;
grant usage on schema crm_private to authenticated;
create function crm_private.is_admin() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.crm_profiles where id=auth.uid() and role='admin' and active);
$$;
create function crm_private.is_active() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.crm_profiles where id=auth.uid() and active);
$$;
revoke all on function crm_private.is_admin(),crm_private.is_active() from public,anon;
grant execute on function crm_private.is_admin(),crm_private.is_active() to authenticated;
create policy profiles_read on public.crm_profiles for select to authenticated using(id=(select auth.uid()) or (select crm_private.is_admin()));
grant select on public.crm_profiles to authenticated;
grant all on public.crm_profiles to service_role;
insert into public.crm_profiles(id,username,display_name,role)
select id,'admin','Administrator','admin' from auth.users where email='admin@abestate.com';
alter table public.leads
 add column assigned_to uuid references public.crm_profiles(id),
 add column assigned_at timestamptz,
 add column status text not null default 'Not Connected' check(status in ('Connected','Not Connected','Meeting','Planning')),
 add column remark text not null default '',
 add column updated_at timestamptz not null default now();
create index leads_assigned_to_idx on public.leads(assigned_to);
create unique index leads_source_unique on public.leads(owner_id,source_lead_id) where source_lead_id is not null;
do $$ declare p record; begin
for p in select policyname,tablename from pg_policies where schemaname='public' and tablename in ('leads','lead_groups') loop
execute format('drop policy %I on public.%I',p.policyname,p.tablename);
end loop;end $$;
create policy groups_admin on public.lead_groups for all to authenticated using((select crm_private.is_admin())) with check((select crm_private.is_admin()) and owner_id=(select auth.uid()));
create policy leads_read on public.leads for select to authenticated using((select crm_private.is_admin()) or (assigned_to=(select auth.uid()) and (select crm_private.is_active())));
create policy leads_insert on public.leads for insert to authenticated with check((select crm_private.is_admin()) and owner_id=(select auth.uid()) and exists(select 1 from public.lead_groups g where g.id=group_id and g.owner_id=auth.uid()));
create policy leads_update on public.leads for update to authenticated using((select crm_private.is_admin()) or (assigned_to=(select auth.uid()) and (select crm_private.is_active()))) with check((select crm_private.is_admin()) or (assigned_to=(select auth.uid()) and (select crm_private.is_active())));
create function crm_private.guard_lead_update() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if not crm_private.is_admin() then
  if (to_jsonb(new)-array['status','remark','updated_at']) is distinct from (to_jsonb(old)-array['status','remark','updated_at']) then
   raise exception 'Callers can only change status and remark';
  end if;
 end if;
 if new.assigned_to is distinct from old.assigned_to then
  if new.assigned_to is not null and not exists(select 1 from public.crm_profiles where id=new.assigned_to and role='caller' and active) then
   raise exception 'Choose an active caller';
  end if;
  new.assigned_at=case when new.assigned_to is null then null else now() end;
 end if;
 new.updated_at=now();
 return new;
end $$;
revoke all on function crm_private.guard_lead_update() from public,anon;
create trigger guard_lead_update before update on public.leads for each row execute function crm_private.guard_lead_update();
grant select,insert,update on public.leads to authenticated;
grant select,insert,update,delete on public.lead_groups to authenticated;
revoke all on public.leads,public.lead_groups,public.crm_profiles from anon;

