export type InstallPrompt=Event&{prompt:()=>Promise<void>;userChoice:Promise<{outcome:string}>}
let prompt:InstallPrompt|null=null
const listeners=new Set<()=>void>()
const emit=()=>listeners.forEach(fn=>fn())
export const installed=()=>window.matchMedia('(display-mode: standalone)').matches||(navigator as Navigator&{standalone?:boolean}).standalone===true
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();prompt=e as InstallPrompt;emit()})
window.addEventListener('appinstalled',()=>{prompt=null;emit()})
window.matchMedia('(display-mode: standalone)').addEventListener('change',emit)
export function watchInstall(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn)}}
export async function installApp(){
 if(!prompt)return false
 const pending=prompt;prompt=null;emit()
 await pending.prompt();await pending.userChoice
 return true
}
if('serviceWorker'in navigator)void navigator.serviceWorker.register('/sw.js').catch(()=>{})
