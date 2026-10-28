export const missingBudget=(value:string|undefined|null)=>!value?.trim()||/^(?:[-–—]|n\/?a|null|none|not specified)$/i.test(value.trim())
export function fillMissingBudgets<T extends {budget:string;imported_fields?:Record<string,unknown>}>(leads:T[],minimum:string,maximum:string,random:()=>number=Math.random):T[]{
 const min=Number(minimum),max=Number(maximum)
 if(!minimum.trim()||!maximum.trim()||!Number.isFinite(min)||!Number.isFinite(max)||min<=0||max<min||max>100000)throw Error('Enter a valid minimum and maximum in lakh. Minimum must be above 0 and maximum must be at least the minimum (up to 1,00,000 lakh).')
 const low=Math.ceil(min/10),high=Math.floor(max/10)
 if(high<low)throw Error('Choose a range containing a multiple of ₹10 lakh, for example 60–90.')
 return leads.map(lead=>{
  if(!missingBudget(lead.budget))return lead
  const value=(low+Math.floor(Math.min(Math.max(random(),0),1-Number.EPSILON)*(high-low+1)))*10
  const budget=`₹${value.toLocaleString('en-IN',{maximumFractionDigits:2})} lakh`
  return {...lead,budget,imported_fields:{...lead.imported_fields,abestate_budget_origin:'Randomly assigned by administrator; not customer-confirmed',abestate_generated_budget:budget,abestate_budget_range_lakh:`${min}–${max}`}}
 })
}
