-- Remove a group while preserving its leads and assignment/delivery history.
alter table public.leads alter column group_id drop not null;
alter table public.leads drop constraint leads_group_id_fkey;
alter table public.leads add constraint leads_group_id_fkey foreign key(group_id) references public.lead_groups(id) on delete set null;
-- Keep group reads as before, but require ownership for every mutation.
drop policy groups_admin on public.lead_groups;
create policy groups_admin_read on public.lead_groups for select to authenticated using ((select crm_private.is_admin()));
create policy groups_admin_insert on public.lead_groups for insert to authenticated with check ((select crm_private.is_admin()) and owner_id=(select auth.uid()));
create policy groups_admin_update on public.lead_groups for update to authenticated using ((select crm_private.is_admin()) and owner_id=(select auth.uid())) with check ((select crm_private.is_admin()) and owner_id=(select auth.uid()));
create policy groups_admin_delete on public.lead_groups for delete to authenticated using ((select crm_private.is_admin()) and owner_id=(select auth.uid()));
create function public.crm_delete_group_keep_leads(p_group uuid) returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 if not exists(select 1 from public.crm_profiles where id=auth.uid() and role='admin' and active) then raise exception 'Admin access required'; end if;
 perform 1 from public.lead_groups where id=p_group and owner_id=auth.uid() for update;
 if not found then raise exception 'Group unavailable or already deleted'; end if;
 if exists(select 1 from public.crm_integrations where group_id=p_group) then raise exception 'This group is linked to an incoming integration. Change its destination group in Integrations first.'; end if;
 select count(*) into n from public.leads where group_id=p_group;
 delete from public.lead_groups where id=p_group and owner_id=auth.uid();
 return n;
end $$;
revoke all on function public.crm_delete_group_keep_leads(uuid) from public,anon;
grant execute on function public.crm_delete_group_keep_leads(uuid) to authenticated;
