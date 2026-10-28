const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),ts=require('typescript');
function setup(role='admin',owned=true){
 let handler,saved;const connection={id:'conn',source:'Google Sheets'};
 const db={auth:{getUser:async()=>({data:{user:{id:'owner'}},error:null})},from(table){const filters={};let update;const q={select(){return q},eq(k,v){filters[k]=v;return q},update(v){update=v;return q},async single(){if(table==='crm_profiles')return {data:{role,active:true}};assert.equal(filters.owner_id,'owner');assert.equal(filters.id,'conn');saved=update;return {data:update}},async maybeSingle(){assert.equal(filters.owner_id,'owner');return {data:owned?connection:null}}};return q}};
 const source=fs.readFileSync('supabase/functions/manage-integrations/index.ts','utf8').replace(/^import .*\n/,'');
 const js=ts.transpile(source,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
 vm.runInNewContext(js,{createClient:()=>db,Deno:{env:{get:()=>''},serve:h=>handler=h},Response,Request,TextEncoder,crypto:require('node:crypto').webcrypto,URL});
 return {send:async(mapping)=>handler(new Request('https://fixture.invalid',{method:'POST',headers:{Authorization:'Bearer fixture'},body:JSON.stringify({action:'save-sheet-mapping',id:'conn',field_mapping:mapping})})),saved:()=>saved};
}
test('save mapping persists normalized comma headers including question mark',async()=>{const x=setup();const r=await x.send({name:'full_name',phone:'phone_number',budget:'what_is_your_budget_?',message:'work_phone_number, whatsapp_number, work_phone_number'});assert.equal(r.status,200);assert.equal(x.saved().field_mapping.message,'work_phone_number, whatsapp_number');});
test('caller and other owners cannot save mapping',async()=>{assert.equal((await setup('caller').send({name:'a',phone:'b'})).status,403);assert.equal((await setup('admin',false).send({name:'a',phone:'b'})).status,404)});
test('empty required mapping and invalid header rejected without write',async()=>{const x=setup();assert.equal((await x.send({name:' , ',phone:'phone'})).status,400);assert.equal((await x.send({name:'full_name',phone:'phone',message:'bad\nheader'})).status,400);assert.equal(x.saved(),undefined)});
