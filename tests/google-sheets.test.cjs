const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
function setup(rows,responses=[{ok:true,outcome:'created'}],mapping={name:'Name',phone:'Phone'},headings=['Name','Phone']){
 const cells=[headings,...rows],properties={ABESTATE_API_KEY:'a'.repeat(64),ABESTATE_BOOK:'book'},requests=[];
 const sheet={getSheetId:()=>1,getLastRow:()=>cells.length,getLastColumn:()=>Math.max(...cells.map(r=>r.length)),getRange(r,c,n=1,m=1){return {getDisplayValues:()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>String(cells[r-1+i]?.[c-1+j]??''))),setValue(v){cells[r-1]??=[];cells[r-1][c-1]=v}}}};
 const context={Date,JSON,Set,Object,String,Number,Math,Error,PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties[k],setProperty:(k,v)=>properties[k]=v})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},SpreadsheetApp:{openById:()=>({getSheetByName:()=>sheet,getId:()=>'book'}),flush(){}},Utilities:{sleep(){},getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,s)=>crypto.createHash('sha256').update(s).digest(),base64Encode:b=>Buffer.from(b).toString('base64')},UrlFetchApp:{fetch:(_,o)=>{requests.push(JSON.parse(o.payload));const result=responses[Math.min(requests.length-1,responses.length-1)];return {getResponseCode:()=>result.code||200,getContentText:()=>JSON.stringify(result)}}}};
 const source=fs.readFileSync(__dirname+'/../src/googleSheetsScript.txt','utf8').replace('__AB_CONFIG__',JSON.stringify({url:'https://fixture.invalid',tab:'Leads',columns:mapping}));
 vm.createContext(context);vm.runInContext(source,context);return {cells,requests,context,sheet,properties,run:()=>context.abSyncTab({getId:()=>'book'},sheet,context.PropertiesService.getScriptProperties(),'a'.repeat(64),{remaining:50,deadline:Date.now()+240000})};
}
test('imports new rows once, stable ID survives edit, new rows get picked up',()=>{
 const x=setup([['A','+919000000001']]);x.run();x.run();assert.equal(x.requests.length,1);
 x.cells[1][0]='A edited';x.run();assert.equal(x.requests[0].external_id,x.requests[1].external_id);
 x.cells.push(['B','+919000000002']);x.run();assert.equal(x.requests.length,3);
});
test('failed requests are retried and successful rows skipped',()=>{
 const x=setup([['A','+919000000001']],[{code:503,error:'Paused'},{ok:true,outcome:'created'}]);x.run();assert.match(x.cells[1][4],/Retry/);x.run();x.run();assert.equal(x.requests.length,2);assert.equal(x.requests[0].external_id,x.requests[1].external_id);
});
test('missing data is highlighted while other leads proceed; copied IDs blocked',()=>{
 const x=setup([['A',''],['B','+919000000002']]);x.run();assert.equal(x.requests.length,1);assert.match(x.cells[1][4],/Needs name/);
 x.cells[1][2]=x.cells[2][2];assert.throws(x.run,/Duplicate AB Row ID/);
});

function central(){
 const a=setup([['A','+919000000001']]),b=setup([['B','+919000000002']]);
 const control=[['Spreadsheet URL','Tab name','Enabled'],['https://docs.google.com/spreadsheets/d/bookA/edit','Leads',''],['https://docs.google.com/spreadsheets/d/bookB/edit','Leads','']];
 const cs={getLastRow:()=>control.length,getRange(r,c,n=1,m=1){return {getDisplayValues:()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>String(control[r-1+i]?.[c-1+j]??''))),setValues(values){values.forEach((row,i)=>row.forEach((v,j)=>{control[r-1+i]??=[];control[r-1+i][c-1+j]=v}))}}}};
 a.properties.ABESTATE_CONTROL='control';
 const books={control:{getId:()=>'control',getSheetByName:()=>cs},bookA:{getId:()=>'bookA',getSheetByName:t=>t==='Leads'?a.sheet:null},bookB:{getId:()=>'bookB',getSheetByName:t=>t==='Leads'?b.sheet:null}};
 a.context.SpreadsheetApp.openById=id=>{if(!books[id])throw Error('No access');return books[id]};
 return {...a,second:b,control,run:()=>a.context.syncAbEstate()};
}
test('one central sync processes multiple files and independent IDs, without repeat sends',()=>{
 const x=central();x.run();assert.equal(x.requests.length,2);assert.match(x.requests[0].external_id,/^bookA:/);assert.match(x.requests[1].external_id,/^bookB:/);x.run();assert.equal(x.requests.length,2);
});
test('disabled and unavailable sources do not block other files; links can change without reinstall',()=>{
 const x=central();x.control[1][0]='https://docs.google.com/spreadsheets/d/missing/edit';x.run();assert.equal(x.requests.length,1);assert.match(x.control[1][4],/Error/);
 x.control[1][0]='https://docs.google.com/spreadsheets/d/bookA/edit';x.control[1][2]='FALSE';x.run();assert.equal(x.requests.length,1);
 x.control[1][2]='TRUE';x.run();assert.equal(x.requests.length,2);
});
test('missing tab is reported and global request budget rotates fairly',()=>{
 const x=central();x.control[1][1]='Missing';x.run();assert.match(x.control[1][4],/Tab not found/);
 const y=central();y.cells.splice(1,1,...Array.from({length:60},(_,i)=>['A'+i,'+91900000'+String(i).padStart(4,'0')]));
 y.second.cells.splice(1,1,...Array.from({length:60},(_,i)=>['B'+i,'+91800000'+String(i).padStart(4,'0')]));
 y.run();assert.equal(y.requests.length,50);assert.equal(y.requests.filter(r=>r.external_id.startsWith('bookA:')).length,25);
 y.run();assert.equal(y.requests.length,100);
});

