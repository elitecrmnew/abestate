export type FollowUp={follow_up_at?:string|null;follow_up_done?:boolean}
const day=(time:number)=>new Date(time+330*60000).toISOString().slice(0,10)
export function matchesFollowUp(lead:FollowUp,filter:string,now=Date.now()){
 if(!filter)return true
 const at=Date.parse(lead.follow_up_at||'')
 if(!Number.isFinite(at))return false
 if(filter==='completed')return !!lead.follow_up_done
 if(lead.follow_up_done)return false
 if(filter==='today')return day(at)===day(now)
 if(filter==='overdue')return at<now
 if(filter==='upcoming')return at>=now
 return filter==='pending'
}
