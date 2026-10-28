type Group={id:string;name:string}
type Lead={group_id:string|null;created_at:string;assigned_at:string|null}
export function groupCards(groups:Group[],leads:Lead[],admin:boolean,now=Date.now(),showEmpty=false){
 const day=(t:number)=>new Date(t+330*60000).toISOString().slice(0,10)
 const today=day(now),map=new Map(groups.map(g=>[g.id,{...g,total:0,newToday:0,latest:0}]))
 for(const lead of leads){
  if(!lead.group_id)continue;
  let g=map.get(lead.group_id);if(!g){g={id:lead.group_id,name:'Lead group',total:0,newToday:0,latest:0};map.set(g.id,g)}
  const time=Date.parse(admin?lead.created_at:lead.assigned_at||'')
  g.total++;if(Number.isFinite(time)){g.latest=Math.max(g.latest,time);if(time<=now&&day(time)===today)g.newToday++}
 }
 return [...map.values()].filter(g=>admin||showEmpty||g.total>0).sort((a,b)=>Number(b.newToday>0)-Number(a.newToday>0)||(a.newToday&&b.newToday?b.latest-a.latest:0)||a.name.localeCompare(b.name))
}
