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
let steps = 0, isJogging = false, startTime = 0, startSteps = 0;
let currentHR = 0, currentZone = 0, view = "DASHBOARD", subView = 0;
let isMenuOpen = false, lastUpdate = 0;
let isLocked = Bangle.isLocked(); 
let lastResetDay = new Date().getDate();

// NEU: Variablen für das Zonen-Overlay
let zoneOverlay = null;     
let lastZoneChange = 0;     

const ZONE_DEFS = [
  { name: "Z1", min: 0.50, color: "#00FFFF" },
  { name: "Z2", min: 0.60, color: "#00FF00" },
  { name: "Z3", min: 0.70, color: "#FFFF00" },
  { name: "Z4", min: 0.80, color: "#FF8C00" },
  { name: "Z5", min: 0.90, color: "#FF0000" }
];
let calculatedZones = [];

// --- 2. HINTERGRUND-SERVICE (MIT 24-UHR-BACKUP) ---
function installBackgroundService() {
  const bootCode = `
    setInterval(() => {
      let now = new Date();
      if (now.getMinutes() % 10 === 0) {
        // 1. Messung durchführen
        Bangle.setHRMPower(1, "myhealth_bg");
        setTimeout(() => {
          Bangle.once('HRM', h => {
            if (h && h.confidence > 60) {
              let todayData = require("Storage").readJSON("myhealth_today.json", 1) || { sum:0, count:0, min:250, max:0, steps:0 };
              todayData.sum += h.bpm;
              todayData.count++;
              todayData.min = Math.min(todayData.min, h.bpm);
              todayData.max = Math.max(todayData.max, h.bpm);
              todayData.steps = Bangle.getStepCount ? Bangle.getStepCount() : 0;
              require("Storage").writeJSON("myhealth_today.json", todayData);
            }
            Bangle.setHRMPower(0, "myhealth_bg");
          });
        }, 15000);

        // 2. Mitternachts-Check (Wochenlog schreiben)
        if (now.getHours() === 0 && now.getMinutes() === 0) {
          let todayData = require("Storage").readJSON("myhealth_today.json", 1);
          if (todayData && todayData.count > 0) {
            let log = require("Storage").readJSON("myhealth_weekly.json", 1) || [];
            let yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
            
            log.push({
              date: yesterday,
              min: todayData.min,
              max: todayData.max,
              avg: Math.round(todayData.sum / todayData.count),
              steps: todayData.steps
            });

            if (log.length > 7) log.shift();
            require("Storage").writeJSON("myhealth_weekly.json", log);
            require("Storage").writeJSON("myhealth_today.json", { sum:0, count:0, min:250, max:0, steps:0 });
          }
        }
      }
    }, 60000);
  `;
  require("Storage").write("myhealth.boot.js", bootCode);
}
installBackgroundService();

// --- 3. LOGIK-FUNKTIONEN ---
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

function checkDailyReset() {
  let today = new Date().getDate();
  if (today !== lastResetDay) {
    steps = 0; lastResetDay = today;
    if (Bangle.setStepCount) Bangle.setStepCount(0);
    render();
  }
}
setInterval(checkDailyReset, 60000);

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

    // NEU: Zonenwechsel mit Overlay und 30s Cooldown
    if (newZone !== currentZone && currentZone !== 0 && (now - lastZoneChange > 30000)) {
      if (settings.buzzOnZone) Bangle.buzz(600);
      currentZone = newZone;
      lastZoneChange = now;
      zoneOverlay = "ZONE " + newZone;
      
      setTimeout(() => { zoneOverlay = null; render(); }, 3000);
    } else if (currentZone === 0) {
      currentZone = newZone; // Erster Start ohne Sperre
    }

    if (now - lastUpdate > 10000) {
      activeSession.points.push(bpm);
      activeSession.max = Math.max(activeSession.max, bpm);
      activeSession.min = Math.min(activeSession.min, bpm);
      activeSession.duration = Math.floor((now - startTime) / 1000);
      activeSession.steps = steps - startSteps;
      lastUpdate = now;
      if (now - startTime > 60000) { 
        lastSession = activeSession; 
        storage.writeJSON("myhealth_session.json", lastSession);
      }
    }
  }
}

