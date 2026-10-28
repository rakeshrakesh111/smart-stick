/* Smart Safety Stick - web dashboard
   Arduino -> web (one line each, 9600 baud):
     D:123            distance in cm (HC-SR04)
     L:512            light, 0-1023 (LDR)
     W:1              water on ground (1 = wet)
     G:17.3850,78.4867  GPS lat,lon (0,0 = no fix)
     P                panic button pressed
     S:SENT           SMS sent by GSM module
   Web -> Arduino:
     BZ:0|1|2  buzzer off/slow/fast     VB:0|1|2  vibration off/slow/fast
     LED:0|1   status LED               SMS:<number>  send SOS SMS
*/
const $ = id => document.getElementById(id);
const DARK_BELOW = 250;     // LDR value under this = "dark" (tune for your wiring)
const MAX_CM = 250, ARC = 628.3;

let writer = null, level = "idle", isDark = null, isWet = null;
let pos = null, lastSpoken = 0, sosLock = 0;

function log(m){ const l=$('log'); l.innerHTML = new Date().toLocaleTimeString()+"  "+m+"<br>"+l.innerHTML; }

function speak(text, force){
  if(!$('voice').checked || !('speechSynthesis' in window)) return;
  const now = Date.now();
  if(!force && now - lastSpoken < 1800) return;
  lastSpoken = now;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = $('lang').value;
  speechSynthesis.speak(u);
}

async function send(cmd){
  if(!writer) return;
  try{ await writer.write(new TextEncoder().encode(cmd + "\n")); }catch(e){ log("Send failed: "+e.message); }
}

/* ---------- Sensors ---------- */
function onDistance(cm){
  const warn = +$('warn').value, danger = +$('danger').value;
  $('wv').textContent = warn; $('dv').textContent = danger;
  $('dist').textContent = cm;
  $('arc').style.strokeDashoffset = ARC * (1 - Math.max(0, Math.min(1, 1 - cm / MAX_CM)));

  let next = "clear", text = "Path clear";
  if(cm <= danger){ next = "danger"; text = "Stop. Obstacle very close"; }
  else if(cm <= warn){ next = "warn"; text = "Obstacle ahead"; }
  $('state').textContent = text;
  document.body.dataset.level = next;

  if(next === "danger") speak("Stop. Obstacle "+cm+" centimeters ahead");
  else if(next === "warn") speak("Obstacle ahead, about "+(Math.round(cm/10)*10)+" centimeters");

  if(next !== level){
    send("BZ:" + (next==="danger" ? 2 : next==="warn" ? 1 : 0));
    send("VB:" + (next==="danger" ? 2 : next==="warn" ? 1 : 0));
    if(next === "clear" && level !== "idle") speak("Path clear", true);
    log(text + " ("+cm+" cm)");
    level = next;
  }
}

function onLight(v){
  const dark = v < DARK_BELOW;
  $('lightVal').textContent = Math.round(v / 1023 * 100) + "%";
  $('lightTxt').textContent = dark ? "Dark. Stick light is on" : "Bright enough";
  if(dark !== isDark){
    send("LED:" + (dark ? 1 : 0));
    if(isDark !== null) speak(dark ? "It is getting dark" : "It is bright again", true);
    log(dark ? "Dark detected" : "Light detected");
    isDark = dark;
  }
}

function onWater(wet){
  $('waterVal').textContent = wet ? "Wet" : "Dry";
  $('waterTxt').textContent = wet ? "Water on the ground" : "No water detected";
  document.querySelectorAll('.tile')[1].classList.toggle('alert', wet);
  if(wet !== isWet){
    if(wet) speak("Careful. Water on the ground", true);
    log(wet ? "Water detected" : "Ground dry");
    isWet = wet;
  }
}

function onGPS(lat, lon){
  if(!lat && !lon){ $('gpsVal').textContent = "Searching for satellites"; $('mapLink').hidden = true; return; }
  pos = {lat, lon};
  $('gpsVal').textContent = lat.toFixed(5) + ", " + lon.toFixed(5);
  $('mapLink').href = "https://www.openstreetmap.org/?mlat="+lat+"&mlon="+lon+"#map=17/"+lat+"/"+lon;
  $('mapLink').hidden = false;
}

/* ---------- SOS ---------- */
function mapUrl(){ return pos ? "https://maps.google.com/?q="+pos.lat+","+pos.lon : null; }

function triggerSOS(){
  const now = Date.now();
  if(now < sosLock) return;
  sosLock = now + 10000;
  const num = $('phone').value.replace(/[^\d+]/g, "");
  speak("SOS activated. Sending your location.", true);
  log("SOS triggered");

  if(writer && num){
    send("SMS:" + num);
    $('sosTxt').textContent = "SOS sent through the stick's GSM module to " + num + ".";
  } else {
    const msg = encodeURIComponent("EMERGENCY! I need help. My location: " + (mapUrl() || "unknown"));
    window.open(num ? "sms:"+num+"?body="+msg : "https://wa.me/?text="+msg, "_blank");
    $('sosTxt').textContent = writer ? "Enter an emergency number to use the GSM module." : "Opened your phone's messaging app.";
  }
}

/* ---------- Serial connection ---------- */
function parse(line){
  line = line.trim(); if(!line) return;
  const i = line.indexOf(":");
  const k = i < 0 ? line : line.slice(0, i), v = i < 0 ? "" : line.slice(i + 1);
  if(k === "D") onDistance(+v);
  else if(k === "L") onLight(+v);
  else if(k === "W") onWater(v === "1");
  else if(k === "G"){ const [a, b] = v.split(",").map(Number); onGPS(a, b); }
  else if(k === "P") triggerSOS();
  else if(k === "S") log("GSM: " + v);
}

async function connect(){
  if(!('serial' in navigator)){ log("Web Serial needs Chrome or Edge. Use demo mode."); return; }
  try{
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    writer = port.writable.getWriter();
    $('pill').textContent = "Connected"; $('pill').classList.add('on');
    speak("Stick connected", true); log("Connected");

    const dec = new TextDecoderStream();
    port.readable.pipeTo(dec.writable);
    const reader = dec.readable.getReader();
    let buf = "";
    while(true){
      const { value, done } = await reader.read();
      if(done) break;
      buf += value;
      let n;
      while((n = buf.indexOf("\n")) >= 0){ parse(buf.slice(0, n)); buf = buf.slice(n + 1); }
    }
  }catch(e){ log("Connection problem: " + e.message); }
  writer = null;
  $('pill').textContent = "Not connected"; $('pill').classList.remove('on');
}

/* ---------- Wire up the page ---------- */
$('connect').onclick = connect;
$('sos').onclick = triggerSOS;
$('simDist').oninput  = e => onDistance(+e.target.value);
$('simLight').oninput = e => onLight(+e.target.value);
$('simWater').onchange = e => onWater(e.target.checked);
['warn', 'danger'].forEach(id => $(id).oninput = () => {
  $('wv').textContent = $('warn').value; $('dv').textContent = $('danger').value;
});

document.querySelectorAll('[data-test]').forEach(b => b.onclick = () => {
  const t = b.dataset.test;
  send(t + ":" + (t === "LED" ? 1 : 2));
  setTimeout(() => send(t + ":0"), 1000);
  log("Tested " + t);
});

try{ $('phone').value = localStorage.getItem('stickPhone') || ""; }catch(e){}
$('phone').onchange = () => { try{ localStorage.setItem('stickPhone', $('phone').value); }catch(e){} };
