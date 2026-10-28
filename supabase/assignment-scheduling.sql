-- Additive AB Estate assignment queue and notification outbox.
create table public.assignment_schedules(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references public.crm_profiles(id),
 caller_id uuid not null references public.crm_profiles(id),name text not null,
 mode text not null check(mode in ('interval','spread')),batch_size int not null check(batch_size between 1 and 100),
 interval_seconds int not null check(interval_seconds between 60 and 2678400),
 work_start time,work_end time, next_at timestamptz not null,
 status text not null default 'Active' check(status in ('Active','Paused','Cancelled','Completed')),
 created_at timestamptz not null default now(),check((work_start is null and work_end is null) or (work_start is not null and work_end>work_start))
);
create table public.assignment_items(
 id uuid primary key default gen_random_uuid(),schedule_id uuid not null references public.assignment_schedules(id) on delete cascade,
 lead_id uuid references public.leads(id) on delete set null,position int not null,
 status text not null default 'Pending' check(status in ('Pending','Assigned','Skipped','Cancelled')),
 released_at timestamptz,reason text,unique(schedule_id,position)
);
create unique index assignment_one_pending on public.assignment_items(lead_id) where status='Pending';
create index assignment_due on public.assignment_schedules(next_at) where status='Active';
create index assignment_item_schedule on public.assignment_items(schedule_id,position);
alter table public.assignment_schedules enable row level security;
alter table public.assignment_items enable row level security;
grant select on public.assignment_schedules,public.assignment_items to authenticated;
create policy schedules_read on public.assignment_schedules for select to authenticated using(owner_id=auth.uid() and crm_private.is_admin());
create policy items_read on public.assignment_items for select to authenticated using(exists(select 1 from public.assignment_schedules s where s.id=schedule_id and s.owner_id=auth.uid()) and crm_private.is_admin());

create function crm_private.assignment_slot(t timestamptz,a time,b time) returns timestamptz language plpgsql immutable set search_path='' as $$
declare local_t timestamp:=t at time zone 'Asia/Kolkata';
begin
 if a is null then return t;end if;
 if local_t::time<a then return (local_t::date+a) at time zone 'Asia/Kolkata';end if;
 if local_t::time>=b then return ((local_t::date+1)+a) at time zone 'Asia/Kolkata';end if;
 return t;
end $$;

