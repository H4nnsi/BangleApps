const storage = require("Storage");

// --- 1. EINSTELLUNGEN & DATEN ---
let settings = storage.readJSON("myhealth.json", 1) || {
  age: 30, restHR: 60, maxHROverride: 0, buzzOnZone: true, customZones: null
};

let lastSession = storage.readJSON("myhealth_session.json", 1) || { 
  points: [], max: 0, min: 250, ts: 0, duration: 0, steps: 0 
};

let activeSession = { points: [], max: 0, min: 250, ts: 0, duration: 0, steps: 0 };
let hrHistory = [];
let steps = Bangle.getStepCount ? Bangle.getStepCount() : 0;
let isJogging = false, startTime = 0, startSteps = 0;
let currentHR = 0, currentZone = 0, view = "DASHBOARD", subView = 0;
let isMenuOpen = false, lastUpdate = 0, lastZoneChange = 0; 
let currentMenuLevel = "NONE"; 
let selectedDay = null;
let zoneOverlay = null;

let lastValidHRTime = 0; 

const ZONE_DEFS = [
  { name: "Z1", min: 0.50, color: "#00FFFF" },
  { name: "Z2", min: 0.60, color: "#00FF00" },
  { name: "Z3", min: 0.70, color: "#FFFF00" },
  { name: "Z4", min: 0.80, color: "#FF8C00" },
  { name: "Z5", min: 0.90, color: "#FF0000" }
];
let calculatedZones = [];

// --- 2. HINTERGRUND-SERVICE (Boot-Code) ---
function installBackgroundService() {
  const bootCode = `
{ 
  Bangle.on("health", health => {
    (Bangle.getPressure?Bangle.getPressure():Promise.resolve({})).then(pressure => {
      Object.assign(health, pressure); 
      var d = new Date(Date.now() - 590000);

      // Tisch-Check im Hintergrund
      let acc = Bangle.getAccel();
      let isTrustworthy = (health.bpmConfidence > 70);
      let isMoving = (acc.diff > 0.002);

      // Wenn absolut keine Bewegung UND Puls genau 100 oder Trust niedrig -> Tisch!
      if (!isMoving && (!isTrustworthy || health.bpm === 100)) {
        health.bpm = 0;
        health.bpmConfidence = 0;
      }

      let inf = require("health").getDecoder("HEALTH2");
      let fn = "health-"+d.getFullYear()+"-"+(d.getMonth()+1)+".raw";
      let rec = (145*(d.getDate()-1)) + (6*d.getHours()) + (0|(d.getMinutes()*6/60));
      let f = require("Storage").read(fn);
      let recordPos = 8 + (rec * inf.r);
      
      if (f !== undefined && f.substr(recordPos, inf.r) === inf.clr) {
        require("Storage").write(fn, inf.encode(health), recordPos);
      } else if (f === undefined) {
        require("Storage").write(fn, "HEALTH2\\0", 0, 8 + 145*31*inf.r);
        require("Storage").write(fn, inf.encode(health), recordPos);
      }

      if (health.bpm > 0) {
        let todayStr = new Date().toISOString().split('T')[0];
        let todayData = require("Storage").readJSON("myhealth_today.json", 1) || { date: todayStr, sum:0, count:0, min:250, max:0, steps:0, points:[] };
        if (todayData.date !== todayStr) {
          let log = require("Storage").readJSON("myhealth_weekly.json", 1) || [];
          if (todayData.count > 0) {
            log.push({date: todayData.date, min: todayData.min, max: todayData.max, avg: Math.round(todayData.sum / todayData.count), steps: todayData.steps, points: todayData.points});
            if (log.length > 7) log.shift();
            require("Storage").writeJSON("myhealth_weekly.json", log);
          }
          todayData = { date: todayStr, sum:0, count:0, min:250, max:0, steps:0, points:[] };
        }
        todayData.sum += health.bpm; todayData.count++;
        todayData.min = Math.min(todayData.min, health.bpm);
        todayData.max = Math.max(todayData.max, health.bpm);
        todayData.points.push(health.bpm);
        todayData.steps = Bangle.getStepCount ? Bangle.getStepCount() : 0;
        require("Storage").writeJSON("myhealth_today.json", todayData);
      }
    });
  });
}
  `;
  storage.write("myhealth.boot.js", bootCode);
}

