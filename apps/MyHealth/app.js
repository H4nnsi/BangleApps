const storage = require("Storage");

// --- 1. EINSTELLUNGEN & DATEN LADEN ---
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
let isLocked = Bangle.isLocked(); 
let currentMenuLevel = "NONE"; 
let selectedDay = null;
let zoneOverlay = null;

const ZONE_DEFS = [
  { name: "Z1", min: 0.50, color: "#00FFFF" },
  { name: "Z2", min: 0.60, color: "#00FF00" },
  { name: "Z3", min: 0.70, color: "#FFFF00" },
  { name: "Z4", min: 0.80, color: "#FF8C00" },
  { name: "Z5", min: 0.90, color: "#FF0000" }
];
let calculatedZones = [];

// --- 2. HINTERGRUND-SERVICE (Kombiniert: Bangle Standard + Custom UI Daten) ---
function installBackgroundService() {
  const bootCode = `
{ 
  let settings = require("Storage").readJSON("health.json", 1) || {};
  let hrm = settings.hrm !== undefined ? settings.hrm : 2; // 2 = 10 Minuten
  
  if (hrm == 1 || hrm == 2) { 
    let onHealth = function(h) {
      function startMeasurement() {
        if (Bangle.isCharging() || (Bangle.getHealthStatus("last").movement<100 && Math.abs(Bangle.getAccel().z)>0.99)) return;
        Bangle.setHRMPower(1, "health");
        setTimeout(() => { Bangle.setHRMPower(0, "health"); }, hrm * 60000); 
      }
      startMeasurement();
      if (hrm == 1) { setTimeout(startMeasurement, 200000); setTimeout(startMeasurement, 400000); }
    }
    Bangle.on("health", onHealth);
    Bangle.on("HRM", (h) => {
      if (h.confidence > 90 && Math.abs(Bangle.getHealthStatus().bpm - h.bpm) < 1) Bangle.setHRMPower(0, "health");
    });
    if (Bangle.getHealthStatus().bpmConfidence < 90) onHealth(); 
  } else Bangle.setHRMPower(!!hrm, "health"); 

  Bangle.on("health", health => {
    (Bangle.getPressure?Bangle.getPressure():Promise.resolve({})).then(pressure => {
      Object.assign(health, pressure); 
      var d = new Date(Date.now() - 590000);

      // --- OFFIZIELLE .RAW AUFZEICHNUNG & SCHRITTZIEL ---
      if (health && health.steps > 0) {
        var sSettings = require("Storage").readJSON("health.json",1)||{};
        const stepsDay = Bangle.getHealthStatus("day").steps;
        if (sSettings.stepGoalNotification && sSettings.stepGoal > 0 && stepsDay >= sSettings.stepGoal) {
          const nowStr = new Date(Date.now()).toISOString().split('T')[0];
          if (!sSettings.stepGoalNotificationDate || sSettings.stepGoalNotificationDate < nowStr) {
            Bangle.buzz(200, 0.5);
            require("notify").show({ title: sSettings.stepGoal + " Schritte", body: "Ziel erreicht!", icon: atob("DAyBABmD6BaBMAsA8BCBCBCBCA8AAA==") });
            sSettings.stepGoalNotificationDate = nowStr;
            require("Storage").writeJSON("health.json", sSettings);
          }
        }
      }

      let inf = require("health").getDecoder("HEALTH2");
      let fn = "health-"+d.getFullYear()+"-"+(d.getMonth()+1)+".raw";
      let rec = (145*(d.getDate()-1)) + (6*d.getHours()) + (0|(d.getMinutes()*6/60));
      let f = require("Storage").read(fn);
      if (!f) { require("Storage").write(fn, "HEALTH2\\0", 0, 8 + 145*31*inf.r); }
      require("Storage").write(fn, inf.encode(health), 8+(rec*inf.r));

      // --- CUSTOM DATEN FÜR DEIN DASHBOARD (myhealth_today.json) ---
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
        if (!todayData.points) todayData.points = [];
        todayData.points.push(health.bpm);
        todayData.steps = Bangle.getStepCount ? Bangle.getStepCount() : 0;
        require("Storage").writeJSON("myhealth_today.json", todayData);
        print("[BG] Dashboard & Raw Daten aktualisiert. Puls: " + health.bpm);
      }
    });
  });
}
  `;
  if (storage.read("myhealth.boot.js") !== bootCode) {
    storage.write("myhealth.boot.js", bootCode);
    print("-> Profi Hintergrund-Service installiert!");
  }
}

// --- 3. LOGIK ---
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

