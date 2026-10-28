do $$begin
 if not exists(select 1 from vault.secrets where name='abestate_push_worker') then
  perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'abestate_push_worker','Caller notification dispatcher');
 end if;
end $$;
create function crm_private.push_tick() returns void language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from public.crm_push_outbox where (status='Pending' and next_at<=now()) or (status='Sending' and locked_at<now()-interval '5 minutes')) then
  perform net.http_post(url:='https://yosldtcsplksidtwfmty.supabase.co/functions/v1/caller-push',
   headers:=jsonb_build_object('Content-Type','application/json','x-worker-token',(select decrypted_secret from vault.decrypted_secrets where name='abestate_push_worker')),
   body:='{}'::jsonb,timeout_milliseconds:=55000);
 end if;
end $$;
revoke all on function crm_private.push_tick() from public,anon,authenticated;
select cron.schedule('abestate-caller-push','* * * * *','select crm_private.push_tick()');

create function public.crm_assignment_summaries() returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('counts',(select jsonb_build_object(
 'Pending',count(*) filter(where status='Pending'),'Assigned',count(*) filter(where status='Assigned'),
 'Skipped',count(*) filter(where status='Skipped'),'Cancelled',count(*) filter(where status='Cancelled'))
 from public.assignment_items i where i.schedule_id=s.id)) order by s.created_at desc),'[]'::jsonb)
 from (select * from public.assignment_schedules where owner_id=auth.uid() and crm_private.is_admin() order by created_at desc limit 100) s;
$$;
revoke all on function public.crm_assignment_summaries() from public,anon;
grant execute on function public.crm_assignment_summaries() to authenticated;