test('Meta headings, alternate phones in message and budget punctuation map correctly',()=>{
 const x=setup([['Ajit','9000000001','9000000002','9000000003','60 lakh']],undefined,{name:'full_name',phone:'phone_number',message:'work_phone_number, whatsapp_number',budget:'what_is_your_budget_?'},['full_name','phone_number','work_phone_number','whatsapp_number','what_is_your_budget_?']);
 x.run();assert.equal(x.requests[0].name,'Ajit');assert.equal(x.requests[0].phone,'9000000001');assert.equal(x.requests[0].message,'work_phone_number: 9000000002\nwhatsapp_number: 9000000003');assert.equal(x.requests[0].budget,'60 lakh');x.run();assert.equal(x.requests.length,1);
});
test('comma fallback tolerates absent optional headers and skips empty values',()=>{
 const x=setup([['Ajit','','9000000003']],undefined,{name:'missing_name, full_name',phone:'phone_number, whatsapp_number',message:'work_phone_number, whatsapp_number, whatsapp_number',email:'email'},['full_name','phone_number','whatsapp_number']);x.run();assert.equal(x.requests[0].phone,'9000000003');assert.equal(x.requests[0].email,'');assert.equal(x.requests[0].message,'whatsapp_number: 9000000003');
});
test('missing required mappings fail before writes; duplicate headers remain rejected',()=>{
 const x=setup([['A','1']],undefined,{name:'full_name',phone:'Phone'});assert.throws(x.run,/Missing required column for name/);assert.equal(x.cells[0].length,2);assert.equal(x.requests.length,0);
 const y=setup([['A','B','1']],undefined,{name:'Name',phone:'Phone'},['Name','Name','Phone']);assert.throws(y.run,/Repeated mapped header/);
});

test('row selectors: blank, start, bounded range, individual rows and header exclusion',()=>{
 const {context:c}=setup([]);const select=o=>JSON.parse(JSON.stringify(c.abSelection(o,8,8)));
 assert.deepEqual(select({}).rows,[2,3,4,5,6,7,8]);assert.deepEqual(select({rows:'5'}).rows,[5,6,7,8]);assert.deepEqual(select({rows:'1-5'}).rows,[2,3,4,5]);assert.deepEqual(select({rows:'1,2,5'}).rows,[2,5]);assert.equal(select({columns:'E:F'}).from,5);assert.equal(select({columns:'E-F'}).to,6);assert.throws(()=>select({rows:'5-2'}),/end/);assert.throws(()=>select({columns:'Z:AA'}),/outside/);
});
test('header on row 3, E:F selected, source writeback and stable retries',()=>{
 const x=setup([[''],['ignore','','','','full_name','phone_number'],['ignored','','','','Ajit','9000000001'],['ignored','','','','Other','9000000002']],undefined,{name:'full_name',phone:'phone_number'},['title']);
 const run=()=>x.context.abSyncTab({getId:()=>'book'},x.sheet,x.context.PropertiesService.getScriptProperties(),'key',{remaining:50,deadline:Date.now()+240000},{header:'3',rows:'4-4',columns:'E:F'});
 run();assert.equal(x.requests.length,1);assert.equal(x.requests[0].name,'Ajit');assert.equal(x.cells[3][8],'Imported');run();assert.equal(x.requests.length,1);assert.equal(x.cells[4][8],undefined);
});

test('source mapping and CRM group overrides are isolated; blank uses defaults',()=>{
 const x=central();
 x.cells[0]=['full_name','mobile','alternate','whatsapp'];
 x.cells[1]=['A','9000000001','9000000003','9000000004'];
 x.control[1][8]='full_name';x.control[1][9]='mobile';
 x.control[1][13]='alternate, whatsapp';x.control[1][14]='Omega Town';
 x.run();
 assert.equal(x.requests.length,2);
 assert.equal(x.requests[0].name,'A');assert.equal(x.requests[0].phone,'9000000001');
 assert.equal(x.requests[0].message,'alternate: 9000000003\nwhatsapp: 9000000004');
 assert.equal(x.requests[0].crm_group,'Omega Town');
 assert.equal(x.requests[1].name,'B');assert.equal(x.requests[1].crm_group,undefined);
 assert.equal(x.control[0][14],'CRM Group');assert.equal(x.control[1][8],'full_name');
 x.run();assert.equal(x.requests.length,2);
 x.control[1][14]='Imperia';x.run();assert.equal(x.requests.length,3);
 assert.equal(x.requests[2].crm_group,'Imperia');
 assert.equal(x.requests[0].external_id,x.requests[2].external_id);
});
test('bad per-source mapping does not block another source',()=>{
 const x=central();x.control[1][8]='absent';
 x.run();assert.match(x.control[1][4],/Missing required column/);
 assert.equal(x.requests.length,1);assert.equal(x.requests[0].name,'B');
});
