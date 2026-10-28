// No authenticated lead data is cached.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
 if(event.request.mode==='navigate')event.respondWith(fetch(event.request).catch(()=>new Response('<!doctype html><meta name="viewport" content="width=device-width"><title>AB Estate offline</title><main style="font-family:system-ui;padding:32px"><h1>You are offline</h1><p>Connect to the internet to open AB Estate and view your leads.</p><a href="/">Try again</a></main>',{headers:{'Content-Type':'text/html'}})));
});
self.addEventListener('push',event=>{
 let data={};try{data=event.data?.json()||{}}catch{}
 event.waitUntil(self.registration.showNotification(data.kind==='follow_up'?'Follow-up due':'New lead assigned',{body:data.kind==='follow_up'?'Time to follow up. Open AB Estate to view the lead.':'Open AB Estate to view your new lead.',vibrate:[200,100,200],icon:'/icon-192.png',badge:'/icon-192.png',tag:data.id||'new-lead',data:{lead_id:data.lead_id},renotify:false}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const id=event.notification.data?.lead_id;
 const url=new URL('/',self.location.origin);if(/^[0-9a-f-]{36}$/i.test(id||''))url.searchParams.set('lead',id);
 event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const w of windows){if(new URL(w.url).origin===url.origin){await w.navigate(url.href);return w.focus()}}return self.clients.openWindow(url.href)})());
});
