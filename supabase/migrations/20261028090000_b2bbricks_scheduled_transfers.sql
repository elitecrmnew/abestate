alter table public.b2bbricks_deliveries
  add column if not exists scheduled_at timestamptz;

create index if not exists b2bbricks_deliveries_scheduled_pending_idx
  on public.b2bbricks_deliveries (scheduled_at, created_at, id)
  where status = 'Pending';

create or replace function public.b2b_enqueue(
 p_owner uuid, p_connection uuid, p_version integer, p_batch uuid,
 p_name text, p_group uuid, p_mapping jsonb, p_entries jsonb,
 p_force boolean default false, p_test boolean default false, p_track boolean default false
) returns uuid
language plpgsql
set search_path to ''
as $function$
declare c public.b2bbricks_connections; e jsonb; l jsonb; lid uuid; st text; err text; mob text; scheduled timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('b2b:'||p_connection::text,0));
 if exists(select 1 from public.b2bbricks_batches where id=p_batch and owner_id=p_owner) then return p_batch; end if;
 select * into c from public.b2bbricks_connections where id=p_connection and owner_id=p_owner and not archived for update;
 if not found or not c.active or not c.contract_confirmed or c.webhook_url='' then raise exception 'Connection is not configured and active'; end if;
 if c.version<>p_version then raise exception 'Connection changed. Preview again'; end if;
 if not exists(select 1 from public.crm_profiles where id=p_owner and role='admin' and active) then raise exception 'Admin access required'; end if;
 if p_group is not null and not exists(select 1 from public.lead_groups where id=p_group and owner_id=p_owner) then raise exception 'Group unavailable'; end if;
 if jsonb_array_length(p_entries) not between 1 and 5000 then raise exception 'Select 1 to 5000 leads'; end if;
 insert into public.b2bbricks_batches(id,owner_id,connection_id,group_id,name,mapping,connection_version,created_by,is_test,track_test)
 values(p_batch,p_owner,c.id,p_group,left(p_name,150),p_mapping,c.version,p_owner,p_test,p_track);
 for e in select value from jsonb_array_elements(p_entries) loop
  lid=null; l=e->'lead'; mob=coalesce(e->>'mobile',''); st='Pending'; err=null; scheduled=null;
  if coalesce(e->>'error','')<>'' or mob!~'^[+]91[6-9][0-9]{9}$' then st='Skipped'; err=coalesce(nullif(e->>'error',''),'Invalid Indian mobile'); end if;
  if nullif(l->>'id','') is not null then
   select id into lid from public.leads where id=(l->>'id')::uuid and owner_id=p_owner;
   if lid is null then raise exception 'Lead unavailable'; end if;
  elsif st='Pending' and (not p_test or p_track) then
   if p_group is null then raise exception 'Choose a group for imported leads'; end if;
   perform pg_advisory_xact_lock(hashtextextended('b2b-import:'||p_owner::text,0));
   select x.id into lid from public.leads x where x.owner_id=p_owner and (
    (nullif(l->>'source_lead_id','') is not null and x.source_lead_id=l->>'source_lead_id') or
    exists(select 1 from unnest(x.phone_numbers) n where right(regexp_replace(n,'[^0-9]','','g'),10)=right(mob,10))
   ) order by created_at limit 1;
   if lid is null then
    insert into public.leads(owner_id,group_id,source_lead_id,customer_name,phone_numbers,email,budget,source,campaign_name,original_lead_date,remark,imported_fields)
    values(p_owner,p_group,nullif(l->>'source_lead_id',''),coalesce(l->>'customer_name',''),array[mob],coalesce(l->>'email',''),coalesce(l->>'budget',''),coalesce(l->>'source',''),coalesce(l->>'campaign_name',''),nullif(l->>'original_lead_date','')::timestamptz,coalesce(l->>'remark',''),coalesce(l->'imported_fields','{}')) returning id into lid;
   end if;
  end if;
  if st='Pending' and not(p_test and not p_track) and exists(select 1 from public.b2bbricks_deliveries d
    where d.connection_id=c.id and not d.dedupe_exempt and (d.mobile=mob or (lid is not null and d.lead_id=lid))
    and (d.status in ('Pending','Sending') or d.requires_review or (not p_force and d.status='Sent'))
  ) then st='Duplicate'; err='Already sent, queued, or awaiting verification'; end if;
  if st='Pending' and not(p_test and not p_track) and nullif(e->>'scheduled_at','') is not null then
   scheduled=(e->>'scheduled_at')::timestamptz;
   if scheduled < now() then scheduled=now(); end if;
  end if;
  insert into public.b2bbricks_deliveries(owner_id,batch_id,lead_id,connection_id,mobile,customer_name,email,project,payload,status,error_message,force_resend,dedupe_exempt,scheduled_at)
  values(p_owner,p_batch,lid,c.id,mob,coalesce(l->>'customer_name',''),coalesce(l->>'email',''),coalesce(e->>'project',''),coalesce(e->'payload','{}'),st,err,p_force,p_test and not p_track,scheduled);
 end loop;
 perform public.b2b_refresh_batch(p_batch); return p_batch;
end $function$;

create or replace function public.b2b_claim(p_lease uuid)
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare d public.b2bbricks_deliveries; old record;
begin
 if not exists(select 1 from public.b2bbricks_worker_state where lease_id=p_lease and lease_until>now()) then return null; end if;
 for old in
  update public.b2bbricks_deliveries
  set status='Failed',requires_review=true,error_message='Worker interrupted. Check B2BBricks before retrying; delivery may have succeeded.'
  where status='Sending' and started_at<now()-interval '5 minutes'
  returning batch_id
 loop perform public.b2b_refresh_batch(old.batch_id); end loop;
 select x.* into d
 from public.b2bbricks_deliveries x
 join public.b2bbricks_connections c on c.id=x.connection_id
 join public.b2bbricks_batches b on b.id=x.batch_id
 join public.crm_profiles p on p.id=x.owner_id
 where x.status='Pending'
  and (x.scheduled_at is null or x.scheduled_at<=now())
  and c.active and not c.archived and c.contract_confirmed and c.version=b.connection_version
  and c.next_send_at<=now() and p.active and p.role='admin'
 order by coalesce(x.scheduled_at,x.created_at),x.created_at,x.id
 limit 1 for update of x skip locked;
 if not found then return null; end if;
 update public.b2bbricks_deliveries set status='Sending',started_at=now() where id=d.id returning * into d;
 perform public.b2b_refresh_batch(d.batch_id); return to_jsonb(d);
end $function$;
