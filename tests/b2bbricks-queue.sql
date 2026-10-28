begin;
do $$
declare a uuid;g uuid;c uuid;c2 uuid;b uuid:=gen_random_uuid();b2 uuid;d uuid;r uuid;l uuid:=gen_random_uuid();n int;e jsonb;err boolean:=false;
begin
 select id into a from public.crm_profiles where role='admin' and active limit 1;
 select id into g from public.lead_groups where owner_id=a limit 1;
 insert into public.b2bbricks_connections(owner_id,name,webhook_url,active,contract_confirmed) values(a,'Transaction verification','https://connector.b2bbricks.com/api/Integration/hook/never-send',true,true) returning id into c;
 insert into public.b2bbricks_worker_state(id,token_hash) values(true,'transaction-only') on conflict(id) do nothing;
 e=jsonb_build_array(jsonb_build_object('lead',jsonb_build_object('customer_name','Queue test','phone_numbers',jsonb_build_array('+919000001111'),'email','','imported_fields',jsonb_build_object('Custom field','preserved')),'mobile','+919000001111','payload',jsonb_build_object('Exact field','Queue test')));
 perform public.b2b_enqueue(a,c,1,b,'Batch test',g,'[]',e||e,false,false,false);
 if (select total from public.b2bbricks_batches where id=b)<>2 or (select duplicate from public.b2bbricks_batches where id=b)<>1 then raise exception 'In-batch duplicate protection failed';end if;
 perform public.b2b_enqueue(a,c,1,b,'Batch test',g,'[]',e,false,false,false);
 if (select count(*) from public.b2bbricks_deliveries where batch_id=b)<>2 then raise exception 'Idempotency failed';end if;
 if not exists(select 1 from public.leads where customer_name='Queue test' and imported_fields->>'Custom field'='preserved') then raise exception 'Imported columns not preserved';end if;
 if not public.b2b_worker_lease(l) then raise exception 'Worker lease failed';end if;
 if public.b2b_worker_lease(gen_random_uuid()) then raise exception 'Overlapping worker allowed';end if;
 d=(public.b2b_claim(l)->>'id')::uuid;if d is null then raise exception 'Claim failed';end if;
 perform public.b2b_finish(d,'Sent',200,'test response','',false,1000);
 if (select successful from public.b2bbricks_batches where id=b)<>1 then raise exception 'Success report failed';end if;
 b2=gen_random_uuid();perform public.b2b_enqueue(a,c,1,b2,'Second batch',g,'[]',e,false,false,false);
 if (select duplicate from public.b2bbricks_batches where id=b2)<>1 then raise exception 'Cross-batch duplicate protection failed';end if;
 b2=gen_random_uuid();perform public.b2b_enqueue(a,c,1,b2,'Force resend',g,'[]',e,true,false,false);
 if (select pending from public.b2bbricks_batches where id=b2)<>1 then raise exception 'Force resend failed';end if;
 update public.b2bbricks_deliveries set status='Failed',requires_review=true where batch_id=b2;
 if public.b2b_retry(a,b2,false)<>0 then raise exception 'Uncertain response retried without acknowledgement';end if;
 -- Existing successful records must never be requeued by retry.
 if public.b2b_retry(a,b,false)<>0 then raise exception 'Successful delivery retried';end if;
 -- Another connection is a separate destination for duplicate checking.
 insert into public.b2bbricks_connections(owner_id,name,webhook_url,active,contract_confirmed) values(a,'Second destination','https://connector.b2bbricks.com/api/Integration/hook/never-send',true,true) returning id into c2;
 b2=gen_random_uuid();perform public.b2b_enqueue(a,c2,1,b2,'Other destination',g,'[]',e,false,false,false);
 if (select pending from public.b2bbricks_batches where id=b2)<>1 then raise exception 'Multiple connections blocked incorrectly';end if;
 update public.b2bbricks_deliveries set status='Failed',requires_review=false where batch_id=b2;
 if public.b2b_retry(a,b2,false)<>1 then raise exception 'Failed-only retry failed';end if;
 if (select retry_count from public.b2bbricks_deliveries where batch_id=b2)<>1 then raise exception 'Retry count failed';end if;
 b2=gen_random_uuid();perform public.b2b_enqueue(a,c,1,b2,'Invalid rows',g,'[]','[{"lead":{"customer_name":"Invalid"},"mobile":"","error":"Invalid phone","payload":{}}]',false,false,false);
 if (select skipped from public.b2bbricks_batches where id=b2)<>1 then raise exception 'Invalid phone was queued';end if;
 b2=gen_random_uuid();perform public.b2b_enqueue(a,c,1,b2,'Untracked test',null,'[]',e,false,true,false);
 if exists(select 1 from public.b2bbricks_deliveries where batch_id=b2 and (lead_id is not null or not dedupe_exempt)) then raise exception 'Test was tracked as real lead';end if;
 update public.b2bbricks_connections set active=false where id=c;
 begin perform public.b2b_enqueue(a,c,1,gen_random_uuid(),'Inactive',g,'[]',e,false,false,false);exception when others then err=true;end;
 if not err then raise exception 'Inactive connection accepted';end if;
 if has_table_privilege('authenticated','public.b2bbricks_connections','SELECT') or has_table_privilege('anon','public.b2bbricks_connections','SELECT') or has_function_privilege('authenticated','public.b2b_claim(uuid)','EXECUTE') then raise exception 'Secret or queue access exposed';end if;
end $$;
select 'Queue creation, idempotency, duplicate/force rules, worker lease, reports, retries, invalid numbers, test isolation and access checks passed' as verification;
rollback;
