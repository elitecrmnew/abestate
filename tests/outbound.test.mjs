import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeIndianPhone,validateMapping,mapLead,validateDestination,responseAccepted,redactResponse} from '../supabase/functions/_shared/outbound.ts';
test('Indian phones normalize without accepting invalid substrings',()=>{
 for(const n of ['9876543210','+91 98765 43210','919876543210','09876543210','00919876543210','(98765) 43210'])assert.equal(normalizeIndianPhone(n),'+919876543210');
 for(const n of ['',null,'1234567890','919876543210123','9876543210123','9876543210 ext5','9876543210/9876543211','+1 9876543210'])assert.equal(normalizeIndianPhone(n),'');
});
const mapping=[{target:'First Name',source:'raw:First Name',value:'',fallback:'',kind:'name'},{target:'Phone no',source:'raw:Phone no',value:'',fallback:'',kind:'mobile'},{target:'Project',source:'default_project',value:'',fallback:'',kind:'text'},{target:'Remark',source:'static',value:'October import',fallback:'',kind:'text'}];
const contract={mapping,default_project:'Imperia',default_source:'Excel',default_remark:'',phone_format:'national'};
test('exact imported columns, defaults, static values and phone formatting',()=>{
 validateMapping(mapping);const r=mapLead({customer_name:'',phone_numbers:[],email:'',imported_fields:{'First Name':' Aman ','Phone no':'+91 98765 43210'}},contract);
 assert.equal(r.error,'');assert.equal(r.mobile,'+919876543210');assert.deepEqual({...r.payload},{'First Name':'Aman','Phone no':'9876543210',Project:'Imperia',Remark:'October import'});
 assert.equal(mapLead({customer_name:'',phone_numbers:[],email:''},contract).error.includes('mobile'),true);
 assert.throws(()=>validateMapping([...mapping,mapping[0]]));assert.throws(()=>validateMapping([]));
});
test('restrict destination, disable lookalike hosts and unsupported protocols',()=>{
 assert.equal(new URL(validateDestination('https://connector.b2bbricks.com/api/Integration/hook/example')).hostname,'connector.b2bbricks.com');
 for(const u of ['http://connector.b2bbricks.com/api/Integration/hook/x','https://connector.b2bbricks.com.evil.test/api/Integration/x','https://127.0.0.1/api/Integration/x','https://u:p@connector.b2bbricks.com/api/Integration/x','https://connector.b2bbricks.com:444/api/Integration/x'])assert.throws(()=>validateDestination(u));
});
test('HTTP 200 alone does not pass a configured body success condition',()=>{
 const c={success_codes:[200],success_path:'result.success',success_value:'true'};
 assert.equal(responseAccepted(200,'{"result":{"success":true}}',c),true);
 assert.equal(responseAccepted(200,'{"result":{"success":false}}',c),false);
 assert.equal(responseAccepted(200,'not JSON',c),false);assert.equal(responseAccepted(500,'{"result":{"success":true}}',c),false);
});
test('responses redact configured URL, header secrets and credential labels',()=>{
 const result=redactResponse('https://connector.b2bbricks.com/api/Integration/hook/long-secret-identifier token=hidden Authorization: Bearer-example','https://connector.b2bbricks.com/api/Integration/hook/long-secret-identifier',{Authorization:'Bearer-example'});
 assert.ok(!result.includes('long-secret-identifier'));assert.ok(!result.includes('hidden'));assert.ok(!result.includes('Bearer-example'));
});
