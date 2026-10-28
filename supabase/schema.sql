-- Run in Supabase SQL Editor after creating your administrator in Authentication > Users.
-- Stage 1: every group is owned by the currently authenticated administrator.
create extension if not exists pgcrypto;
create table if not exists public.lead_groups (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 name text not null check (length(trim(name)) > 0),
 created_at timestamptz not null default now()
);
create table if not exists public.leads (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 group_id uuid not null references public.lead_groups(id) on delete cascade,
 source_lead_id text,
 customer_name text not null default '',
 budget text not null default '',
 phone_numbers text[] not null default '{}',
 email text not null default '',
 source text not null default '',
 campaign_name text not null default '',
 original_lead_date timestamptz,
 created_at timestamptz not null default now()
);
create index if not exists leads_group_idx on public.leads(group_id);
create index if not exists leads_owner_idx on public.leads(owner_id);
alter table public.lead_groups enable row level security;
alter table public.leads enable row level security;
revoke all on public.lead_groups,public.leads from anon;
grant select,insert,update,delete on public.lead_groups,public.leads to authenticated;
create policy "owner reads groups" on public.lead_groups for select to authenticated using (owner_id = (select auth.uid()));
create policy "owner creates groups" on public.lead_groups for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "owner updates groups" on public.lead_groups for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owner deletes groups" on public.lead_groups for delete to authenticated using (owner_id = (select auth.uid()));
create policy "owner reads leads" on public.leads for select to authenticated using (owner_id = (select auth.uid()));
create policy "owner creates leads" on public.leads for insert to authenticated with check (owner_id = (select auth.uid()) and exists (select 1 from public.lead_groups g where g.id = group_id and g.owner_id = (select auth.uid())));
create policy "owner updates leads" on public.leads for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()) and exists (select 1 from public.lead_groups g where g.id = group_id and g.owner_id = (select auth.uid())));
create policy "owner deletes leads" on public.leads for delete to authenticated using (owner_id = (select auth.uid()));
