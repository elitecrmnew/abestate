let audio:AudioContext|null=null
export async function unlockReminderSound(){
 audio??=new AudioContext()
 await audio.resume()
 playReminderSound()
}
export function playReminderSound(){
 if(audio?.state!=='running')return
 const start=audio.currentTime
 for(const [offset,hz] of [[0,660],[0.18,880]]){
  const tone=audio.createOscillator(),gain=audio.createGain()
  tone.frequency.value=hz;gain.gain.setValueAtTime(0,start+offset)
  gain.gain.linearRampToValueAtTime(0.15,start+offset+0.02)
  gain.gain.exponentialRampToValueAtTime(0.001,start+offset+0.4)
  tone.connect(gain);gain.connect(audio.destination);tone.start(start+offset);tone.stop(start+offset+0.45)
 }
 navigator.vibrate?.([200,100,200])
}
