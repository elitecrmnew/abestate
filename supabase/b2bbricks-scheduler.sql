create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
-- Generate the worker credential inside Postgres. Never expose it to clients or logs.
do $$ declare token text;begin
 if not exists(select 1 from vault.secrets where name='abestate_b2b_worker') then
  token=encode(extensions.gen_random_bytes(32),'hex');
  perform vault.create_secret(token,'abestate_b2b_worker','AB Estate outbound queue worker');
 else select decrypted_secret into token from vault.decrypted_secrets where name='abestate_b2b_worker';end if;
 insert into public.b2bbricks_worker_state(id,token_hash) values(true,encode(extensions.digest(token,'sha256'),'hex'))
 on conflict(id) do update set token_hash=excluded.token_hash;
end $$;
create function crm_private.b2b_tick() returns void language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from public.b2bbricks_deliveries d join public.b2bbricks_connections c on c.id=d.connection_id where d.status='Sending' or (d.status='Pending' and c.active and not c.archived)) then
  perform net.http_post(url:='https://yosldtcsplksidtwfmty.supabase.co/functions/v1/b2bbricks-worker',
   headers:=jsonb_build_object('Content-Type','application/json','x-worker-token',(select decrypted_secret from vault.decrypted_secrets where name='abestate_b2b_worker')),
   body:='{}'::jsonb,timeout_milliseconds:=55000);
 end if;
end $$;
revoke all on function crm_private.b2b_tick() from public,anon,authenticated;
select cron.schedule('abestate-b2bbricks-worker','* * * * *','select crm_private.b2b_tick()');