// --- 4. ZEICHEN-FUNKTIONEN ---
function drawLockIcon(x, y, color) {
  g.setColor(color);
  g.fillRect(x, y + 4, x + 10, y + 10);
  g.drawRect(x + 2, y, x + 8, y + 4);
}

// NEU: Zahnrad-Zeichenfunktion
function drawGear(x, y, r, bgCol) {
  g.setColor("#FFF").fillCircle(x, y, r); 
  for(let i = 0; i < 8; i++) {
    let a = i * Math.PI / 4;
    let tipX = x + Math.cos(a) * (r + 4); 
    let tipY = y + Math.sin(a) * (r + 4);
    let baseX1 = x + Math.cos(a - 0.3) * r; 
    let baseY1 = y + Math.sin(a - 0.3) * r;
    let baseX2 = x + Math.cos(a + 0.3) * r; 
    let baseY2 = y + Math.sin(a + 0.3) * r;
    g.fillPoly([tipX, tipY, baseX1, baseY1, baseX2, baseY2]);
  }
  g.setColor(bgCol).fillCircle(x, y, r * 0.45); 
}

function render() {
  if (isMenuOpen) return;
  if (view === "GRAPH") { drawHistoryPage(); g.flip(); return; }

  const w = g.getWidth(), h = g.getHeight();
  const zoneBarWidth = 35; 
  let midX = isJogging ? (w / 2 + 12) : (w / 2);
  
  let bgColor = "#000", txtCol = "#FFF", labCol = "#888";
  if (isJogging && currentZone > 0) { 
    bgColor = calculatedZones[currentZone-1].color; 
    txtCol = "#000"; labCol = "#333"; 
  }
  
  g.setBgColor(bgColor).clear();

  if (isLocked) drawLockIcon(5, 5, isJogging ? txtCol : "#FF0");
  g.setFont("Vector", 16).setColor(isJogging ? txtCol : "#0F0").setFontAlign(-1, -1).drawString("👟 " + steps, 25, 5);

  if (isJogging) {
    const barX = 2, barW = 18, barYStart = 35, stepH = 110 / 5;
    calculatedZones.forEach((z, i) => {
      let y = barYStart + ((4 - i) * stepH);
      g.setColor(z.color).fillRect(barX, y, barX + barW, y + stepH - 3);
      g.setColor(currentZone === i + 1 ? txtCol : labCol);
      g.setFont("Vector", currentZone === i + 1 ? 16 : 12); 
      g.setFontAlign(-1, 0).drawString(z.minBpm, barX + barW + 3, y + stepH / 2);
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
  }

  g.setColor(isJogging ? "#000" : "#111").fillRect(20, 155, w-10, 175);
  g.setColor(isJogging ? "#FFF" : "#0FF").setFont("Vector", 15).setFontAlign(0,0).drawString(isJogging?"STOP":"START JOGGING", w/2+10, 165);
  
  // NEU: Zahnrad aufrufen
  if (!isJogging) drawGear(w - 20, 20, 10, bgColor);

  // NEU: Großes Zonen Overlay zeichnen
  if (isJogging && zoneOverlay) {
    g.setColor("#000").fillRect(10, 50, w-10, 130);
    g.setColor("#FFF").drawRect(10, 50, w-10, 130);
    g.setFont("Vector", 30).setFontAlign(0, 0);
    g.setColor(calculatedZones[currentZone-1].color);
    g.drawString(zoneOverlay, w/2, 90);
  }

  g.flip();
}

// --- 5. MENÜS ---
function showWeeklyLog() {
  let log = storage.readJSON("myhealth_weekly.json", 1) || [];
  let menu = { "": { "title": "WOCHEN LOG", "back": () => openMenu() } };
  
  if (log.length === 0) {
    menu["Keine Daten (Warte bis 0 Uhr)"] = () => {};
  } else {
    let sSum = 0, sMax = 0;
    log.forEach(e => {
      sSum += e.steps;
      if (e.steps > sMax) sMax = e.steps;
    });
    let sAvg = Math.round(sSum / log.length);

    menu[`Ø-Schritte: ${sAvg}`] = () => E.showAlert(`WOCHE:\nSchnitt: ${sAvg}\nBestwert: ${sMax}`).then(() => showWeeklyLog());
    menu["----------"] = () => {};

    // NEU: Angepasste Auslese-Logik für Mitternachts-Daten
    log.slice().reverse().forEach(e => {
      let d = e.date.split('-');
      let dayLabel = `${d[2]}.${d[1]}. | ${e.steps > 999 ? (e.steps/1000).toFixed(1)+"k" : e.steps}`;
      
      menu[dayLabel] = () => {
        E.showAlert(`DATUM: ${d[2]}.${d[1]}.\nSTEPS: ${e.steps}\n\nPULS:\nMin: ${e.min}\nMax: ${e.max}\nSchnitt: ${e.avg}`)
          .then(() => showWeeklyLog());
      };
    });
  }
  E.showMenu(menu);
}

function openZoneEditor() {
  let menu = { "": { "title": "BPM ÄNDERN", "back": () => openMenu() } };
  if (!settings.customZones) settings.customZones = calculatedZones.map(z => z.minBpm);
  calculatedZones.forEach((z, i) => {
    menu[z.name] = { value: settings.customZones[i], min: 40, max: 220, onchange: v => { settings.customZones[i] = v; saveSettings(); } };
  });
  menu["Reset"] = () => { settings.customZones = null; saveSettings(); openZoneEditor(); };
  E.showMenu(menu);
}

function openMenu() {
  isMenuOpen = true;
  E.showMenu({
    "": { "title": "-- SETUP --", "back": () => { isMenuOpen=false; E.showMenu(); setUI(); render(); }},
    "Alter": { value: settings.age, min: 10, max: 99, onchange: v => { settings.age = v; saveSettings(); } },
    "Ruhepuls": { value: settings.restHR, min: 30, max: 120, onchange: v => { settings.restHR = v; saveSettings(); } },
    "Max Puls": { value: (settings.maxHROverride > 0 ? settings.maxHROverride : (220-settings.age)), min: 100, max: 230, onchange: v => { settings.maxHROverride = v; saveSettings(); } },
    "ZONEN ÄNDERN": () => openZoneEditor(),
    "WOCHEN-LOG": () => showWeeklyLog(),
    "Letztes Training": () => { isMenuOpen=false; E.showMenu(); view="GRAPH"; subView=0; setUI(); render(); },
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
    stats.forEach((s, i) => {
      g.setFont("Vector", 18).setColor("#888").setFontAlign(-1,-1).drawString(s.l, 10, 65 + i*28);
      g.setColor(s.c).setFontAlign(1,-1).drawString(s.v, w-10, 65 + i*28);
    });
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

// --- 6. EVENTS & START ---
function setUI() {
  Bangle.setUI({
    mode: "custom",
    swipe: (dir) => { if (view === "GRAPH") { subView = (subView === 0) ? 1 : 0; Bangle.buzz(40); render(); } },
    // NEU: Der Button wird jetzt sauber über die UI-Engine verwaltet
    btn: (n) => {
      if (view === "GRAPH") { view = "DASHBOARD"; setUI(); render(); }
      else { load(); } // App verlassen, wenn wir auf dem Hauptscreen sind
    },
    touch: (n, e) => {
      if (view === "GRAPH") return;
      if (!isJogging && e.x > (g.getWidth() - 60) && e.y < 60) { openMenu(); return; }
      if (e.y > 150) {
        isJogging = !isJogging;
        if (isJogging) { startTime = Date.now(); startSteps = steps; activeSession = { points: [], max: 0, min: 250, ts: Date.now(), duration: 0, steps: 0 }; }
        Bangle.buzz(100); Bangle.setHRMPower(1, "health"); render();
      }
    }
  });
}

Bangle.on('lock', locked => { isLocked = locked; render(); });
Bangle.on('HRM', h => { updateStats(h.bpm); if(!isMenuOpen) render(); });
Bangle.on('step', s => { steps = s; if(!isMenuOpen) render(); });

setInterval(() => { if (isJogging && !isMenuOpen) render(); }, 1000);

calculateZones();
Bangle.setHRMPower(1, "init");
setUI();
render();
