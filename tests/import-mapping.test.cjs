const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildSync}=require('esbuild');
const vm=require('node:vm'),path=require('node:path');
const result=buildSync({entryPoints:[path.join(__dirname,'../src/extract.ts')],bundle:true,platform:'node',format:'cjs',write:false});
const moduleObj={exports:{}};vm.runInNewContext(result.outputFiles[0].text,{module:moduleObj,exports:moduleObj.exports,require,console,Buffer,TextDecoder,TextEncoder,setTimeout,clearTimeout,Uint8Array,ArrayBuffer});
const {extractFromText,extractFromFile,suggestImportMapping,applyImportMapping}=moduleObj.exports;
test('provided table format maps phone and project, cleans dash email and keeps international visible',()=>{
 const rows=extractFromText('| Name | Phone No. | Email | Project |\n| --- | --- | --- | --- |\n| Manish Sethi | 91-9815522321 | - | White City |\n| Amarjit Singh | 60-149980814 | - | Jubilee Parklane |\n| Ashish | 91-8826627986 | ashish152107+99@gmail.com | White City 2 |');
 const m=suggestImportMapping(rows),out=applyImportMapping(rows,m);
 assert.equal(out.length,3);assert.equal(m['Phone No.'],'phone');assert.equal(m.Project,'campaign_name');
 assert.equal(out[0].phone_numbers[0],'+91 98155 22321');assert.equal(out[0].email,'');assert.equal(out[0].campaign_name,'White City');
 assert.equal(out[1].phone_numbers[0],'60-149980814');assert.equal(out[2].email,'ashish152107+99@gmail.com');
});
test('custom columns can be remapped, skipped and combined without changing originals',()=>{
 const rows=extractFromText('Person\tCall\tWhatsApp\tDevelopment\tUnused\nAman\t919876543210\t+91 98765 43210\tParklane\tx');
 const out=applyImportMapping(rows,{Person:'full_name',Call:'phone',WhatsApp:'phone',Development:'campaign_name',Unused:''});
 assert.equal(out[0].customer_name,'Aman');assert.equal(out[0].phone_numbers.length,1);assert.equal(out[0].campaign_name,'Parklane');assert.equal(out[0].imported_fields.Unused,'x');
 assert.throws(()=>applyImportMapping(rows,{Person:'full_name'}),/Phone/);
 assert.throws(()=>applyImportMapping(rows,{Person:'full_name',Call:'phone',Development:'full_name'}),/only one/);
});
test('compact Meta export remains headerless and duplicate column names preserve every cell',()=>{
 const rows=extractFromText('ig\t60_lac\t\tVardhan\tp:+918879006144\t8879006144\t+918879006144');
 assert.equal(applyImportMapping(rows,suggestImportMapping(rows))[0].customer_name,'Vardhan');
 const dup=extractFromText('Name,Phone,Phone\nA,9876543210,9876543211');
 assert.equal(dup[0].imported_fields['Phone (2)'],'9876543211');
 assert.equal(applyImportMapping(dup,{Name:'full_name',Phone:'phone','Phone (2)':'phone'})[0].phone_numbers.length,2);
});
test('CSV quoted project comma and XLSX use the same mapping pipeline',async()=>{
 const rows=extractFromText('Name,Phone No.,Email,Project\nSatinder,91-6283379944,-,"IT city Mohali, 66 B, Mohali"');
 assert.equal(rows[0].campaign_name,'IT city Mohali, 66 B, Mohali');
 const XLSX=require('xlsx'),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Name','Phone No.','Project'],['Manish','91-9815522321','White City']]),'Sheet1');
 const bytes=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
 const x=await extractFromFile({name:'input.xlsx',arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
 assert.equal(applyImportMapping(x,suggestImportMapping(x))[0].campaign_name,'White City');
});

test('multiple source columns append labeled values into Lead Remarks while preserving phone mapping',()=>{
 const rows=extractFromText('Name,Phone,Work Number,Alternate Phone,Email\nRahul,9876543210,9876501234,9876512345,rahul@example.com');
 const mapping={Name:'full_name',Phone:'phone','Work Number':'remark','Alternate Phone':'remark',Email:'email'};
 const out=applyImportMapping(rows,mapping)[0];
 assert.equal(out.customer_name,'Rahul');
 assert.equal(out.phone_numbers[0],'+91 98765 43210');
 assert.equal(out.remark,'Work Number: 9876501234\nAlternate Phone: 9876512345');
 assert.equal(out.email,'rahul@example.com');
});
test('blank and dash remark values are skipped and existing remarks can be mapped',()=>{
 const rows=extractFromText('Name,Phone,Notes,Other\nA,9876543210,Existing note,-');
 const out=applyImportMapping(rows,{Name:'full_name',Phone:'phone',Notes:'remark',Other:'remark'})[0];
 assert.equal(out.remark,'Notes: Existing note');
});
