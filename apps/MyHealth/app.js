const storage = require("Storage");

// --- 1. EINSTELLUNGEN & DATEN ---
let settings = storage.readJSON("myhealth.json", 1) || {
  age: 30, restHR: 60, maxHROverride: 0, buzzOnZone: true, customZones: null
};

// Aktuelle/Letzte Session-Files
let lastSession = storage.readJSON("myhealth_session.json", 1) || { 
  points: [], max: 0, min: 250, ts: 0, duration: 0, steps: 0 
};
// Historie-Liste laden
let sessionHistory = storage.readJSON("myhealth_history.json", 1) || [];

let activeSession = { points: [], max: 0, min: 250, ts: 0, duration: 0, steps: 0 };
let hrHistory = [];
let steps = Bangle.getStepCount ? Bangle.getStepCount() : 0;
let isJogging = false, startTime = 0, startSteps = 0;
let currentHR = 0, currentZone = 0, view = "DASHBOARD", subView = 0;
let isMenuOpen = false, lastUpdate = 0, lastZoneChange = 0; 
let selectedDay = null; // Für Health-Tages-Logs
let selectedHistorySession = null; // Für die neue Trainings-Historie
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

// --- 2. HRM LOGIK ---
function updateStats(h) {
  let acc = Bangle.getAccel();
  let trust = h.confidence;
  let move = acc.diff;
  let isTable = (move < 0.02 && (trust < 90 || h.bpm === 100));

  if (trust < 70 || isTable) return;

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
    }
  }
}

// Speichert die aktuelle Session permanent in der Historie
function saveSessionToHistory() {
  if (activeSession.duration < 30) return; // Zu kurz zum Speichern
  
  lastSession = activeSession;
  storage.writeJSON("myhealth_session.json", lastSession);
  
  // Zur Liste hinzufügen (oben anstellen)
  sessionHistory.unshift(activeSession);
  // Nur die letzten 10 behalten
  if (sessionHistory.length > 10) sessionHistory.pop();
  
  storage.writeJSON("myhealth_history.json", sessionHistory);
}

