create or replace function public.crm_delete_group_keep_leads(p_group uuid) returns integer language plpgsql security invoker set search_path='' as $$
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
