
lock table public.lead_groups, public.leads in share row exclusive mode;
do $$
declare duplicate record; previous_uid text:=current_setting('request.jwt.claim.sub',true);
begin
 for duplicate in
 select id,owner_id,canonical from (
 select id,owner_id,first_value(id) over(partition by owner_id,lower(regexp_replace(btrim(name),'\s+',' ','g')) order by created_at,id) canonical
 from public.lead_groups) ranked where id<>canonical
 loop
  if not exists(select 1 from public.crm_profiles where id=duplicate.owner_id and role='admin' and active) then
   raise exception 'Group owner is not an active administrator';
  end if;
  perform set_config('request.jwt.claim.sub',duplicate.owner_id::text,true);
  update public.leads set group_id=duplicate.canonical where group_id=duplicate.id;
  delete from public.lead_groups where id=duplicate.id;
 end loop;
 perform set_config('request.jwt.claim.sub',coalesce(previous_uid,''),true);
end $$;
create unique index lead_groups_owner_normalized_name_unique on public.lead_groups(owner_id,lower(regexp_replace(btrim(name),'\s+',' ','g')));
create function public.crm_get_or_create_group(p_name text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare result_id uuid; clean_name text:=regexp_replace(btrim(p_name),'\s+',' ','g');
begin
 if auth.uid() is null or not crm_private.is_admin() then raise exception 'Admin access required';end if;
 if clean_name is null or clean_name='' or length(clean_name)>150 then raise exception 'Enter a group name between 1 and 150 characters';end if;
 insert into public.lead_groups(owner_id,name) values(auth.uid(),clean_name)
 on conflict (owner_id,lower(regexp_replace(btrim(name),'\s+',' ','g')))
 do update set name=lead_groups.name
 returning id into result_id;
 return result_id;
end $$;
revoke all on function public.crm_get_or_create_group(text) from public,anon;
grant execute on function public.crm_get_or_create_group(text) to authenticated;