create function public.crm_schedule_assignments(p_ids uuid[],p_caller uuid,p_name text,p_mode text,p_batch int,p_hours numeric,p_start timestamptz,p_work_start time default null,p_work_end time default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid; n int; step_seconds int;
begin
 if not crm_private.is_admin() then raise exception 'Admin access required';end if;
 if cardinality(p_ids) not between 1 and 5000 or p_ids is null then raise exception 'Select 1–5000 leads';end if;
 if p_batch is null or p_batch not between 1 and 100 or p_hours is null or p_hours<1 or p_hours>744 or p_mode is null or p_mode not in ('interval','spread') or nullif(trim(p_name),'') is null or length(p_name)>150 then raise exception 'Invalid schedule settings';end if;
 if (p_work_start is null)<>(p_work_end is null) or p_work_end<=p_work_start then raise exception 'Working hours must finish after they start';end if;
 if not exists(select 1 from public.crm_profiles where id=p_caller and role='caller' and active) then raise exception 'Choose an active caller';end if;
 perform 1 from public.leads where id=any(p_ids) order by id for update;
 select count(*) into n from public.leads where id=any(p_ids) and owner_id=auth.uid() and assigned_to is null;
 if n<>cardinality(p_ids) then raise exception 'Select only your unassigned leads; remove duplicates or already assigned leads';end if;
 if exists(select 1 from public.assignment_items where lead_id=any(p_ids) and status='Pending') then raise exception 'Some leads are already in a schedule. Cancel that schedule first';end if;
 step_seconds=case when p_mode='spread' then greatest(60,ceil(p_hours*3600/greatest(1,ceil(n::numeric/p_batch)-1))) else ceil(p_hours*3600) end;
 insert into public.assignment_schedules(owner_id,caller_id,name,mode,batch_size,interval_seconds,work_start,work_end,next_at)
 values(auth.uid(),p_caller,trim(p_name),p_mode,p_batch,step_seconds,p_work_start,p_work_end,crm_private.assignment_slot(greatest(coalesce(p_start,now()),now()),p_work_start,p_work_end)) returning id into sid;
 insert into public.assignment_items(schedule_id,lead_id,position) select sid,v,ord::int from unnest(p_ids) with ordinality x(v,ord);
 return sid;
end $$;
revoke all on function public.crm_schedule_assignments(uuid[],uuid,text,text,int,numeric,timestamptz,time,time) from public,anon;
grant execute on function public.crm_schedule_assignments(uuid[],uuid,text,text,int,numeric,timestamptz,time,time) to authenticated;

create function public.crm_control_schedule(p_id uuid,p_action text) returns void language plpgsql security definer set search_path='' as $$
declare s public.assignment_schedules;
begin
 if not crm_private.is_admin() then raise exception 'Admin access required';end if;
 select * into s from public.assignment_schedules where id=p_id and owner_id=auth.uid() for update;
 if not found then raise exception 'Schedule unavailable';end if;
 if p_action='pause' and s.status='Active' then update public.assignment_schedules set status='Paused' where id=s.id;
 elsif p_action='resume' and s.status='Paused' then update public.assignment_schedules set status='Active',next_at=crm_private.assignment_slot(greatest(next_at,now()),work_start,work_end) where id=s.id;
 elsif p_action='cancel' and s.status in ('Active','Paused') then
  update public.assignment_schedules set status='Cancelled' where id=s.id;
  update public.assignment_items set status='Cancelled',reason='Cancelled by administrator' where schedule_id=s.id and status='Pending';
 else raise exception 'Schedule action unavailable';end if;
end $$;
revoke all on function public.crm_control_schedule(uuid,text) from public,anon;
grant execute on function public.crm_control_schedule(uuid,text) to authenticated;

-- The existing caller update guard still applies; only this trusted worker can
-- set the internal marker while running as the database owner.
create or replace function crm_private.guard_lead_update() returns trigger language plpgsql set search_path='' as $$
begin
 if not crm_private.is_admin() and not (current_user='postgres' and coalesce(current_setting('abestate.assignment_worker',true),'')='on') then
  if (to_jsonb(new)-array['status','remark','updated_at']) is distinct from (to_jsonb(old)-array['status','remark','updated_at']) then raise exception 'Callers can only change status and remark';end if;
 end if;
 if new.assigned_to is distinct from old.assigned_to then
  if new.assigned_to is not null and not exists(select 1 from public.crm_profiles where id=new.assigned_to and role='caller' and active) then raise exception 'Choose an active caller';end if;
  new.assigned_at=case when new.assigned_to is null then null else now() end;
 end if;
 new.updated_at=now();return new;
end $$;

create function crm_private.release_assignments() returns int language plpgsql security definer set search_path='' as $$
declare s public.assignment_schedules;i public.assignment_items;l public.leads;n int:=0;k int;slot timestamptz;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('abestate-assignment-release',0)) then return 0;end if;
 perform set_config('abestate.assignment_worker','on',true);
 for s in select * from public.assignment_schedules where status='Active' and next_at<=now() order by next_at limit 50 for update skip locked loop
  if not exists(select 1 from public.crm_profiles where id=s.caller_id and role='caller' and active) or not exists(select 1 from public.crm_profiles where id=s.owner_id and role='admin' and active) then
   update public.assignment_schedules set status='Paused' where id=s.id;continue;
  end if;
  slot=crm_private.assignment_slot(now(),s.work_start,s.work_end);
  if slot>now() then update public.assignment_schedules set next_at=slot where id=s.id;continue;end if;
  k=0;
  for i in select * from public.assignment_items where schedule_id=s.id and status='Pending' order by position limit s.batch_size for update loop
   select * into l from public.leads where id=i.lead_id for update;
   if not found or l.owner_id<>s.owner_id or l.assigned_to is not null then
    update public.assignment_items set status='Skipped',reason='Lead deleted or already assigned' where id=i.id;
   else
    update public.leads set assigned_to=s.caller_id where id=l.id;
    update public.assignment_items set status='Assigned',released_at=now() where id=i.id;
    n=n+1;k=k+1;
   end if;
  end loop;
  update public.assignment_schedules set
   status=case when exists(select 1 from public.assignment_items where schedule_id=s.id and status='Pending') then 'Active' else 'Completed' end,
   next_at=crm_private.assignment_slot(now()+make_interval(secs=>s.interval_seconds),s.work_start,s.work_end)
   where id=s.id;
 end loop;
 perform set_config('abestate.assignment_worker','off',true);
 return n;
