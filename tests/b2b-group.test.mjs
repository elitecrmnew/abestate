import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as outbound from '../supabase/functions/_shared/outbound.ts';
const owner='11111111-1111-4111-8111-111111111111';
const g1='22222222-2222-4222-8222-222222222222',g2='33333333-3333-4333-8333-333333333333';
const a='44444444-4444-4444-8444-444444444444',b='55555555-5555-4555-8555-555555555555';
const mapping=[['name','customer_name','name'],['mobile','phone','mobile'],['project','group_name','project']].map(([target,source,kind])=>({target,source,kind,value:'',fallback:''}));
const conn={mapping,version:4,phone_format:'national',default_project:'Wrong default'};
const rows=[{id:a,owner_id:owner,group_id:g1,customer_name:'A',phone_numbers:['9876543210'],email:''},{id:b,owner_id:owner,group_id:g2,customer_name:'B',phone_numbers:['9876543211'],email:''}];
async function preview(body,role='admin'){
 let handler;
 const tables={crm_profiles:[{id:owner,role,active:true}],leads:rows,lead_groups:[{id:g1,name:'Imperia',owner_id:owner},{id:g2,name:'NH44',owner_id:owner}],b2bbricks_connections:[{id:a,owner_id:owner,archived:false,...conn}],b2bbricks_deliveries:[]};
 const db={auth:{getUser:async()=>({data:{user:{id:owner}}})},from(table){let data=tables[table];const q={select(){return q},eq(k,v){data=data.filter(x=>x[k]===v);return q},in(k,vs){data=data.filter(x=>vs.includes(x[k]));return q},order(){return q},range(){return q},or(){return q},single:async()=>({data:data[0]}),maybeSingle:async()=>({data:data[0]}),then(resolve){return Promise.resolve({data}).then(resolve)}};return q}};
 const source=fs.readFileSync(new URL('../supabase/functions/b2bbricks/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{...outbound,createClient:()=>db,Deno:{env:{get:()=>''},serve:h=>handler=h},Request,Response,TextDecoder,Uint8Array,URL,URLSearchParams,setTimeout,clearTimeout,AbortController});
 const r=await handler(new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer fixture'},body:JSON.stringify({action:'preview',connection_id:a,...body})}));
 return {status:r.status,body:await r.json()};
}
test('mixed saved selection uses each actual group despite supplied group',async()=>{
 const r=await preview({mode:'saved',ids:[a,b],group_id:g1});
 assert.equal(r.status,200);assert.deepEqual(r.body.entries.map(e=>e.payload.project),['Imperia','NH44']);
});
test('group send resolves the owned group name',async()=>{
 const r=await preview({mode:'group',group_id:g2});assert.equal(r.body.ready,1);assert.equal(r.body.entries[0].payload.project,'NH44');
});
test('draft ignores a spoofed group name and uses the selected owned group',async()=>{
 const r=await preview({mode:'draft',group_id:g1,leads:[{...rows[0],group_name:'Forged'}]});
 assert.equal(r.body.entries[0].payload.project,'Imperia');
});
test('missing group is actionable invalid record, not wrong default project',async()=>{
 const r=await preview({mode:'draft',leads:[rows[0]]});assert.equal(r.body.invalid,1);assert.match(r.body.entries[0].error,/Choose a lead group/);
});
test('normal users cannot preview outbound exports',async()=>{
 assert.equal((await preview({mode:'group',group_id:g1},'caller')).status,403);
});
