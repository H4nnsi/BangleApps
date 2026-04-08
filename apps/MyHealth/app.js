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
let isMenuOpen = false, lastUpdate = 0;
let isLocked = Bangle.isLocked(); 
let currentMenuLevel = "NONE"; 
let selectedDay = null; // Merkt sich den Tag für den Rücksprung aus dem Graph

const ZONE_DEFS = [
  { name: "Z1", min: 0.50, color: "#00FFFF" },
  { name: "Z2", min: 0.60, color: "#00FF00" },
  { name: "Z3", min: 0.70, color: "#FFFF00" },
  { name: "Z4", min: 0.80, color: "#FF8C00" },
  { name: "Z5", min: 0.90, color: "#FF0000" }
];
let calculatedZones = [];

// --- 2. HINTERGRUND-SERVICE & ARCHIV ---

function checkAndArchiveDay() {
  let todayStr = new Date().toISOString().split('T')[0];
  let todayData = storage.readJSON("myhealth_today.json", 1) || { date: todayStr, sum:0, count:0, min:250, max:0, steps:0, points: [] };
  
  if (todayData.date !== todayStr) {
    if (todayData.count > 0) {
      let log = storage.readJSON("myhealth_weekly.json", 1) || [];
      log.push({
        date: todayData.date, min: todayData.min, max: todayData.max,
        avg: Math.round(todayData.sum / todayData.count),
        steps: todayData.steps, points: todayData.points || []
      });
      if (log.length > 7) log.shift();
      storage.writeJSON("myhealth_weekly.json", log);
    }
    todayData = { date: todayStr, sum:0, count:0, min:250, max:0, steps:0, points: [] };
    storage.writeJSON("myhealth_today.json", todayData);
  }
}

