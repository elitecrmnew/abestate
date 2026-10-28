begin;
select set_config('request.jwt.claim.sub',(select id::text from public.crm_profiles where role='admin' and active limit 1),true);
create temporary table group_delete_fixture(gid uuid,lid uuid,caller uuid,assigned timestamptz);
do $$
declare g uuid; l uuid; c uuid;
begin
 select id into c from public.crm_profiles where role='caller' and active limit 1;
 insert into public.lead_groups(owner_id,name) values(auth.uid(),'Rollback delete group '||gen_random_uuid()) returning id into g;
 insert into public.leads(owner_id,group_id,customer_name,phone_numbers,remark,assigned_to,assigned_at,follow_up_at)
 values(auth.uid(),g,'Rollback fixture',array['+919876500129'],'Keep my remark',c,now(),now()+interval '2 days') returning id into l;
 insert into group_delete_fixture select g,l,c,assigned_at from public.leads where id=l;
end $$;
grant select on group_delete_fixture to authenticated;
set local role authenticated;
select public.crm_delete_group_keep_leads(gid) from group_delete_fixture;
do $$ begin
 if exists(select 1 from public.lead_groups where id=(select gid from group_delete_fixture)) then raise exception 'Group remains';end if;
 if not exists(select 1 from public.leads l join group_delete_fixture f on l.id=f.lid where l.group_id is null and l.remark='Keep my remark' and l.assigned_to=f.caller and l.assigned_at=f.assigned and l.follow_up_at is not null) then raise exception 'Lead data lost';end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select caller::text from group_delete_fixture),true);
set local role authenticated;
do $$ declare denied boolean=false; begin
 begin perform public.crm_delete_group_keep_leads((select gid from group_delete_fixture));exception when raise_exception then denied=true;end;
 if not denied then raise exception 'Caller not blocked';end if;
end $$;
reset role;
select 'PASS: lead preserved, group removed, assignments/remark/follow-up preserved, caller rejected' as result;
rollback;
