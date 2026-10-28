-- Additive outbound integration; existing lead records and roles are preserved.
alter table public.leads add column imported_fields jsonb not null default '{}';
create table public.b2bbricks_connections (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.crm_profiles(id),
 name text not null check(length(name) between 1 and 100), destination text not null default 'b2bbricks' check(destination='b2bbricks'),
 webhook_url text not null default '', headers jsonb not null default '{}',
 method text not null default 'POST' check(method in ('POST','PUT')),
 content_type text not null default 'application/json' check(content_type in ('application/json','application/x-www-form-urlencoded')),
 envelope text not null default '', success_codes int[] not null default '{200}', success_path text not null default '', success_value text not null default '',
 phone_format text not null default 'national' check(phone_format in ('national','e164','country')),
 default_project text not null default '', default_source text not null default '', default_remark text not null default '',
 mapping jsonb not null default '[]', contract_confirmed boolean not null default false,
 active boolean not null default false, archived boolean not null default false, version integer not null default 1,
 delay_ms integer not null default 1500 check(delay_ms between 1000 and 10000), next_send_at timestamptz not null default now(),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.b2bbricks_batches (
 id uuid primary key, owner_id uuid not null references public.crm_profiles(id),connection_id uuid not null references public.b2bbricks_connections(id),
 group_id uuid references public.lead_groups(id) on delete set null, name text not null, mapping jsonb not null,
 connection_version integer not null, is_test boolean not null default false, track_test boolean not null default false,
 total integer not null default 0, successful integer not null default 0, failed integer not null default 0,
 skipped integer not null default 0, duplicate integer not null default 0, pending integer not null default 0, sending integer not null default 0,
 created_by uuid not null references public.crm_profiles(id), created_at timestamptz not null default now(),started_at timestamptz,completed_at timestamptz
);
create table public.b2bbricks_deliveries (
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references public.crm_profiles(id),
 batch_id uuid not null references public.b2bbricks_batches(id),lead_id uuid references public.leads(id) on delete set null,
 connection_id uuid not null references public.b2bbricks_connections(id),mobile text not null default '',
 customer_name text not null default '',email text not null default '',project text not null default '',
 payload jsonb not null default '{}',status text not null check(status in ('Pending','Sending','Sent','Failed','Skipped','Duplicate')),
 response_status integer,response_body text,error_message text,retry_count integer not null default 0,
 requires_review boolean not null default false,force_resend boolean not null default false,dedupe_exempt boolean not null default false,
 sent_at timestamptz,started_at timestamptz,created_at timestamptz not null default now()
);
create table public.b2bbricks_attempts (
 id bigint generated always as identity primary key,delivery_id uuid not null references public.b2bbricks_deliveries(id),
 owner_id uuid not null references public.crm_profiles(id),status text not null,response_status integer,response_body text,error_message text,
 created_at timestamptz not null default now()
);
create table public.b2bbricks_worker_state (
 id boolean primary key default true check(id),token_hash text not null,lease_id uuid,lease_until timestamptz,last_run_at timestamptz
);
-- No browser access to connection secrets or worker credentials. All writes use the backend.
do $$ declare t text; begin
 foreach t in array array['b2bbricks_connections','b2bbricks_batches','b2bbricks_deliveries','b2bbricks_attempts','b2bbricks_worker_state'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 execute format('create policy backend_only on public.%I for all to service_role using (true) with check (true)',t);
 end loop;
end $$;
grant usage,select on sequence public.b2bbricks_attempts_id_seq to service_role;
create index b2b_connections_owner on public.b2bbricks_connections(owner_id);
create index b2b_batches_owner on public.b2bbricks_batches(owner_id,created_at desc);
create index b2b_batches_connection on public.b2bbricks_batches(connection_id);
create index b2b_batches_group on public.b2bbricks_batches(group_id);
create index b2b_batches_creator on public.b2bbricks_batches(created_by);
create index b2b_deliveries_queue on public.b2bbricks_deliveries(created_at) where status='Pending';
create index b2b_deliveries_mobile on public.b2bbricks_deliveries(connection_id,mobile,status);
create index b2b_deliveries_lead on public.b2bbricks_deliveries(connection_id,lead_id,status);
create index b2b_deliveries_batch on public.b2bbricks_deliveries(batch_id);
create index b2b_deliveries_owner on public.b2bbricks_deliveries(owner_id,created_at desc);
create index b2b_attempts_delivery on public.b2bbricks_attempts(delivery_id);
create index b2b_attempts_owner on public.b2bbricks_attempts(owner_id);

create function public.b2b_refresh_batch(p_batch uuid) returns void language sql security invoker set search_path='' as $$
 update public.b2bbricks_batches b set total=s.total,successful=s.sent,failed=s.failed,skipped=s.skipped,duplicate=s.duplicate,pending=s.pending,sending=s.sending,
 started_at=coalesce(b.started_at,s.started),completed_at=case when s.pending+s.sending=0 then coalesce(b.completed_at,now()) else null end
 from (select count(*)::int total,count(*) filter(where status='Sent')::int sent,count(*) filter(where status='Failed')::int failed,
 count(*) filter(where status='Skipped')::int skipped,count(*) filter(where status='Duplicate')::int duplicate,
 count(*) filter(where status='Pending')::int pending,count(*) filter(where status='Sending')::int sending,min(started_at) started
 from public.b2bbricks_deliveries where batch_id=p_batch) s where b.id=p_batch;
$$;

create function public.b2b_enqueue(p_owner uuid,p_connection uuid,p_version int,p_batch uuid,p_name text,p_group uuid,p_mapping jsonb,p_entries jsonb,p_force boolean default false,p_test boolean default false,p_track boolean default false)
returns uuid language plpgsql security invoker set search_path='' as $$
declare c public.b2bbricks_connections; e jsonb; l jsonb; lid uuid; st text; err text; mob text;
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
  lid=null; l=e->'lead'; mob=coalesce(e->>'mobile','');st='Pending';err=null;
  if coalesce(e->>'error','')<>'' or mob!~'^[+]91[6-9][0-9]{9}$' then st='Skipped';err=coalesce(nullif(e->>'error',''),'Invalid Indian mobile'); end if;
  if nullif(l->>'id','') is not null then
   select id into lid from public.leads where id=(l->>'id')::uuid and owner_id=p_owner;
   if lid is null then raise exception 'Lead unavailable'; end if;
  elsif st='Pending' and (not p_test or p_track) then
   if p_group is null then raise exception 'Choose a group for imported leads';end if;
   perform pg_advisory_xact_lock(hashtextextended('b2b-import:'||p_owner::text,0));
   select x.id into lid from public.leads x where x.owner_id=p_owner and (
    (nullif(l->>'source_lead_id','') is not null and x.source_lead_id=l->>'source_lead_id') or
    exists(select 1 from unnest(x.phone_numbers) n where right(regexp_replace(n,'[^0-9]','','g'),10)=right(mob,10))) order by created_at limit 1;
   if lid is null then
    insert into public.leads(owner_id,group_id,source_lead_id,customer_name,phone_numbers,email,budget,source,campaign_name,original_lead_date,remark,imported_fields)
    values(p_owner,p_group,nullif(l->>'source_lead_id',''),coalesce(l->>'customer_name',''),array[mob],coalesce(l->>'email',''),coalesce(l->>'budget',''),coalesce(l->>'source',''),coalesce(l->>'campaign_name',''),nullif(l->>'original_lead_date','')::timestamptz,coalesce(l->>'remark',''),coalesce(l->'imported_fields','{}')) returning id into lid;
   end if;
  end if;
  if st='Pending' and not(p_test and not p_track) and exists(select 1 from public.b2bbricks_deliveries d
    where d.connection_id=c.id and not d.dedupe_exempt and (d.mobile=mob or (lid is not null and d.lead_id=lid))
    and (d.status in ('Pending','Sending') or d.requires_review or (not p_force and d.status='Sent'))) then
    st='Duplicate';err='Already sent, queued, or awaiting verification';
  end if;
  insert into public.b2bbricks_deliveries(owner_id,batch_id,lead_id,connection_id,mobile,customer_name,email,project,payload,status,error_message,force_resend,dedupe_exempt)
  values(p_owner,p_batch,lid,c.id,mob,coalesce(l->>'customer_name',''),coalesce(l->>'email',''),coalesce(e->>'project',''),coalesce(e->'payload','{}'),st,err,p_force,p_test and not p_track);
 end loop;
 perform public.b2b_refresh_batch(p_batch);return p_batch;
end $$;

create function public.b2b_worker_lease(p_lease uuid) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.b2bbricks_worker_state set lease_id=p_lease,lease_until=now()+interval '55 seconds',last_run_at=now() where id and (lease_until is null or lease_until<now());
 return found;
end $$;
create function public.b2b_claim(p_lease uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.b2bbricks_deliveries; old record;
begin
 if not exists(select 1 from public.b2bbricks_worker_state where lease_id=p_lease and lease_until>now()) then return null;end if;
 for old in update public.b2bbricks_deliveries set status='Failed',requires_review=true,error_message='Worker interrupted. Check B2BBricks before retrying; delivery may have succeeded.' where status='Sending' and started_at<now()-interval '5 minutes' returning batch_id loop perform public.b2b_refresh_batch(old.batch_id);end loop;
 select x.* into d from public.b2bbricks_deliveries x join public.b2bbricks_connections c on c.id=x.connection_id join public.b2bbricks_batches b on b.id=x.batch_id
 join public.crm_profiles p on p.id=x.owner_id
 where x.status='Pending' and c.active and not c.archived and c.contract_confirmed and c.version=b.connection_version and c.next_send_at<=now() and p.active and p.role='admin'
 order by x.created_at,x.id limit 1 for update of x skip locked;
 if not found then return null;end if;
 update public.b2bbricks_deliveries set status='Sending',started_at=now() where id=d.id returning * into d;
 perform public.b2b_refresh_batch(d.batch_id);return to_jsonb(d);
end $$;
create function public.b2b_finish(p_id uuid,p_status text,p_http int,p_body text,p_error text,p_uncertain boolean,p_delay_ms int) returns void language plpgsql security invoker set search_path='' as $$
declare d public.b2bbricks_deliveries;
begin
 if p_status not in ('Sent','Failed') then raise exception 'Invalid delivery outcome';end if;
 update public.b2bbricks_deliveries set status=p_status,response_status=p_http,response_body=left(p_body,8000),error_message=left(p_error,2000),requires_review=p_uncertain,sent_at=case when p_status='Sent' then now() else sent_at end
 where id=p_id and status='Sending' returning * into d;
 if not found then return;end if;
 insert into public.b2bbricks_attempts(delivery_id,owner_id,status,response_status,response_body,error_message) values(d.id,d.owner_id,p_status,p_http,left(p_body,8000),left(p_error,2000));
 update public.b2bbricks_connections set next_send_at=now()+make_interval(secs=>greatest(1000,least(p_delay_ms,3600000))/1000.0) where id=d.connection_id;
 perform public.b2b_refresh_batch(d.batch_id);
end $$;
create function public.b2b_retry(p_owner uuid,p_batch uuid,p_ack boolean default false) returns int language plpgsql security invoker set search_path='' as $$
declare c uuid;d public.b2bbricks_deliveries;n int:=0;
begin
 select connection_id into c from public.b2bbricks_batches where id=p_batch and owner_id=p_owner;
 if c is null then raise exception 'Batch unavailable';end if;
 perform pg_advisory_xact_lock(hashtextextended('b2b:'||c::text,0));
 if not exists(select 1 from public.b2bbricks_connections x join public.b2bbricks_batches b on b.connection_id=x.id and b.id=p_batch where x.id=c and x.active and not x.archived and x.contract_confirmed and x.version=b.connection_version) then raise exception 'Connection changed or inactive. Create a fresh batch or activate the connection';end if;
 for d in select * from public.b2bbricks_deliveries where batch_id=p_batch and status='Failed' for update loop
  if d.requires_review and not p_ack then continue;end if;
  if not d.dedupe_exempt and exists(select 1 from public.b2bbricks_deliveries x where x.connection_id=c and x.id<>d.id and not x.dedupe_exempt and (x.mobile=d.mobile or x.lead_id=d.lead_id) and (x.status in ('Pending','Sending') or x.requires_review or (x.status='Sent' and not d.force_resend))) then continue;end if;
  update public.b2bbricks_deliveries set status='Pending',retry_count=retry_count+1,requires_review=false,error_message=null where id=d.id;n=n+1;
 end loop;
 perform public.b2b_refresh_batch(p_batch);return n;
end $$;
-- All queue primitives are service-only, never client RPCs.
do $$ declare f record;begin
 for f in select oid::regprocedure::text signature from pg_proc where pronamespace='public'::regnamespace and proname in ('b2b_refresh_batch','b2b_enqueue','b2b_worker_lease','b2b_claim','b2b_finish','b2b_retry') loop
 execute 'revoke all on function '||f.signature||' from public,anon,authenticated';
 execute 'grant execute on function '||f.signature||' to service_role';
 end loop;
end $$;
create function public.b2b_save_connection(p_owner uuid,p_id uuid,p_expected int,p_config jsonb) returns uuid language plpgsql security invoker set search_path='' as $$
declare c public.b2bbricks_connections;n public.b2bbricks_connections;
begin
 if not exists(select 1 from public.crm_profiles where id=p_owner and role='admin' and active) then raise exception 'Admin access required';end if;
 if p_id is null then
  insert into public.b2bbricks_connections(owner_id,name) values(p_owner,p_config->>'name') returning * into c;
 else
  perform pg_advisory_xact_lock(hashtextextended('b2b:'||p_id::text,0));
  select * into c from public.b2bbricks_connections where id=p_id and owner_id=p_owner and not archived for update;
  if not found or c.version<>p_expected then raise exception 'Connection changed. Reload settings';end if;
  if exists(select 1 from public.b2bbricks_deliveries where connection_id=p_id and status in ('Pending','Sending')) then raise exception 'Finish or cancel queued batches before editing connection settings';end if;
 end if;
 n=jsonb_populate_record(c,p_config);
 update public.b2bbricks_connections set name=n.name,webhook_url=n.webhook_url,headers=n.headers,method=n.method,content_type=n.content_type,envelope=n.envelope,
 success_codes=n.success_codes,success_path=n.success_path,success_value=n.success_value,phone_format=n.phone_format,default_project=n.default_project,default_source=n.default_source,default_remark=n.default_remark,
 mapping=n.mapping,contract_confirmed=n.contract_confirmed,active=n.active,delay_ms=n.delay_ms,version=c.version+1,updated_at=now() where id=c.id;
 return c.id;
end $$;
revoke all on function public.b2b_save_connection(uuid,uuid,int,jsonb) from public,anon,authenticated;
grant execute on function public.b2b_save_connection(uuid,uuid,int,jsonb) to service_role;
