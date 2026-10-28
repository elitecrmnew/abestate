import {useEffect,useState} from 'react'
import {Download,Check,X} from 'lucide-react'
import {installed,installApp,watchInstall} from './installApp'
export default function InstallAppButton({compact=false}:{compact?:boolean}){
 const [isInstalled,setInstalled]=useState(installed),[help,setHelp]=useState(false),[busy,setBusy]=useState(false)
 useEffect(()=>watchInstall(()=>setInstalled(installed())),[])
 async function install(){setBusy(true);try{if(!await installApp())setHelp(!help)}catch{setHelp(true)}finally{setBusy(false)}}
 return <div className={'app-install '+(compact?'compact':'')}>
 <button type="button" className="secondary" title={isInstalled?'App installed':'Install AB Estate app'} aria-label={isInstalled?'App installed':'Install AB Estate app'} disabled={busy||isInstalled} aria-expanded={help} onClick={()=>void install()}>{isInstalled?<Check size={18}/>:<Download size={18}/>}<span>{isInstalled?'Installed':compact?'Install':'Install AB Estate app'}</span></button>
 {help&&<div className="install-help" role="region" aria-label="App installation instructions"><button type="button" className="icon-button" aria-label="Close installation instructions" onClick={()=>setHelp(false)}><X size={16}/></button><strong>Keep AB Estate on your phone</strong><p><b>Android:</b> Chrome menu ⋮ → Install app / Add to Home screen.</p><p><b>iPhone:</b> Safari → Share → Add to Home Screen → Add.</p><p><b>Computer:</b> Use the install icon in the address bar or your browser’s app menu.</p><small>If already installed, open AB Estate from your home screen.</small></div>}
 </div>
}
