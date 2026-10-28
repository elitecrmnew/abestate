-- Apply after crm-upgrade.sql. Active administrators can delete only their own leads.
create policy leads_delete_admin_owner on public.leads for delete to authenticated using ((select crm_private.is_admin()) and owner_id = (select auth.uid()));
