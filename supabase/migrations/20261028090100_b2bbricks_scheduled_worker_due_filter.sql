create or replace function crm_private.b2b_tick()
 returns void
 language plpgsql
 set search_path to ''
as $function$
begin
 if exists(
  select 1
  from public.b2bbricks_deliveries d
  join public.b2bbricks_connections c on c.id=d.connection_id
  where d.status='Sending'
     or (d.status='Pending'
         and (d.scheduled_at is null or d.scheduled_at<=now())
         and c.active and not c.archived)
 ) then
  perform net.http_post(
   url:='https://yosldtcsplksidtwfmty.supabase.co/functions/v1/b2bbricks-worker',
   headers:=jsonb_build_object('Content-Type','application/json','x-worker-token',(select decrypted_secret from vault.decrypted_secrets where name='abestate_b2b_worker')),
   body:='{}'::jsonb,
   timeout_milliseconds:=55000
  );
 end if;
end $function$;