// --- 3. ÜBERARBEITETE HRM FUNKTION (App-Logik) ---
function updateStats(h) {
  let acc = Bangle.getAccel();
  
  // Wir nutzen h.confidence (Trust-Wert)
  // Trust unter 60 ist meistens Rauschen. 
  // Trust 100 bei acc.diff < 0.0015 ist fast immer ein Tisch.
  
  let trust = h.confidence;
  let move = acc.diff;
  let isTable = (move < 0.0018 && (trust < 90 || h.bpm === 100));

  if (trust < 60 || isTable) {
    // Falls die Daten schlecht sind, brechen wir hier ab.
    // currentHR wird nicht aktualisiert, was nach 30s zum "--" führt.
    return;
  }

  // Daten sind valide!
  lastValidHRTime = Date.now();
  currentHR = h.bpm;
  
  let now = Date.now();
  hrHistory.push(h.bpm);
  if (hrHistory.length > 40) hrHistory.shift();
  
  if (isJogging) {
    let newZone = 0;
    for (let i = calculatedZones.length - 1; i >= 0; i--) {
      if (h.bpm >= calculatedZones[i].minBpm) { newZone = i + 1; break; }
    }
    if (newZone !== currentZone && currentZone !== 0 && (now - lastZoneChange > 15000)) {
      if (settings.buzzOnZone) Bangle.buzz(600);
      currentZone = newZone;
      lastZoneChange = now;
      zoneOverlay = "ZONE " + newZone;
      setTimeout(() => { zoneOverlay = null; render(); }, 3000);
    } else if (currentZone === 0) { currentZone = newZone; }
    
    if (now - lastUpdate > 10000) {
      activeSession.points.push(h.bpm);
      activeSession.max = Math.max(activeSession.max, h.bpm);
      activeSession.min = Math.min(activeSession.min, h.bpm);
      activeSession.duration = Math.floor((now - startTime) / 1000);
      activeSession.steps = steps - startSteps;
      lastUpdate = now;
      if (activeSession.duration > 180) {
        lastSession = activeSession;
        storage.writeJSON("myhealth_session.json", lastSession);
      }
    }
  }
}

// --- 4. RENDER ---
function render() {
  if (isMenuOpen) return;
  if (view === "DAY_GRAPH") { drawDayGraphUI(); return; }
  if (view === "GRAPH") { drawHistoryPage(); return; }
  
  const w = g.getWidth(), h = g.getHeight();
  let midX = isJogging ? (w / 2 + 12) : (w / 2);
  let bgColor = "#000", txtCol = "#FFF", labCol = "#888";
  if (isJogging && currentZone > 0) { bgColor = calculatedZones[currentZone-1].color; txtCol = "#000"; labCol = "#333"; }
  
  g.setBgColor(bgColor).clear();
  Bangle.drawWidgets();
  
  // Schritte anzeigen (ohne Schloss-Icon daneben)
  g.setFont("Vector", 16).setColor(isJogging ? txtCol : "#0F0").setFontAlign(-1, -1).drawString("👟 " + steps, 10, 30);
  
  if (isJogging) {
    const barX = 2, barW = 18, barYStart = 55, stepH = 100 / 5;
    calculatedZones.forEach((z, i) => {
      let y = barYStart + ((4 - i) * stepH);
      g.setColor(z.color).fillRect(barX, y, barX + barW, y + stepH - 3);
      if (currentZone === i + 1) g.setColor(txtCol).drawRect(barX-1, y-1, barX+barW+1, y+stepH-2);
    });
    let diff = Math.floor((Date.now() - startTime) / 1000);
    g.setFont("Vector", 16).setColor(txtCol).setFontAlign(1, -1).drawString(Math.floor(diff/60)+":"+("0"+(diff%60)).slice(-2), w-5, 30);
  }
  
  // 30 Sek Check
  let displayHR = "--";
  if (Date.now() - lastValidHRTime < 30000 && currentHR > 0) {
    displayHR = currentHR;
  }

  g.setFont("Vector", 12).setColor(labCol).setFontAlign(0, -1).drawString("PULS", midX, 58);
  g.setFont("Vector", 40).setColor(txtCol).setFontAlign(0, -1).drawString(displayHR, midX, 72);
  
  if (!isJogging) {    
    let avg = hrHistory.length ? Math.round(hrHistory.reduce((a,b)=>a+b, 0)/hrHistory.length) : "--";
    g.setFont("Vector", 14).setColor(labCol).setFontAlign(0, -1).drawString("AVG (10M)", midX, 125);
    g.setFont("Vector", 26).setColor(txtCol).setFontAlign(0, -1).drawString(avg, midX, 138);
    
    // Einstellungen Icon
    g.setColor("#FFF").fillCircle(w - 20, 45, 10);
    g.setColor(bgColor).fillCircle(w - 20, 45, 4);
  }
  
  g.setColor(isJogging ? "#000" : "#111").fillRect(20, 158, w-10, 174);
  g.setColor(isJogging ? "#FFF" : "#0FF").setFont("Vector", 15).setFontAlign(0,0).drawString(isJogging?"STOP":"START JOGGING", w/2+10, 166);
  
  if (isJogging && zoneOverlay) {
    g.setColor("#000").fillRect(15, 60, w-15, 120).setColor("#FFF").drawRect(15, 60, w-15, 120);
    g.setFont("Vector", 24).setFontAlign(0, 0).setColor(calculatedZones[currentZone-1].color).drawString(zoneOverlay, w/2, 90);
  }
  g.flip();
}

// --- RESTLICHE FUNKTIONEN (Unverändert) ---
function calculateZones() {
  let maxHR = (settings.maxHROverride > 0) ? settings.maxHROverride : (220 - settings.age);
  let reserve = maxHR - settings.restHR;
  calculatedZones = ZONE_DEFS.map((z, i) => {
    let bpm = Math.round((reserve * z.min) + settings.restHR);
    if (settings.customZones && settings.customZones[i]) bpm = settings.customZones[i];
    return { name: z.name, minBpm: bpm, color: z.color };
  });
}

