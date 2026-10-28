import type {Lead} from './extract'
import {normalizeIndianPhone} from '../supabase/functions/_shared/outbound'

export type ImportIssue = {field:'customer_name'|'phone_numbers'|'original_lead_date';message:string}
export function importIssues(lead:Lead):ImportIssue[] {
 const issues:ImportIssue[]=[]
 if(!lead.customer_name.trim())issues.push({field:'customer_name',message:'Name is missing. Enter the customer’s name.'})
 if(!lead.phone_numbers.length){
  const original=Array.from(new Set(Object.entries(lead.imported_fields||{})
   .filter(([key])=>/^(phone|phone_number|mobile|mobile_number|whatsapp|whatsapp_number|work_phone|work_phone_number|alternate_phone|contact_number|other_phone)$/.test(key.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_')))
   .map(([,value])=>String(value??'').trim()).filter(Boolean)))
  issues.push({field:'phone_numbers',message:original.length
   ? `No supported Indian mobile number was extracted. Original: ${original.join(' · ')}. Use a 10-digit Indian mobile starting with 6–9, optionally with +91. International numbers are not supported by this extractor.`
   : 'Phone number is missing. Enter a 10-digit Indian mobile number, optionally with +91.'})
 }else{
  const invalid=lead.phone_numbers.filter(number=>!normalizeIndianPhone(number))
  if(invalid.length)issues.push({field:'phone_numbers',message:`Invalid or unsupported phone: ${invalid.join(', ')}. Use a 10-digit Indian mobile starting with 6–9, optionally with +91. Separate multiple numbers with commas.`})
 }
 if(lead.original_lead_date&&Number.isNaN(Date.parse(lead.original_lead_date)))issues.push({field:'original_lead_date',message:`Invalid lead date: ${lead.original_lead_date}. Use YYYY-MM-DD or clear the date.`})
 return issues
}
