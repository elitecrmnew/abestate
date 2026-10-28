-- Atomic budget-only updates. Existing fields remain untouched and stale rows are skipped.
create or replace function public.crm_fill_missing_budgets(p_updates jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item jsonb; changed int:=0; amount int; total int;
begin
 if not crm_private.is_admin() then raise exception 'Admin access required';end if;
 if jsonb_typeof(p_updates) is distinct from 'array' then raise exception 'Expected budget updates';end if;
 total=jsonb_array_length(p_updates);
 if total<1 or total>5000 then raise exception 'Select 1–5000 missing budgets at a time';end if;
 for item in select value from jsonb_array_elements(p_updates) order by value->>'id' loop
  if nullif(trim(item->>'budget'),'') is null or length(item->>'budget')>100 then raise exception 'Invalid budget';end if;
  update public.leads set budget=item->>'budget',
   imported_fields=coalesce(imported_fields,'{}'::jsonb)||jsonb_build_object('abestate_budget_origin','Randomly assigned by administrator; not customer-confirmed','abestate_generated_budget',item->>'budget','abestate_budget_range_lakh',left(item->>'range',100))
  where id=(item->>'id')::uuid and owner_id=auth.uid() and updated_at=(item->>'updated_at')::timestamptz
   and (budget is null or trim(budget)='' or lower(trim(budget)) in ('-','–','—','n/a','na','null','none','not specified'));
  get diagnostics amount=row_count;changed=changed+amount;
 end loop;
 return jsonb_build_object('updated',changed,'skipped',total-changed);
end $$;
revoke all on function public.crm_fill_missing_budgets(jsonb) from public,anon;
grant execute on function public.crm_fill_missing_budgets(jsonb) to authenticated;
