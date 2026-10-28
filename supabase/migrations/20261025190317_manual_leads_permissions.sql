alter table public.crm_profiles add column can_add_lead boolean not null default false, add column can_create_group boolean not null default false, add column creation_admin_id uuid references public.crm_profiles(id);
alter table public.lead_groups add column created_by uuid references public.crm_profiles(id);
alter table public.leads add column manual_created_by uuid references public.crm_profiles(id);
create function public.crm_set_caller_creation_permissions(p_actor uuid,p_caller uuid,p_add boolean,p_group boolean) returns void language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from public.crm_profiles where id=p_actor and role='admin' and active) then raise exception 'Admin access required'; end if;
 update public.crm_profiles set can_add_lead=p_add,can_create_group=p_group,creation_admin_id=p_actor where id=p_caller and role='caller' and (creation_admin_id is null or creation_admin_id=p_actor);
 if not found then raise exception 'Caller unavailable for this administrator'; end if;
end $$;
create function crm_private.manual_group(p_owner uuid,p_actor uuid,p_name text) returns uuid language plpgsql set search_path='' as $$
declare gid uuid; clean text=regexp_replace(btrim(p_name),'[[:space:]]+',' ','g');
begin
 if clean is null or length(clean) not between 1 and 100 then raise exception 'Group name must be 1–100 characters'; end if;
 perform pg_advisory_xact_lock(hashtextextended('manual-group:'||p_owner::text,0));
 select id into gid from public.lead_groups where owner_id=p_owner and lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g'))=lower(clean) order by created_at limit 1;
 if gid is not null then
  if p_actor<>p_owner and not exists(select 1 from public.lead_groups where id=gid and created_by=p_actor) and not exists(select 1 from public.leads where group_id=gid and assigned_to=p_actor) then raise exception 'This group name is unavailable. Choose another name.'; end if;
  return gid;
 end if;
 insert into public.lead_groups(owner_id,name,created_by) values(p_owner,clean,p_actor) on conflict do nothing returning id into gid;
 if gid is null then raise exception 'Group name already exists. Refresh and try again.'; end if;
 return gid;
end $$;
create function public.crm_create_manual_group(p_actor uuid,p_name text) returns uuid language plpgsql set search_path='' as $$
declare p public.crm_profiles; own uuid;
begin
 select * into p from public.crm_profiles where id=p_actor for share;
 if not found or not p.active or (p.role<>'admin' and not p.can_create_group) then raise exception 'Create Group permission is disabled. Contact your administrator.'; end if;
 own=case when p.role='admin' then p.id else p.creation_admin_id end;
 if not exists(select 1 from public.crm_profiles where id=own and role='admin' and active) then raise exception 'Administrator unavailable'; end if;
 return crm_private.manual_group(own,p_actor,p_name);
end $$;
create function public.crm_create_manual_lead(p_actor uuid,p_name text,p_phone text,p_group uuid default null) returns jsonb language plpgsql set search_path='' as $$
declare p public.crm_profiles; own uuid; gid uuid; lid uuid; raw text; digits text; nm text=btrim(p_name);
begin
 select * into p from public.crm_profiles where id=p_actor for share;
 if not found or not p.active or (p.role<>'admin' and not p.can_add_lead) then raise exception 'Add Lead permission is disabled. Contact your administrator.'; end if;
 own=case when p.role='admin' then p.id else p.creation_admin_id end;
 if not exists(select 1 from public.crm_profiles where id=own and role='admin' and active) then raise exception 'Administrator unavailable'; end if;
 if nm is null or length(nm) not between 1 and 100 then raise exception 'Name is required (maximum 100 characters)'; end if;
 raw=regexp_replace(btrim(p_phone),'^p:[[:space:]]*','','i');
 if raw is null or length(raw)>80 or raw !~ '^[+]?[0-9[:space:]().-]+$' then raise exception 'Enter a valid phone number'; end if;
 digits=regexp_replace(raw,'[^0-9]','','g');
 if left(digits,2)='00' then digits=substring(digits from 3); end if;
 if length(digits)=11 and left(digits,1)='0' then digits=substring(digits from 2); end if;
 if length(digits)=10 and left(raw,1)<>'+' then digits='91'||digits; end if;
 if digits !~ '^[1-9][0-9]{7,14}$' or (left(digits,2)='91' and digits !~ '^91[6-9][0-9]{9}$') then raise exception 'Enter a valid phone number; Indian mobiles need 10 digits starting with 6–9'; end if;
 perform pg_advisory_xact_lock(hashtextextended(own::text,0));
 if exists(select 1 from public.leads l,unnest(l.phone_numbers) ph where l.owner_id=own and
 case when length(regexp_replace(ph,'[^0-9]','','g'))=10 then '91'||regexp_replace(ph,'[^0-9]','','g') when length(regexp_replace(ph,'[^0-9]','','g'))=11 and left(regexp_replace(ph,'[^0-9]','','g'),1)='0' then '91'||right(regexp_replace(ph,'[^0-9]','','g'),10) else regexp_replace(ph,'[^0-9]','','g') end=digits) then raise exception 'This phone number already exists in CRM. A duplicate lead was not created.'; end if;
 if p_group is null then
  gid=crm_private.manual_group(own,p_actor,case when p.role='admin' then 'Manual leads' else 'Manual leads · '||p.username end);
 else
  select id into gid from public.lead_groups g where g.id=p_group and g.owner_id=own and (p.role='admin' or g.created_by=p_actor or exists(select 1 from public.leads l where l.group_id=g.id and l.assigned_to=p_actor));
  if gid is null then raise exception 'Group unavailable. Choose one of your groups.'; end if;
 end if;
 insert into public.leads(owner_id,group_id,customer_name,phone_numbers,source,original_lead_date,assigned_to,assigned_at,manual_created_by)
 values(own,gid,nm,array['+'||digits],'Manual',now(),case when p.role='caller' then p_actor end,case when p.role='caller' then now() end,p_actor) returning id into lid;
 return jsonb_build_object('id',lid,'group_id',gid);
end $$;
revoke all on function public.crm_set_caller_creation_permissions(uuid,uuid,boolean,boolean),public.crm_create_manual_group(uuid,text),public.crm_create_manual_lead(uuid,text,text,uuid),crm_private.manual_group(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_set_caller_creation_permissions(uuid,uuid,boolean,boolean),public.crm_create_manual_group(uuid,text),public.crm_create_manual_lead(uuid,text,text,uuid),crm_private.manual_group(uuid,uuid,text) to service_role;
create or replace function public.crm_visible_lead_groups() returns table(id uuid,name text) language sql stable security definer set search_path='' as $$
 select g.id,g.name from public.lead_groups g where crm_private.is_active() and (
 (crm_private.is_admin() and g.owner_id=auth.uid()) or
 (not crm_private.is_admin() and (g.created_by=auth.uid() or exists(select 1 from public.leads l where l.group_id=g.id and l.assigned_to=auth.uid())))
 ) order by g.name;
$$;
grant usage on schema crm_private to service_role;
