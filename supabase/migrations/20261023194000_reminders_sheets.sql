alter table public.crm_assignment_notifications add column kind text not null default 'assignment' check(kind in ('assignment','follow_up'));
alter table public.crm_assignment_notifications add column follow_up_at timestamptz;
create unique index crm_followup_notification_once on public.crm_assignment_notifications(user_id,lead_id,follow_up_at) where kind='follow_up';
drop policy notification_read on public.crm_assignment_notifications;
create policy notification_read on public.crm_assignment_notifications for select to authenticated using(
 user_id=(select auth.uid()) and (select crm_private.is_active()) and exists(select 1 from public.leads l where l.id=lead_id
 and (l.assigned_to=(select auth.uid()) or (l.assigned_to is null and l.owner_id=(select auth.uid()) and (select crm_private.is_admin())))
 and (kind='assignment' or (not l.follow_up_done and l.follow_up_at=crm_assignment_notifications.follow_up_at))));
create function crm_private.queue_followup_reminders() returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 with due as (
  select l.*,coalesce(l.assigned_to,l.owner_id) recipient from public.leads l
  join public.crm_profiles p on p.id=coalesce(l.assigned_to,l.owner_id) and p.active
  where l.follow_up_at<=now() and not l.follow_up_done
  and not exists(select 1 from public.crm_assignment_notifications n where n.lead_id=l.id and n.user_id=coalesce(l.assigned_to,l.owner_id) and n.kind='follow_up' and n.follow_up_at=l.follow_up_at)
  order by l.follow_up_at limit 200
 ), inserted as (
  insert into public.crm_assignment_notifications(user_id,lead_id,assigned_at,kind,follow_up_at)
  select recipient,id,coalesce(assigned_at,created_at),'follow_up',follow_up_at from due
  on conflict do nothing returning id,user_id
 ), queued as (
  insert into public.crm_push_outbox(notification_id,subscription_id)
  select n.id,s.id from inserted n join public.crm_push_subscriptions s on s.user_id=n.user_id
  on conflict do nothing returning id
 ) select count(*) into n from inserted;
 return n;
end $$;
revoke all on function crm_private.queue_followup_reminders() from public,anon,authenticated;
select cron.schedule('abestate-followup-reminders','* * * * *','select crm_private.queue_followup_reminders()');

alter table public.crm_integrations drop constraint crm_integrations_source_check;
alter table public.crm_integrations add constraint crm_integrations_source_check check(source in ('Website','99acres','API','Google Sheets'));
alter table public.crm_integrations add column b2b_connection_id uuid references public.b2bbricks_connections(id);
alter table public.crm_integrations add constraint integration_one_destination check(b2b_connection_id is null or assigned_to is null);
create index crm_integrations_b2b_idx on public.crm_integrations(b2b_connection_id);
grant select(b2b_connection_id) on public.crm_integrations to authenticated;

create or replace function public.crm_receive_lead(p_integration uuid,p_lead jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare i public.crm_integrations; lid uuid; ph text; sid text; result text;
begin
 select * into i from public.crm_integrations where id=p_integration and active for update;
 if not found then raise exception 'Connection unavailable'; end if;
 if exists(select 1 from public.crm_api_settings where owner_id=i.owner_id and not active) then raise exception 'API service is paused'; end if;
 if not exists(select 1 from public.crm_profiles where id=i.owner_id and role='admin' and active) then raise exception 'Connection unavailable'; end if;
 if not exists(select 1 from public.lead_groups where id=i.group_id and owner_id=i.owner_id) then raise exception 'Group unavailable'; end if;
 if i.assigned_to is not null and not exists(select 1 from public.crm_profiles where id=i.assigned_to and role='caller' and active) then raise exception 'Assigned caller is inactive'; end if;
 ph=p_lead->>'phone';
 if ph is null or ph !~ '^[+][1-9][0-9]{7,14}$' or length(coalesce(p_lead->>'name','')) not between 1 and 100 then raise exception 'Invalid lead'; end if;
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
 return jsonb_build_object('ok',true,'outcome',result,'lead_id',lid);
end $$;
revoke all on function public.crm_receive_lead(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.crm_receive_lead(uuid,jsonb) to service_role;
-- Atomic CRM insert + outbound enqueue. A failed enqueue rolls back the import,
-- allowing the Sheet adapter to retry without dropping or double-sending the lead.
create function public.crm_receive_routed_lead(p_integration uuid,p_lead jsonb,p_entry jsonb,p_version integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare i public.crm_integrations; c public.b2bbricks_connections; r jsonb; batch uuid;
begin
 select * into i from public.crm_integrations where id=p_integration and active for update;
 if not found then raise exception 'Connection unavailable'; end if;
 r=public.crm_receive_lead(p_integration,p_lead);
 if i.b2b_connection_id is not null and r->>'outcome'='created' then
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