function updateStats(h) {
  let bpm = h.bpm;
  if (bpm < 40 || bpm > 230 || h.confidence < 60) return;
  currentHR = bpm;
  let now = Date.now();
  hrHistory.push(bpm);
  if (hrHistory.length > 40) hrHistory.shift();
  
  if (isJogging) {
    let newZone = 0;
    for (let i = calculatedZones.length - 1; i >= 0; i--) {
      if (bpm >= calculatedZones[i].minBpm) { newZone = i + 1; break; }
    }
    if (newZone !== currentZone && currentZone !== 0 && (now - lastZoneChange > 15000)) {
      if (settings.buzzOnZone) Bangle.buzz(600);
      currentZone = newZone;
      lastZoneChange = now;
      zoneOverlay = "ZONE " + newZone;
      setTimeout(() => { zoneOverlay = null; render(); }, 3000);
    } else if (currentZone === 0) { currentZone = newZone; }
    
    if (now - lastUpdate > 10000) {
      activeSession.points.push(bpm);
      activeSession.max = Math.max(activeSession.max, bpm);
      activeSession.min = Math.min(activeSession.min, bpm);
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

function exportCSV() {
  E.showMessage("Exportiere...");
  let csv = "Timestamp,Source,BPM\n";
  if (lastSession.ts && lastSession.points) {
    lastSession.points.forEach((bpm, i) => {
      let t = new Date(lastSession.ts + (i * 10000)).toISOString();
      csv += `${t},Training,${bpm}\n`;
    });
  }
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
  E.showAlert("Export fertig!\nmyhealth_full.csv").then(() => openMenu());
}

// --- 4. RENDER HILFEN ---
function getBGStatus() {
  let todayData = storage.readJSON("myhealth_today.json", 1);
  if (!todayData || !todayData.points || todayData.points.length === 0) return { text: "--:--", col: "#888" };
  
  let now = new Date();
  let lastMin = Math.floor(now.getMinutes() / 10) * 10;
  let lastTimeText = (now.getHours() < 10 ? "0" : "") + now.getHours() + ":" + (lastMin < 10 ? "0" : "") + lastMin;
  
  let diff = now.getMinutes() % 10;
  let color = (diff < 5) ? "#0F0" : "#F80"; 
  return { text: lastTimeText, col: color };
}

function drawLockIcon(x, y, color) { g.setColor(color); g.fillRect(x, y + 4, x + 10, y + 10); g.drawRect(x + 2, y, x + 8, y + 4); }
function drawGear(x, y, r, bgCol) { g.setColor("#FFF").fillCircle(x, y, r); for(let i = 0; i < 8; i++) { let a = i * Math.PI / 4; g.fillPoly([x + Math.cos(a) * (r + 4), y + Math.sin(a) * (r + 4), x + Math.cos(a - 0.3) * r, y + Math.sin(a - 0.3) * r, x + Math.cos(a + 0.3) * r, y + Math.sin(a + 0.3) * r]); } g.setColor(bgCol).fillCircle(x, y, r * 0.45); }

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
  
  if (isLocked) drawLockIcon(5, 30, isJogging ? txtCol : "#FF0");
  g.setFont("Vector", 16).setColor(isJogging ? txtCol : "#0F0").setFontAlign(-1, -1).drawString("👟 " + steps, 25, 30);
  
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
  
  g.setFont("Vector", 12).setColor(labCol).setFontAlign(0, -1).drawString("PULS", midX, 58);
  g.setFont("Vector", 40).setColor(txtCol).setFontAlign(0, -1).drawString(currentHR || "--", midX, 72);
  
  if (!isJogging) {
    let bgStatus = getBGStatus();
    g.setFont("Vector", 10).setColor(labCol).setFontAlign(0, -1).drawString("BG-CHECK:", midX - 20, 110);
    g.setColor(bgStatus.col).drawString(bgStatus.text, midX + 25, 110);
    
    let avg = hrHistory.length ? Math.round(hrHistory.reduce((a,b)=>a+b, 0)/hrHistory.length) : "--";
    g.setFont("Vector", 14).setColor(labCol).setFontAlign(0, -1).drawString("AVG (10M)", midX, 125);
    g.setFont("Vector", 26).setColor(txtCol).setFontAlign(0, -1).drawString(avg, midX, 138);
    drawGear(w - 20, 45, 10, bgColor);
  }
  
  g.setColor(isJogging ? "#000" : "#111").fillRect(20, 158, w-10, 174);
  g.setColor(isJogging ? "#FFF" : "#0FF").setFont("Vector", 15).setFontAlign(0,0).drawString(isJogging?"STOP":"START JOGGING", w/2+10, 166);
  
  if (isJogging && zoneOverlay) {
    g.setColor("#000").fillRect(15, 60, w-15, 120).setColor("#FFF").drawRect(15, 60, w-15, 120);
    g.setFont("Vector", 24).setFontAlign(0, 0).setColor(calculatedZones[currentZone-1].color).drawString(zoneOverlay, w/2, 90);
  }
  g.flip();
}

function drawHistoryPage() {
  g.setBgColor("#000").clear();
  const w = g.getWidth(), h = g.getHeight();
  Bangle.drawWidgets();
  if (subView === 0) {
    let d = new Date(lastSession.ts || Date.now());
    g.setColor("#0FF").setFont("Vector", 14).setFontAlign(0,-1).drawString("LETZTES TRAINING", w/2, 35);
    g.setColor("#FFF").setFont("Vector", 18).drawString(("0"+d.getDate()).slice(-2)+"."+("0"+(d.getMonth()+1)).slice(-2), w/2, 55);
    let stats = [
      {l: "Dauer:", v: Math.floor(lastSession.duration/60) + "m", c: "#FFF"},
      {l: "Schritte:", v: lastSession.steps || "0", c: "#0F0"},
      {l: "Max HR:", v: lastSession.max, c: "#F00"},
      {l: "Min HR:", v: (lastSession.min === 250 ? "--" : lastSession.min), c: "#0FF"}
    ];
    stats.forEach((s, i) => {
      g.setFont("Vector", 18).setColor("#888").setFontAlign(-1,-1).drawString(s.l, 10, 85 + i*22);
      g.setColor(s.c).setFontAlign(1,-1).drawString(s.v, w-10, 85 + i*22);
    });
  } else {
    g.setColor("#FFF").setFont("Vector", 12).setFontAlign(0,-1).drawString("TRAINING GRAPH", w/2, 35);
    let pts = lastSession.points || [];
    if (pts.length > 1) {
      let minP = (lastSession.min||60)-5, maxP = (lastSession.max||180)+5, range = maxP-minP;
      const gT=60, gB=h-30, gH=gB-gT;
      const getYp = (p) => gB - ((p - minP) / range) * gH;
      let stepX = (w-20) / (pts.length-1);
      g.setColor("#FFF");
      for (let i=0; i<pts.length-1; i++) g.drawLine(10+i*stepX, getYp(pts[i]), 10+(i+1)*stepX, getYp(pts[i+1]));
    }
  }
  g.setColor("#333").fillRect(0, h-24, w, h);
  g.setFontAlign(0,0).setColor("#0FF").setFont("Vector", 12).drawString("<< WISCHEN / BTN ZURÜCK >>", w/2, h-12);
  g.flip();
}

function drawDayGraphUI() {
  g.setBgColor("#000").clear();
  const w = g.getWidth(), h = g.getHeight();
  Bangle.drawWidgets();
  if (!selectedDay) return;
  const pts = selectedDay.points || [];
  g.setColor("#FFF").setFont("Vector", 12).setFontAlign(0,-1).drawString("VERLAUF: " + selectedDay.date, w/2, 35);
  if (pts.length < 2) {
    g.setFontAlign(0,0).drawString("Zu wenige Daten", w/2, h/2);
  } else {
    let minP = Math.min.apply(null, pts) - 5, maxP = Math.max.apply(null, pts) + 5, range = maxP - minP;
    const gT = 60, gB = h - 35, gH = gB - gT;
    const getY = (p) => gB - ((p - minP) / range) * gH;
    calculatedZones.forEach(z => { let y = getY(z.minBpm); if (y >= gT && y <= gB) { g.setColor(z.color).drawLine(10, y, w-10, y); } });
    g.setColor("#FFF");
    let stepX = (w - 20) / (pts.length - 1);
    for (let i = 0; i < pts.length - 1; i++) g.drawLine(10 + i * stepX, getY(pts[i]), 10 + (i + 1) * stepX, getY(pts[i+1]));
  }
  g.flip();
}

// --- 5. MENÜS ---
function openMenu() {
  currentMenuLevel = "MAIN"; isMenuOpen = true;
  let maxHROver = settings.maxHROverride > 0 ? settings.maxHROverride : (220 - settings.age);
  E.showMenu({
    "": { "title": "-- SETUP --" },
    "Alter": { value: settings.age, min: 10, max: 99, onchange: v => { settings.age = v; saveSettings(); openMenu(); } },
    "Ruhepuls": { value: settings.restHR, min: 30, max: 120, onchange: v => { settings.restHR = v; saveSettings(); } },
    "Max Puls": { value: maxHROver, min: 100, max: 230, onchange: v => { settings.maxHROverride = v; saveSettings(); openMenu(); } },
    "ZONEN ÄNDERN": () => openZoneEditor(),
    "LETZTES TRAINING": () => { isMenuOpen = false; view = "GRAPH"; subView = 0; E.showMenu(); setUI(); render(); },
    "WOCHEN-LOG": () => showWeeklyLog(),
    "EXPORT ALS CSV": () => exportCSV(),
    "Vibration": { value: !!settings.buzzOnZone, onchange: v => { settings.buzzOnZone = v; saveSettings(); } },
    "ZURÜCK": () => handleBack()
  });
}

function showDayDetails(day) {
  selectedDay = day; currentMenuLevel = "DETAILS"; isMenuOpen = true;
  E.showMenu({
    "": { "title": day.date },
    "GRAPH ANZEIGEN": () => { isMenuOpen = false; view = "DAY_GRAPH"; E.showMenu(); setUI(); render(); },
    "Schritte": { value: "" + day.steps },
    "Puls Avg": { value: day.avg + " bpm" },
    "ZURÜCK": () => handleBack()
  });
}

function showWeeklyLog() {
  currentMenuLevel = "WEEKLY"; isMenuOpen = true;
  let log = storage.readJSON("myhealth_weekly.json", 1) || [];
  let menu = { "": { "title": "WOCHEN LOG" } };
  log.slice().reverse().forEach(e => {
    let d = e.date.split('-');
    menu[`${d[2]}.${d[1]}. | ${e.steps}`] = () => showDayDetails(e);
  });
  menu["ZURÜCK"] = () => handleBack();
  E.showMenu(menu);
}

function openZoneEditor() {
  currentMenuLevel = "ZONES"; isMenuOpen = true;
  let menu = { "": { "title": "BPM ÄNDERN" } };
  if (!settings.customZones) settings.customZones = calculatedZones.map(z => z.minBpm);
  calculatedZones.forEach((z, i) => {
    menu[z.name] = { value: settings.customZones[i], min: 40, max: 220, onchange: v => { settings.customZones[i] = v; saveSettings(); } };
  });
  menu["Reset"] = () => { settings.customZones = null; saveSettings(); openZoneEditor(); };
  menu["ZURÜCK"] = () => handleBack();
  E.showMenu(menu);
}

// --- 6. NAVIGATION & INIT ---
function handleBack() {
  if (view === "DAY_GRAPH") { view = "DASHBOARD"; showWeeklyLog(); return; }
  if (view === "GRAPH") { view = "DASHBOARD"; setUI(); render(); return; }
  if (isMenuOpen) {
    if (currentMenuLevel === "DETAILS") showWeeklyLog();
    else if (currentMenuLevel === "WEEKLY" || currentMenuLevel === "ZONES") openMenu();
    else { isMenuOpen = false; currentMenuLevel = "NONE"; E.showMenu(); setUI(); render(); }
    return;
  }
  load(); 
}

function setUI() {
  Bangle.setUI({
    mode: "custom",
    swipe: (dir) => { 
      if (view === "DASHBOARD" && !isJogging) { view = "GRAPH"; Bangle.buzz(40); render(); }
      else if (view === "GRAPH") { subView = (subView === 0) ? 1 : 0; Bangle.buzz(40); render(); }
    },
    touch: (n, e) => {
      if (view === "GRAPH" || view === "DAY_GRAPH" || isMenuOpen) return;
      if (!isJogging && e.x > (g.getWidth() - 60) && e.y < 80) { openMenu(); return; }
      if (e.y > 150) {
        isJogging = !isJogging;
        if (isJogging) { 
          startTime = Date.now(); 
          startSteps = steps; 
          activeSession = { points: [], max: 0, min: 250, ts: Date.now(), duration: 0, steps: 0 }; 
        }
        Bangle.buzz(100); Bangle.setHRMPower(1, "health"); render();
      }
    }
  });
}

setWatch(() => handleBack(), BTN1, {repeat:true, edge:"falling"});
Bangle.on('lock', locked => { isLocked = locked; render(); });
Bangle.on('HRM', h => { updateStats(h); if(!isMenuOpen) render(); });
Bangle.on('step', s => { steps = s; if(!isMenuOpen) render(); });
setInterval(() => { if (!isMenuOpen) render(); }, 1000);

Bangle.loadWidgets();
installBackgroundService();
calculateZones();
Bangle.setHRMPower(1, "init");
setUI();
render();
