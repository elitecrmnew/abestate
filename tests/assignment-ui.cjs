const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const uid='11111111-1111-4111-8111-111111111111',gid='22222222-2222-4222-8222-222222222222',cid='33333333-3333-4333-8333-333333333333';
 const user={id:uid,email:'admin@example.test',aud:'authenticated',role:'authenticated'};
 const token='mock.'+Buffer.from(JSON.stringify({sub:uid,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.mock';
 await page.addInitScript(({user,token})=>localStorage.setItem('sb-yosldtcsplksidtwfmty-auth-token',JSON.stringify({access_token:token,refresh_token:'mock',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user})),{user,token});
 const mapping=[{source:'customer_name',target:'Full Name',kind:'name',value:'',fallback:''},{source:'phone',target:'Mobile',kind:'mobile',value:'',fallback:''}];
 const connection={id:cid,name:'Mock B2BBricks account',active:true,version:1,has_webhook:true,has_headers:true,mapping,contract_confirmed:true,default_project:'Imperia',default_source:'Excel',default_remark:'',method:'POST',content_type:'application/json',phone_format:'national',envelope:'',success_codes:[200],success_path:'',success_value:'',delay_ms:1500};
 const leads=[{id:'44444444-4444-4444-8444-444444444444',owner_id:uid,group_id:gid,customer_name:'Mock lead',phone_numbers:['+91 98765 43210'],email:'sample@example.test',budget:'',source:'Excel',campaign_name:'Imperia',original_lead_date:null,assigned_to:null,assigned_at:null,status:'Not Connected',remark:'',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),imported_fields:{'Custom Project':'Imperia'}}];
 let batches=[],lastEnqueue=null,schedules=[],scheduled=null,control=null;
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.hostname==='127.0.0.1')return route.continue();
  if(u.hostname!=='yosldtcsplksidtwfmty.supabase.co')return route.abort();
  let data=[];
  if(u.pathname.includes('/auth/'))data=user;
  if(u.pathname.endsWith('/crm_profiles'))data={id:uid,username:'admin',display_name:'Administrator',role:'admin',active:true};
  if(u.pathname.endsWith('/crm_profiles')&&!u.searchParams.has('id'))data=[data,{id:cid,display_name:'Fixture caller',role:'caller',active:true}];
  if(u.pathname.endsWith('/leads'))data=leads;
  if(u.pathname.endsWith('/crm_assignment_summaries'))data=schedules;
  if(u.pathname.endsWith('/crm_schedule_assignments')){scheduled=route.request().postDataJSON();data=cid;schedules=[{id:cid,name:scheduled.p_name,caller_id:scheduled.p_caller,status:'Active',batch_size:scheduled.p_batch,interval_seconds:scheduled.p_hours*3600,next_at:new Date().toISOString(),work_start:'10:00',work_end:'19:00',counts:{Pending:1,Assigned:0,Skipped:0,Cancelled:0}}]}
  if(u.pathname.endsWith('/crm_control_schedule')){control=route.request().postDataJSON();schedules[0].status=control.p_action==='pause'?'Paused':control.p_action==='resume'?'Active':'Cancelled';data=null}
  if(u.pathname.endsWith('/lead_groups'))data=[{id:gid,name:'Imperia'}];
  if(u.pathname.endsWith('/b2bbricks')){
   const b=route.request().postDataJSON();
   if(b.action==='connections')data={connections:[connection]};
   if(b.action==='preview')data={entries:[{index:0,name:'Aman',mobile:'+919876543210',status:'Ready',payload:{'Full Name':'Aman',Mobile:'9876543210'},error:'',reason:'',already_sent:false}],connection_version:1,total:1,already_sent:0,invalid:0,duplicates:0,ready:1};
   if(b.action==='enqueue'){lastEnqueue=b;batches=[{id:b.batch_id,name:b.name,connection_id:cid,total:1,successful:0,failed:0,skipped:0,duplicate:0,pending:1,sending:0,is_test:false}];data={batch_id:b.batch_id};}
   if(b.action==='history')data={deliveries:[],total:0,batches};
  }
  return route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(data)});
 });

 await page.goto('http://127.0.0.1:5173');await page.getByRole('heading',{name:'Welcome, Administrator'}).waitFor();
 await page.getByRole('button',{name:/All leads/}).first().click();
 await page.getByLabel('Select Mock lead',{exact:true}).check();
 await page.getByLabel('Assign to caller').selectOption(cid);
 await page.getByRole('button',{name:'Schedule selected',exact:true}).click();
 await page.getByRole('heading',{name:'Schedule 1 selected leads'}).waitFor();
 await page.getByLabel('Release mode').selectOption('spread');
 await page.getByRole('button',{name:'Create assignment schedule'}).click();
 await page.getByRole('button',{name:'Pause',exact:true}).waitFor();
 assert.equal(scheduled.p_mode,'spread');assert.equal(scheduled.p_hours,24);assert.equal(scheduled.p_work_start,'10:00');assert.equal(scheduled.p_caller,cid);assert.equal(scheduled.p_ids.length,1);
 await page.getByRole('button',{name:'Pause',exact:true}).click();await page.getByRole('button',{name:'Resume',exact:true}).waitFor();assert.equal(control.p_action,'pause');
 await page.getByRole('button',{name:'Resume',exact:true}).click();await page.getByRole('button',{name:'Pause',exact:true}).waitFor();
 page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Cancel remaining',exact:true}).click();await page.getByText('Cancelled',{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'/tmp/abestate-schedule-mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Mobile page overflow');
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: selection -> schedule -> pause/resume/cancel and mobile layout. Only mocked services used.');
})().catch(e=>{console.error(e);process.exit(1)});