function installBackgroundService() {
  const bootCode = `
    Bangle.on('minute', function() {
      let now = new Date();
      if (now.getMinutes() % 10 === 0) {
        Bangle.setHRMPower(1, "myhealth_bg");
        let hrmTimeout = setTimeout(() => {
          Bangle.removeListener('HRM', hrmHandler);
          Bangle.setHRMPower(0, "myhealth_bg");
        }, 30000);
        let hrmHandler = function(h) {
          if (h && h.confidence > 60) {
            Bangle.removeListener('HRM', hrmHandler);
            clearTimeout(hrmTimeout);
            Bangle.setHRMPower(0, "myhealth_bg");
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
            todayData.sum += h.bpm; todayData.count++;
            todayData.min = Math.min(todayData.min, h.bpm);
            todayData.max = Math.max(todayData.max, h.bpm);
            if (!todayData.points) todayData.points = [];
            todayData.points.push(h.bpm);
            todayData.steps = Bangle.getStepCount ? Bangle.getStepCount() : 0;
            require("Storage").writeJSON("myhealth_today.json", todayData);
          }
        };
        Bangle.on('HRM', hrmHandler);
      }
    });
  `;
  if (storage.read("myhealth.boot.js") !== bootCode) storage.write("myhealth.boot.js", bootCode);
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

function updateStats(bpm) {
  if (bpm < 40 || bpm > 230) return;
  currentHR = bpm;
  let now = Date.now();
  hrHistory.push(bpm);
  if (hrHistory.length > 40) hrHistory.shift();

  if (isJogging) {
    let newZone = 0;
    for (let i = calculatedZones.length - 1; i >= 0; i--) {
      if (bpm >= calculatedZones[i].minBpm) { newZone = i + 1; break; }
    }
    if (newZone !== currentZone && currentZone !== 0 && (now - lastZoneChange > 30000)) {
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
      if (now - startTime > 60000) { lastSession = activeSession; storage.writeJSON("myhealth_session.json", lastSession); }
    }
  }
}

// --- 4. ZEICHEN-FUNKTIONEN ---
function drawLockIcon(x, y, color) {
  g.setColor(color);
  g.fillRect(x, y + 4, x + 10, y + 10);
  g.drawRect(x + 2, y, x + 8, y + 4);
}

function drawGear(x, y, r, bgCol) {
  g.setColor("#FFF").fillCircle(x, y, r); 
  for(let i = 0; i < 8; i++) {
    let a = i * Math.PI / 4;
    g.fillPoly([x + Math.cos(a) * (r + 4), y + Math.sin(a) * (r + 4), x + Math.cos(a - 0.3) * r, y + Math.sin(a - 0.3) * r, x + Math.cos(a + 0.3) * r, y + Math.sin(a + 0.3) * r]);
  }
  g.setColor(bgCol).fillCircle(x, y, r * 0.45); 
}

function render() {
  if (isMenuOpen) return;
  if (view === "DAY_GRAPH") { drawDayGraphUI(); g.flip(); return; }
  if (view === "GRAPH") { drawHistoryPage(); g.flip(); return; }

  const w = g.getWidth(), h = g.getHeight();
  let midX = isJogging ? (w / 2 + 12) : (w / 2);
  let bgColor = "#000", txtCol = "#FFF", labCol = "#888";
  if (isJogging && currentZone > 0) { bgColor = calculatedZones[currentZone-1].color; txtCol = "#000"; labCol = "#333"; }
  
  g.setBgColor(bgColor).clear();
  if (isLocked) drawLockIcon(5, 5, isJogging ? txtCol : "#FF0");
  g.setFont("Vector", 16).setColor(isJogging ? txtCol : "#0F0").setFontAlign(-1, -1).drawString("👟 " + steps, 25, 5);

  if (isJogging) {
    const barX = 2, barW = 18, barYStart = 35, stepH = 110 / 5;
    calculatedZones.forEach((z, i) => {
      let y = barYStart + ((4 - i) * stepH);
      g.setColor(z.color).fillRect(barX, y, barX + barW, y + stepH - 3);
      g.setColor(currentZone === i + 1 ? txtCol : labCol);
      g.setFont("Vector", currentZone === i + 1 ? 16 : 12).setFontAlign(-1, 0).drawString(z.minBpm, barX + barW + 3, y + stepH / 2);
    });
    let diff = Math.floor((Date.now() - startTime) / 1000);
    g.setFont("Vector", 16).setColor(txtCol).setFontAlign(1, -1).drawString(Math.floor(diff/60)+":"+("0"+(diff%60)).slice(-2), w-5, 5);
  }

  g.setFont("Vector", 12).setColor(labCol).setFontAlign(0, -1).drawString("PULS", midX, 42);
  g.setFont("Vector", 40).setColor(txtCol).setFontAlign(0, -1).drawString(currentHR || "--", midX, 55);

  if (!isJogging) {
    let avg = hrHistory.length ? Math.round(hrHistory.reduce((a,b)=>a+b, 0)/hrHistory.length) : "--";
    g.setFont("Vector", 14).setColor(labCol).setFontAlign(0, -1).drawString("AVG (10M)", midX, 110);
    g.setFont("Vector", 26).setColor(txtCol).setFontAlign(0, -1).drawString(avg, midX, 125);
    drawGear(w - 20, 20, 10, bgColor);
  }

  g.setColor(isJogging ? "#000" : "#111").fillRect(20, 155, w-10, 175);
  g.setColor(isJogging ? "#FFF" : "#0FF").setFont("Vector", 15).setFontAlign(0,0).drawString(isJogging?"STOP":"START JOGGING", w/2+10, 165);
  
  if (isJogging && zoneOverlay) {
    g.setColor("#000").fillRect(10, 50, w-10, 130).setColor("#FFF").drawRect(10, 50, w-10, 130);
    g.setFont("Vector", 30).setFontAlign(0, 0).setColor(calculatedZones[currentZone-1].color).drawString(zoneOverlay, w/2, 90);
  }
  g.flip();
}

// --- 5. SPEZIAL-VIEWS (GRAPHEN) ---

function drawDayGraphUI() {
  g.setBgColor("#000").clear();
  const w = g.getWidth(), h = g.getHeight();
  if (!selectedDay) return;
  const pts = selectedDay.points || [];

  g.setColor("#FFF").setFont("Vector", 12).setFontAlign(0,-1).drawString("VERLAUF: " + selectedDay.date, w/2, 5);

  if (pts.length < 2) {
    g.setFontAlign(0,0).drawString("Zu wenige Daten", w/2, h/2);
  } else {
    let minP = Math.min.apply(null, pts) - 5;
    let maxP = Math.max.apply(null, pts) + 5;
    let range = maxP - minP;
    const gT = 30, gB = h - 35, gH = gB - gT;
    const getY = (p) => gB - ((p - minP) / range) * gH;

    calculatedZones.forEach(z => {
      let y = getY(z.minBpm);
      if (y >= gT && y <= gB) { g.setColor(z.color).drawLine(10, y, w-10, y); }
    });

    g.setColor("#FFF");
    let stepX = (w - 20) / (pts.length - 1);
    for (let i = 0; i < pts.length - 1; i++) {
      g.drawLine(10 + i * stepX, getY(pts[i]), 10 + (i + 1) * stepX, getY(pts[i+1]));
    }
  }
  g.setColor("#333").fillRect(0, h-24, w, h);
  g.setFontAlign(0,0).setColor("#0FF").setFont("Vector", 12).drawString("<< BTN ZURÜCK >>", w/2, h-12);
}

function showDayGraph(day) {
  selectedDay = day;
  isMenuOpen = false;
  view = "DAY_GRAPH";
  E.showMenu(); // Menü beenden
  setUI();      // UI-Handler neu binden (wichtig!)
  render();
}

function showDayDetails(day) {
  selectedDay = day;
  currentMenuLevel = "DETAILS";
  isMenuOpen = true;
  E.showMenu({
    "": { "title": day.date },
    "GRAPH ANZEIGEN": () => showDayGraph(day),
    "Schritte": { value: "" + day.steps },
    "Puls Avg": { value: day.avg + " bpm" },
    "Puls Max": { value: day.max + " bpm" },
    "Puls Min": { value: day.min + " bpm" }
  });
}

function showWeeklyLog() {
  currentMenuLevel = "WEEKLY";
  isMenuOpen = true;
  let log = storage.readJSON("myhealth_weekly.json", 1) || [];
  let menu = { "": { "title": "WOCHEN LOG" } };
  if (log.length === 0) {
    menu["Keine Daten"] = () => {};
  } else {
    log.slice().reverse().forEach(e => {
      let d = e.date.split('-');
      let label = `${d[2]}.${d[1]}. | ${e.steps > 999 ? (e.steps/1000).toFixed(1)+"k" : e.steps}`;
      menu[label] = () => showDayDetails(e);
    });
  }
  E.showMenu(menu);
}

function openZoneEditor() {
  currentMenuLevel = "ZONES";
  isMenuOpen = true;
  let menu = { "": { "title": "BPM ÄNDERN" } };
  if (!settings.customZones) settings.customZones = calculatedZones.map(z => z.minBpm);
  calculatedZones.forEach((z, i) => {
    menu[z.name] = { value: settings.customZones[i], min: 40, max: 220, onchange: v => { settings.customZones[i] = v; saveSettings(); } };
  });
  menu["Reset"] = () => { settings.customZones = null; saveSettings(); openZoneEditor(); };
  E.showMenu(menu);
}

function openMenu() {
  currentMenuLevel = "MAIN";
  isMenuOpen = true;
  E.showMenu({
    "": { "title": "-- SETUP --" },
    "Alter": { value: settings.age, min: 10, max: 99, onchange: v => { settings.age = v; saveSettings(); } },
    "Ruhepuls": { value: settings.restHR, min: 30, max: 120, onchange: v => { settings.restHR = v; saveSettings(); } },
    "Max Puls": { value: (settings.maxHROverride > 0 ? settings.maxHROverride : (220-settings.age)), min: 100, max: 230, onchange: v => { settings.maxHROverride = v; saveSettings(); } },
    "ZONEN ÄNDERN": () => openZoneEditor(),
    "WOCHEN-LOG": () => showWeeklyLog(),
    "Letztes Training": () => { isMenuOpen=false; currentMenuLevel="NONE"; E.showMenu(); view="GRAPH"; subView=0; setUI(); render(); },
    "Vibration": { value: !!settings.buzzOnZone, onchange: v => { settings.buzzOnZone = v; saveSettings(); } },
    "LÖSCHEN": () => { E.showPrompt("Sicher?").then(c => { if(c) { storage.delete("myhealth_weekly.json"); storage.delete("myhealth_today.json"); storage.delete("myhealth_session.json"); } openMenu(); }); }
  });
}

function drawHistoryPage() {
  g.setBgColor("#000").clear();
  const w = g.getWidth(), h = g.getHeight();
  if (subView === 0) {
    let d = new Date(lastSession.ts || Date.now());
    g.setColor("#0FF").setFont("Vector", 14).setFontAlign(0,-1).drawString("TRAINING", w/2, 10);
    g.setColor("#FFF").setFont("Vector", 18).drawString(("0"+d.getDate()).slice(-2)+"."+("0"+(d.getMonth()+1)).slice(-2), w/2, 30);
    let stats = [{l: "Dauer:", v: Math.floor(lastSession.duration/60) + "m", c: "#FFF"}, {l: "Schritte:", v: lastSession.steps || "0", c: "#0F0"}, {l: "Max HR:", v: lastSession.max, c: "#F00"}];
    stats.forEach((s, i) => { g.setFont("Vector", 18).setColor("#888").setFontAlign(-1,-1).drawString(s.l, 10, 65 + i*28); g.setColor(s.c).setFontAlign(1,-1).drawString(s.v, w-10, 65 + i*28); });
    g.setColor("#333").fillRect(0, h-24, w, h);
    g.setFont("Vector", 12).setColor("#0FF").setFontAlign(0, 0).drawString("<< WISCHEN FÜR GRAPH >>", w/2, h-12);
  } else {
    g.setColor("#FFF").setFont("Vector", 12).setFontAlign(0,-1).drawString("GRAPH", w/2, 5);
    let minP = (lastSession.min||60)-5, maxP = (lastSession.max||180)+5, range = maxP-minP;
    const gT=30, gB=h-35, gH=gB-gT;
    const getYp = (p) => gB - ((p - minP) / range) * gH;
    calculatedZones.forEach(z => { let y = getYp(z.minBpm); if (y >= gT && y <= gB) { g.setColor(z.color).drawLine(10, y, w-10, y); } });
    if (lastSession.points && lastSession.points.length > 1) {
      let stepX = (w-20) / (lastSession.points.length-1);
      g.setColor("#FFF");
      for (let i=0; i<lastSession.points.length-1; i++) g.drawLine(10+i*stepX, getYp(lastSession.points[i]), 10+(i+1)*stepX, getYp(lastSession.points[i+1]));
    }
    g.setColor("#333").fillRect(0, h-24, w, h);
    g.setFontAlign(0,0).setColor("#0FF").setFont("Vector", 12).drawString("<< ZURÜCK >>", w/2, h-12);
  }
}

// --- 6. UNIVERSAL BACK LOGIC ---

function handleBack() {
  if (view === "DAY_GRAPH") {
    view = "DASHBOARD";
    if (selectedDay) showDayDetails(selectedDay); else showWeeklyLog();
    return;
  }
  
  if (isMenuOpen) {
    if (currentMenuLevel === "MAIN") {
      isMenuOpen = false; currentMenuLevel = "NONE";
      E.showMenu(); setUI(); render();
    } else if (currentMenuLevel === "WEEKLY" || currentMenuLevel === "ZONES") {
      openMenu();
    } else if (currentMenuLevel === "DETAILS") {
      showWeeklyLog();
    }
    return;
  }

  if (view === "GRAPH") {
    view = "DASHBOARD"; setUI(); render();
    return;
  }

  load();
}

function setUI() {
  Bangle.setUI({
    mode: "custom",
    swipe: (dir) => { if (view === "GRAPH") { subView = (subView === 0) ? 1 : 0; Bangle.buzz(40); render(); } },
    btn: (n) => { handleBack(); },
    touch: (n, e) => {
      if (view === "GRAPH" || view === "DAY_GRAPH") return;
      if (!isJogging && e.x > (g.getWidth() - 60) && e.y < 60) { openMenu(); return; }
      if (e.y > 150) {
        isJogging = !isJogging;
        if (isJogging) { startTime = Date.now(); startSteps = steps; activeSession = { points: [], max: 0, min: 250, ts: Date.now(), duration: 0, steps: 0 }; }
        Bangle.buzz(100); Bangle.setHRMPower(1, "health"); render();
      }
    }
  });
}

// --- 7. START ---
Bangle.on('lock', locked => { isLocked = locked; render(); });
Bangle.on('HRM', h => { updateStats(h.bpm); if(!isMenuOpen) render(); });
Bangle.on('step', s => { steps = s; if(!isMenuOpen) render(); });
setInterval(() => { if (isJogging && !isMenuOpen) render(); }, 1000);

checkAndArchiveDay();
installBackgroundService();
calculateZones();
Bangle.setHRMPower(1, "init");
setUI();
render();