// --- 3. RENDER FUNKTIONEN ---
function render() {
  if (isMenuOpen) return;
  if (view === "DAY_GRAPH") { drawDayGraphUI(); return; }
  if (view === "HISTORY_DETAIL") { drawHistoryDetailPage(); return; }
  if (view === "GRAPH") { drawHistoryPage(); return; }
  
  const w = g.getWidth(), h = g.getHeight();
  let midX = isJogging ? (w / 2 + 12) : (w / 2);
  let bgColor = "#000", txtCol = "#FFF", labCol = "#888";
  if (isJogging && currentZone > 0) { bgColor = calculatedZones[currentZone-1].color; txtCol = "#000"; labCol = "#333"; }
  
  g.setBgColor(bgColor).clear();
  Bangle.drawWidgets();
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
  
  let displayHR = "--";
  if (Date.now() - lastValidHRTime < 30000 && currentHR > 0) displayHR = currentHR;
  g.setFont("Vector", 12).setColor(labCol).setFontAlign(0, -1).drawString("PULS", midX, 58);
  g.setFont("Vector", 40).setColor(txtCol).setFontAlign(0, -1).drawString(displayHR, midX, 72);
  
  if (!isJogging) {    
    let avg = hrHistory.length ? Math.round(hrHistory.reduce((a,b)=>a+b, 0)/hrHistory.length) : "--";
    g.setFont("Vector", 14).setColor(labCol).setFontAlign(0, -1).drawString("AVG (10M)", midX, 125);
    g.setFont("Vector", 26).setColor(txtCol).setFontAlign(0, -1).drawString(avg, midX, 138);
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

// Zeichnet eine beliebige Session (lastSession oder aus Historie)
function drawGenericSession(s, title) {
  const w = g.getWidth(), h = g.getHeight();
  if (subView === 0) {
    g.setColor("#0FF").setFont("Vector", 14).setFontAlign(0,-1).drawString(title, w/2, 35);
    let stats = [
      {l: "Dauer:", v: Math.floor(s.duration/60) + "m", c: "#FFF"},
      {l: "Schritte:", v: s.steps || "0", c: "#0F0"},
      {l: "Max HR:", v: s.max, c: "#F00"}
    ];
    stats.forEach((item, i) => {
      g.setFont("Vector", 18).setColor("#888").setFontAlign(-1,-1).drawString(item.l, 10, 85 + i*22);
      g.setColor(item.c).setFontAlign(1,-1).drawString(item.v, w-10, 85 + i*22);
    });
    g.setColor("#444").setFont("Vector", 10).setFontAlign(0, 1).drawString("Wische für Graph >", w/2, h-5);
  } else {
    g.setColor("#0FF").setFont("Vector", 14).setFontAlign(0,-1).drawString("PULSVERLAUF", w/2, 35);
    if (s.points && s.points.length > 1) {
      let pts = s.points, min = s.min - 5, max = s.max + 5;
      let range = (max - min) || 1, gw = w - 40, gh = 60;
      g.setColor("#444").drawRect(20, 70, 20 + gw, 70 + gh);
      g.setColor("#F00");
      for (let i = 0; i < pts.length - 1; i++) {
        let x1 = 20 + (i * gw / (pts.length - 1)), y1 = 70 + gh - ((pts[i] - min) * gh / range);
        let x2 = 20 + ((i + 1) * gw / (pts.length - 1)), y2 = 70 + gh - ((pts[i+1] - min) * gh / range);
        g.drawLine(x1, y1, x2, y2);
      }
      g.setFont("Vector", 10).setColor("#888").setFontAlign(0,-1).drawString("Min: "+s.min+"  Max: "+s.max, w/2, 140);
    }
    g.setColor("#444").setFont("Vector", 10).setFontAlign(0, 1).drawString("< Wische zurück", w/2, h-5);
  }
}

function drawHistoryPage() {
  g.setBgColor("#000").clear();
  Bangle.drawWidgets();
  drawGenericSession(lastSession, "LETZTES TRAINING");
  g.flip();
}

function drawHistoryDetailPage() {
  g.setBgColor("#000").clear();
  Bangle.drawWidgets();
  let timeStr = new Date(selectedHistorySession.ts).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
  drawGenericSession(selectedHistorySession, "LAUF UM " + timeStr);
  g.flip();
}

function drawDayGraphUI() {
  g.setBgColor("#000").clear();
  const w = g.getWidth(), h = g.getHeight();
  Bangle.drawWidgets();
  if (selectedDay) {
    g.setColor("#FFF").setFont("Vector", 12).setFontAlign(0,-1).drawString("TAG: " + selectedDay.date, w/2, 35);
    if (selectedDay.points && selectedDay.points.length > 1) {
      let pts = selectedDay.points, min = selectedDay.min - 5, max = selectedDay.max + 5;
      if(min < 0) min = 0;
      let range = (max - min) || 1, gw = w - 40, gh = 60;
      g.setColor("#444").drawRect(20, 70, 20 + gw, 70 + gh);
      g.setColor("#0F0");
      for (let i = 0; i < pts.length - 1; i++) {
        let x1 = 20 + (i * gw / (pts.length - 1)), y1 = 70 + gh - ((pts[i] - min) * gh / range);
        let x2 = 20 + ((i + 1) * gw / (pts.length - 1)), y2 = 70 + gh - ((pts[i+1] - min) * gh / range);
        g.drawLine(x1, y1, x2, y2);
      }
      g.setFont("Vector", 10).setColor("#AAA").setFontAlign(0,-1).drawString("Min: " + selectedDay.min + "  Max: " + selectedDay.max, w/2, 138);
      g.setFont("Vector", 10).setColor("#888").setFontAlign(0,-1).drawString("Schritte: " + selectedDay.steps, w/2, 150);
    }
  }
  g.flip();
}

// --- 4. LOGIK & NAVIGATION ---

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

function openMenu() {
  isMenuOpen = true;
  let maxHROver = settings.maxHROverride > 0 ? settings.maxHROverride : (220 - settings.age);
  
  let mainStats = {
    "": { "title": "-- SETUP --" },
    "Alter": { value: settings.age, min: 10, max: 99, onchange: v => { settings.age = v; saveSettings(); } },
    "Ruhepuls": { value: settings.restHR, min: 30, max: 120, onchange: v => { settings.restHR = v; saveSettings(); } },
    "ZONEN BPM": () => showZoneMenu(),
    "TRAININGS-LOG": () => showTrainingHistory(), // NEU: Trainings Historie
    "TAGES-LOG": () => showWeeklyLog(),
    "EXPORT CSV": () => exportCSV(),
    "ZURÜCK": () => handleBack()
  };
  E.showMenu(mainStats);
}

function showTrainingHistory() {
  if (sessionHistory.length === 0) {
    E.showAlert("Keine Trainings gespeichert").then(() => openMenu());
    return;
  }
  let menu = { "": { "title": "TRAININGS" } };
  sessionHistory.forEach((s, i) => {
    let d = new Date(s.ts);
    let label = d.getDate()+"."+(d.getMonth()+1)+". "+d.getHours()+":"+("0"+d.getMinutes()).slice(-2);
    menu[label] = () => {
      selectedHistorySession = s;
      view = "HISTORY_DETAIL";
      subView = 0;
      isMenuOpen = false;
      E.showMenu();
      setUI();
      render();
    };
  });
  menu["< ZURÜCK"] = () => openMenu();
  E.showMenu(menu);
}

function showZoneMenu() {
  let menu = { "": { "title": "ZONEN BPM" } };
  if (!settings.customZones) settings.customZones = calculatedZones.map(z => z.minBpm);
  calculatedZones.forEach((z, i) => {
    menu[z.name + " (min)"] = {
      value: settings.customZones[i], min: 40, max: 220,
      onchange: v => { settings.customZones[i] = v; saveSettings(); }
    };
  });
  menu["RESET (AUTO)"] = () => { settings.customZones = null; saveSettings(); showZoneMenu(); };
  menu["< ZURÜCK"] = () => openMenu();
  E.showMenu(menu);
}

function showWeeklyLog() {
  E.showMessage("Lade Daten...");
  setTimeout(() => {
    isMenuOpen = true;
    let menu = { "": { "title": "TAGE" } };
    let healthMod; try { healthMod = require("health"); } catch(e) {}
    for(let i=0; i<7; i++) {
      (function(offset) {
        let d = new Date(Date.now() - offset * 86400000);
        let dateStr = d.toISOString().split('T')[0];
        let stat = { date: dateStr, min: 250, max: 0, sum: 0, count: 0, steps: 0, points: [] };
        if (healthMod) {
          healthMod.readDay(d, h => {
            if (h.bpm > 0) {
              stat.min = Math.min(stat.min, h.bpm);
              stat.max = Math.max(stat.max, h.bpm);
              stat.sum += h.bpm; stat.count++;
              stat.points.push(h.bpm);
            }
            if (h.steps > 0) stat.steps += h.steps;
          });
        }
        if (stat.count > 0 || stat.steps > 0) {
          menu[dateStr] = () => { selectedDay = stat; view = "DAY_GRAPH"; isMenuOpen = false; E.showMenu(); setUI(); render(); };
        }
      })(i);
    }
    menu["ZURÜCK"] = () => openMenu();
    E.showMenu(menu);
  }, 50); 
}

function exportCSV() {
  E.showMessage("Export...");
  let csv = "Timestamp,BPM,Steps\n";
  let healthMod; try { healthMod = require("health"); } catch(e) {}
  if (healthMod) {
    for(let i=6; i>=0; i--) { 
      (function(offset) {
        let d = new Date(Date.now() - offset * 86400000);
        healthMod.readDay(d, h => {
          if (h.bpm > 0 || h.steps > 0) {
            let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h.hr, h.min).toISOString();
            csv += t + "," + (h.bpm || 0) + "," + (h.steps || 0) + "\n";
          }
        });
      })(i);
    }
  }
  storage.write("myhealth_full.csv", csv);
  E.showAlert("Export fertig!").then(() => openMenu());
}

function handleBack() {
  if (view !== "DASHBOARD") { view = "DASHBOARD"; subView = 0; setUI(); render(); return; }
  if (isMenuOpen) { isMenuOpen = false; E.showMenu(); setUI(); render(); return; }
  load(); 
}

function setUI() {
  Bangle.setUI({
    mode: "custom",
    swipe: (dir) => { 
      if (isMenuOpen) return;
      if (view === "DASHBOARD") {
        if (dir === -1 && !isJogging) { view = "GRAPH"; subView = 0; render(); }
      } else if (view === "GRAPH" || view === "HISTORY_DETAIL") {
        if (dir === -1) { if (subView === 0) { subView = 1; render(); } }
        else if (dir === 1) { 
          if (subView === 1) { subView = 0; render(); } 
          else { view = "DASHBOARD"; render(); } 
        }
      } else if (view === "DAY_GRAPH") {
        if (dir === 1) { view = "DASHBOARD"; render(); }
      }
    },
    touch: (n, e) => {
      if (isMenuOpen) return;
      if (view === "DAY_GRAPH") { showWeeklyLog(); return; }
      if (view === "HISTORY_DETAIL") { showTrainingHistory(); return; }

      if (view === "DASHBOARD" && !isJogging && e.x > 120 && e.y < 80) { openMenu(); return; }
      if (view === "DASHBOARD" && e.y > 150) {
        isJogging = !isJogging;
        if (isJogging) { 
          startTime = Date.now(); startSteps = steps; 
          activeSession = { points: [], max: 0, min: 250, ts: Date.now(), duration: 0, steps: 0 }; 
        } else {
          saveSessionToHistory(); // Speichern beim Stop
        }
        Bangle.buzz(100); Bangle.setHRMPower(1, "jog"); render();
      }
    }
  });
}

// --- 5. START ---
setWatch(() => handleBack(), BTN1, {repeat:true, edge:"falling"});
Bangle.on('HRM', h => { updateStats(h); if(!isMenuOpen) render(); });
Bangle.on('step', s => { steps = s; if(!isMenuOpen) render(); });
setInterval(() => { if (!isMenuOpen) render(); }, 1000);

Bangle.loadWidgets();
calculateZones();
Bangle.setHRMPower(1, "init");
setUI();
render();
