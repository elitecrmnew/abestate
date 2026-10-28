const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),crypto=require('node:crypto');
const {webcrypto}=crypto;
async function call(body,{worker,authenticated=true,active=true,stale=false,pushError=0,followup=false,done=false,rescheduled=false,unassigned=false}={}){
 const writes=[],sent=[];let handler;
 const settings={public_key:'public-fixture',private_key:'private-fixture',worker_hash:crypto.createHash('sha256').update('worker-fixture').digest('hex')};
 const tables={crm_profiles:{active},crm_assignment_notifications:{id:'notification',user_id:'caller',lead_id:'lead',assigned_at:'2026-10-16T04:00:00Z',kind:followup?'follow_up':'assignment',follow_up_at:'2026-10-23T04:00:00Z'},crm_push_subscriptions:{id:'subscription',user_id:'caller',endpoint:'https://fcm.googleapis.com/fcm/send/fixture',p256dh:'a',auth_key:'b'},leads:{assigned_to:unassigned?null:stale?'other':'caller',owner_id:'caller',assigned_at:'2026-10-16T04:00:00Z',follow_up_at:rescheduled?'2026-10-24T04:00:00Z':'2026-10-23T04:00:00Z',follow_up_done:done}};
 const db={auth:{getUser:async()=>({data:{user:authenticated?{id:'caller'}:null}})},rpc:async name=>({data:name==='crm_push_settings'?settings:[{id:'job',notification_id:'notification',subscription_id:'subscription',attempts:1}]}),from(table){let op='select';const q={select(){return q},eq(){return q},update(data){op='update';writes.push({table,op,data});return q},delete(){op='delete';writes.push({table,op});return q},upsert(data){writes.push({table,op:'upsert',data});return q},maybeSingle:async()=>({data:tables[table]}),then(resolve){return Promise.resolve({data:tables[table],count:0}).then(resolve)}};return q}};
 const source=fs.readFileSync(__dirname+'/../supabase/functions/caller-push/index.ts','utf8').replace(/^import .*;\n/gm,'');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{createClient:()=>db,webpush:{sendNotification:async(...args)=>{sent.push(args);if(pushError)throw {statusCode:pushError}}},Deno:{env:{get:()=>''},serve:h=>handler=h},Request,Response,TextEncoder,TextDecoder,crypto:webcrypto,URL,Uint8Array,Date,Promise});
 const r=await handler(new Request('https://example.test',{method:'POST',headers:worker?{'x-worker-token':worker}:{Authorization:'Bearer fixture'},body:JSON.stringify(body)}));
 return {status:r.status,body:await r.json(),writes,sent};
}
test('unauthenticated and wrong worker token cannot dispatch',async()=>{
 assert.equal((await call({action:'key'},{authenticated:false})).status,401);
 const r=await call({},{worker:'wrong'});assert.equal(r.status,401);assert.equal(r.sent.length,0);
});
test('browser receives only public VAPID key',async()=>{
 const r=await call({action:'key'});assert.deepEqual(r.body,{publicKey:'public-fixture'});
});
test('subscription rejects arbitrary destinations and inactive callers',async()=>{
 assert.equal((await call({action:'subscribe',subscription:{endpoint:'https://fcm.googleapis.com.evil.test/path',keys:{p256dh:'a'.repeat(87),auth:'b'.repeat(22)}}})).status,400);
 assert.equal((await call({action:'key'},{active:false})).status,403);
});
test('worker sends generic alert with lead deep link and records success',async()=>{
 const r=await call({},{worker:'worker-fixture'});assert.equal(r.sent.length,1);
 const payload=JSON.parse(r.sent[0][1]);assert.equal(payload.lead_id,'lead');assert.equal(payload.body,'Open AB Estate to view your new lead.');
 assert.equal(r.writes.at(-1).data.status,'Sent');
});
test('stale assignment never sends push',async()=>{
 const r=await call({},{worker:'worker-fixture',stale:true});assert.equal(r.sent.length,0);assert.equal(r.writes.at(-1).data.status,'Skipped');
});
test('expired subscriptions removed and transient failures retry',async()=>{
 const gone=await call({},{worker:'worker-fixture',pushError:410});assert.equal(gone.writes.at(-1).op,'delete');
 const retry=await call({},{worker:'worker-fixture',pushError:503});assert.equal(retry.writes.at(-1).data.status,'Pending');
});

test('follow-up push is sent to current caller or unassigned lead owner',async()=>{
 for(const unassigned of [false,true]){const r=await call({},{worker:'worker-fixture',followup:true,unassigned});assert.equal(r.sent.length,1);assert.equal(JSON.parse(r.sent[0][1]).kind,'follow_up');}
});
test('completed, rescheduled and reassigned follow-ups do not send stale reminders',async()=>{
 for(const change of [{done:true},{rescheduled:true},{stale:true}]){const r=await call({},{worker:'worker-fixture',followup:true,...change});assert.equal(r.sent.length,0);assert.equal(r.writes.at(-1).data.status,'Skipped');}
});
