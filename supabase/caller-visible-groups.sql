-- Return names only for groups the signed-in account can use.
-- Caller lead access remains governed by existing RLS; queued leads are excluded.
create or replace function public.crm_visible_lead_groups()
returns table(id uuid,name text) language sql stable security definer set search_path='' as $$
 select g.id,g.name from public.lead_groups g
 where crm_private.is_active() and (
  (crm_private.is_admin() and g.owner_id=auth.uid()) or
  (not crm_private.is_admin() and exists(select 1 from public.leads l where l.group_id=g.id and l.assigned_to=auth.uid()))
 ) order by g.name;
$$;
revoke all on function public.crm_visible_lead_groups() from public,anon;
grant execute on function public.crm_visible_lead_groups() to authenticated;