function saveSettings() {
  storage.writeJSON("myhealth.json", settings);
  calculateZones();
}

function exportCSV() {
  E.showMessage("Export...");
  let csv = "Timestamp,Source,BPM\n";
  let log = storage.readJSON("myhealth_weekly.json", 1) || [];
  log.forEach(day => {
    if (day.points) {
      day.points.forEach((bpm, i) => {
        let t = new Date(new Date(day.date).getTime() + (i * 600000)).toISOString();
        csv += `${t},Background,${bpm}\n`;
      });
    }
  });
  storage.write("myhealth_full.csv", csv);
  E.showAlert("Export fertig!").then(() => openMenu());
}

function drawHistoryPage() {
  g.setBgColor("#000").clear();
  const w = g.getWidth(), h = g.getHeight();
  Bangle.drawWidgets();
  if (subView === 0) {
    let d = new Date(lastSession.ts || Date.now());
    g.setColor("#0FF").setFont("Vector", 14).setFontAlign(0,-1).drawString("LETZTES TRAINING", w/2, 35);
    let stats = [
      {l: "Dauer:", v: Math.floor(lastSession.duration/60) + "m", c: "#FFF"},
      {l: "Schritte:", v: lastSession.steps || "0", c: "#0F0"},
      {l: "Max HR:", v: lastSession.max, c: "#F00"}
    ];
    stats.forEach((s, i) => {
      g.setFont("Vector", 18).setColor("#888").setFontAlign(-1,-1).drawString(s.l, 10, 85 + i*22);
      g.setColor(s.c).setFontAlign(1,-1).drawString(s.v, w-10, 85 + i*22);
    });
  }
  g.flip();
}

function drawDayGraphUI() {
  g.setBgColor("#000").clear();
  const w = g.getWidth(), h = g.getHeight();
  Bangle.drawWidgets();
  if (selectedDay) {
    g.setColor("#FFF").setFont("Vector", 12).setFontAlign(0,-1).drawString("TAG: " + selectedDay.date, w/2, 35);
  }
  g.flip();
}

function openMenu() {
  currentMenuLevel = "MAIN"; isMenuOpen = true;
  let maxHROver = settings.maxHROverride > 0 ? settings.maxHROverride : (220 - settings.age);
  E.showMenu({
    "": { "title": "-- SETUP --" },
    "Alter": { value: settings.age, min: 10, max: 99, onchange: v => { settings.age = v; saveSettings(); openMenu(); } },
    "Ruhepuls": { value: settings.restHR, min: 30, max: 120, onchange: v => { settings.restHR = v; saveSettings(); } },
    "Max Puls": { value: maxHROver, min: 100, max: 230, onchange: v => { settings.maxHROverride = v; saveSettings(); openMenu(); } },
    "WOCHEN-LOG": () => showWeeklyLog(),
    "EXPORT CSV": () => exportCSV(),
    "ZURÜCK": () => handleBack()
  });
}

function showWeeklyLog() {
  currentMenuLevel = "WEEKLY"; isMenuOpen = true;
  let log = storage.readJSON("myhealth_weekly.json", 1) || [];
  let menu = { "": { "title": "LOG" } };
  log.slice().reverse().forEach(e => {
    menu[e.date] = () => { selectedDay = e; view = "DAY_GRAPH"; isMenuOpen = false; E.showMenu(); setUI(); render(); };
  });
  menu["ZURÜCK"] = () => openMenu();
  E.showMenu(menu);
}

function handleBack() {
  if (view !== "DASHBOARD") { view = "DASHBOARD"; setUI(); render(); return; }
  if (isMenuOpen) { isMenuOpen = false; E.showMenu(); setUI(); render(); return; }
  load(); 
}

function setUI() {
  Bangle.setUI({
    mode: "custom",
    swipe: (dir) => { 
      if (view === "DASHBOARD" && !isJogging) { view = "GRAPH"; render(); }
    },
    touch: (n, e) => {
      if (isMenuOpen) return;
      if (!isJogging && e.x > 120 && e.y < 80) { openMenu(); return; }
      if (e.y > 150) {
        isJogging = !isJogging;
        if (isJogging) { 
          startTime = Date.now(); startSteps = steps; 
          activeSession = { points: [], max: 0, min: 250, ts: Date.now(), duration: 0, steps: 0 }; 
        }
        Bangle.buzz(100); Bangle.setHRMPower(1, "jog"); render();
      }
    }
  });
}

// --- START ---
setWatch(() => handleBack(), BTN1, {repeat:true, edge:"falling"});
Bangle.on('HRM', h => { updateStats(h); if(!isMenuOpen) render(); });
Bangle.on('step', s => { steps = s; if(!isMenuOpen) render(); });
setInterval(() => { if (!isMenuOpen) render(); }, 1000);

Bangle.loadWidgets();
installBackgroundService();
calculateZones();
Bangle.setHRMPower(1, "init");
setUI();
render();