end $$;
revoke all on function crm_private.release_assignments() from public,anon,authenticated;
select cron.schedule('abestate-assignment-release','* * * * *','select crm_private.release_assignments()');

-- Per-device push subscriptions; private keys stay server-side.
create table public.crm_push_subscriptions(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.crm_profiles(id) on delete cascade,
 endpoint text not null unique,p256dh text not null,auth_key text not null,created_at timestamptz not null default now()
);
alter table public.crm_push_subscriptions enable row level security;
create table public.crm_assignment_notifications(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.crm_profiles(id),
 lead_id uuid references public.leads(id) on delete cascade,assigned_at timestamptz not null,
 created_at timestamptz not null default now(),read_at timestamptz
);
alter table public.crm_assignment_notifications enable row level security;
grant select on public.crm_assignment_notifications to authenticated;
create policy notification_read on public.crm_assignment_notifications for select to authenticated using(user_id=auth.uid() and crm_private.is_active() and exists(select 1 from public.leads l where l.id=lead_id and l.assigned_to=auth.uid()));
create function public.crm_read_notification(p_id uuid) returns void language sql security definer set search_path='' as $$
 update public.crm_assignment_notifications set read_at=now() where id=p_id and user_id=auth.uid();
$$;
revoke all on function public.crm_read_notification(uuid) from public,anon;
grant execute on function public.crm_read_notification(uuid) to authenticated;
create table public.crm_push_outbox(
 id uuid primary key default gen_random_uuid(),notification_id uuid not null references public.crm_assignment_notifications(id) on delete cascade,
 subscription_id uuid not null references public.crm_push_subscriptions(id) on delete cascade,
 status text not null default 'Pending',attempts int not null default 0,next_at timestamptz not null default now(),locked_at timestamptz,error text,
 unique(notification_id,subscription_id)
);
alter table public.crm_push_outbox enable row level security;
create index crm_push_due on public.crm_push_outbox(next_at) where status='Pending';
create function crm_private.assignment_notify() returns trigger language plpgsql security definer set search_path='' as $$
declare nid uuid;
begin
 if new.assigned_to is not null and (tg_op='INSERT' or new.assigned_to is distinct from old.assigned_to) then
  insert into public.crm_assignment_notifications(user_id,lead_id,assigned_at) values(new.assigned_to,new.id,coalesce(new.assigned_at,now())) returning id into nid;
  insert into public.crm_push_outbox(notification_id,subscription_id) select nid,id from public.crm_push_subscriptions where user_id=new.assigned_to;
 end if;
 return new;
end $$;
create trigger lead_assignment_notify after insert or update of assigned_to on public.leads for each row execute function crm_private.assignment_notify();
create table crm_private.push_settings(id boolean primary key default true check(id),public_key text not null,private_key text not null,worker_hash text not null);
alter table crm_private.push_settings enable row level security;
create function public.crm_push_settings() returns jsonb language sql security definer set search_path='' as $$select to_jsonb(s) from crm_private.push_settings s where id;$$;
revoke all on function public.crm_push_settings() from public,anon,authenticated;
grant execute on function public.crm_push_settings() to service_role;
grant all on public.crm_push_subscriptions,public.crm_push_outbox,public.crm_assignment_notifications to service_role;
create function public.crm_claim_push() returns setof public.crm_push_outbox language sql security definer set search_path='' as $$
 update public.crm_push_outbox set status='Sending',locked_at=now(),attempts=attempts+1
 where id in (select id from public.crm_push_outbox where (status='Pending' and next_at<=now()) or (status='Sending' and locked_at<now()-interval '5 minutes') order by next_at limit 30 for update skip locked)
 returning *;
$$;
revoke all on function public.crm_claim_push() from public,anon,authenticated;
grant execute on function public.crm_claim_push() to service_role;
