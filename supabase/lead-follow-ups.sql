alter table public.leads add column if not exists follow_up_at timestamptz;
alter table public.leads add column if not exists follow_up_done boolean not null default false;
alter table public.leads drop constraint leads_status_check;
alter table public.leads add constraint leads_status_check check(status in ('Connected','Not Connected','Planning','Meeting','Not Picked Up','Not Interested','Interested','Wrong Number','Follow Up'));
create index if not exists leads_pending_follow_up on public.leads(assigned_to,follow_up_at) where follow_up_at is not null and not follow_up_done;
create or replace function crm_private.guard_lead_update()
returns trigger language plpgsql set search_path='' as $$
begin
 if not crm_private.is_admin() and not (current_user='postgres' and coalesce(current_setting('abestate.assignment_worker',true),'')='on') then
  if (to_jsonb(new)-array['status','remark','updated_at','follow_up_at','follow_up_done']) is distinct from (to_jsonb(old)-array['status','remark','updated_at','follow_up_at','follow_up_done']) then raise exception 'Callers can only change status, remark and follow-up';end if;
 end if;
 if new.follow_up_at is distinct from old.follow_up_at then
  if new.follow_up_at is not null and new.follow_up_at<=now() then raise exception 'Choose a future follow-up date and time';end if;
  new.follow_up_done=false;
 end if;
 if new.status='Follow Up' and new.follow_up_at is null then raise exception 'Choose a follow-up date and time';end if;
 if new.assigned_to is distinct from old.assigned_to then
  if new.assigned_to is not null and not exists(select 1 from public.crm_profiles where id=new.assigned_to and role='caller' and active) then raise exception 'Choose an active caller';end if;
  new.assigned_at=case when new.assigned_to is null then null else now() end;
 end if;
 new.updated_at=now();return new;
end $$;
