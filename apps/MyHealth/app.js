const storage = require("Storage");

// --- 1. EINSTELLUNGEN & DATEN ---
let settings = storage.readJSON("myhealth.json", 1) || {
  age: 30, restHR: 60, maxHROverride: 0, buzzOnZone: true, customZones: null
};

let lastSession = storage.readJSON("myhealth_session.json", 1) || { 
  points: [], max: 0, min: 250, ts: 0, duration: 0, steps: 0 
};
let sessionHistory = storage.readJSON("myhealth_history.json", 1) || [];

let activeSession = { points: [], max: 0, min: 250, ts: 0, duration: 0, steps: 0 };
let hrHistory = [];
let steps = Bangle.getStepCount ? Bangle.getStepCount() : 0;
let isJogging = false, startTime = 0, startSteps = 0;
let currentHR = 0, currentZone = 0, view = "DASHBOARD", subView = 0;
let isMenuOpen = false, lastUpdate = 0, lastZoneChange = 0; 
let selectedDay = null; 
let selectedHistorySession = null; 
let zoneOverlay = null;
let lastValidHRTime = 0;
let minTrust = isJogging ? 60 : 80;
let blinkState = false;

const ZONE_DEFS = [
  { name: "Z1", min: 0.50, color: "#00FFFF" },
  { name: "Z2", min: 0.60, color: "#00FF00" },
  { name: "Z3", min: 0.70, color: "#FFFF00" },
  { name: "Z4", min: 0.80, color: "#FF8C00" },
  { name: "Z5", min: 0.90, color: "#FF0000" }
];
let calculatedZones = [];

// --- 2. HILFSFUNKTIONEN ---
function drawSettingsIcon(x, y) {
  g.setColor("#FFF");
  for (let i=0; i<8; i++) {
    let a = i * Math.PI/4;
    g.drawLine(x+Math.sin(a)*5, y+Math.cos(a)*5, x+Math.sin(a)*9, y+Math.cos(a)*9);
  }
  g.fillCircle(x, y, 5);
  g.setColor("#000").fillCircle(x, y, 2);
}

// VERBESSERT: Text-Viewer mit Scroll-Funktion
let textScrollY = 0;
function showTextPage(title, text) {
  textScrollY = 0; 
  const w = g.getWidth(), h = g.getHeight();
  const lines = g.wrapString(text, w - 15);
  const totalContentHeight = lines.length * 18;
  const viewHeight = h - 70; // Bereich zwischen Titel und Footer

  function draw() {
    g.setBgColor("#000").clear();
    Bangle.drawWidgets();
    
    // Fixer Titel
    g.setColor("#0FF").setFont("Vector", 16).setFontAlign(0,-1).drawString(title, w/2, 28);
    g.setColor("#444").drawLine(0, 48, w, 48);

    // Scrollbarer Text
    g.setColor("#FFF").setFont("Vector", 14).setFontAlign(-1,-1);
    lines.forEach((line, i) => {
      let y = 55 + (i * 18) - textScrollY;
      // Nur zeichnen, wenn im sichtbaren Bereich unter dem Header
      if (y > 40 && y < h - 20) {
        g.drawString(line, 10, y);
      }
    });

    // Scroll-Balken (nur wenn Text länger als Display)
    if (totalContentHeight > viewHeight) {
      let barHeight = Math.max(10, (viewHeight / totalContentHeight) * viewHeight);
      let barPos = 50 + (textScrollY / (totalContentHeight - viewHeight)) * (viewHeight - barHeight);
      g.setColor("#333").fillRect(w-3, 50, w, h-20); // Hintergrund
      g.setColor("#0FF").fillRect(w-3, barPos, w, barPos + barHeight); // Balken
    }
    
    // Footer
    g.setColor("#888").setFont("Vector", 12).setFontAlign(0, 1).drawString("Tippen für Zurück", w/2, h-2);
    g.flip();
  }

  draw();

  Bangle.setUI({
    mode: "custom",
    touch: () => { textScrollY = 0; showIntroMenu(); }, // Tippen geht zurück
    swipe: (dirLR, dirUD) => {
      if (dirUD === 1) { // Wischen nach unten -> Text nach oben
        textScrollY = Math.max(0, textScrollY - 30);
        draw();
      } else if (dirUD === -1) { // Wischen nach oben -> Text nach unten
        textScrollY = Math.min(Math.max(0, totalContentHeight - viewHeight + 10), textScrollY + 30);
        draw();
      }
    }
  });
}

// --- 3. HRM LOGIK ---
function updateStats(h) {
  let acc = Bangle.getAccel();
  let isCharging = Bangle.isCharging && Bangle.isCharging();
  let isStationary = acc.diff < 0.05 && (Math.abs(acc.z) > 0.95);
  let shouldIgnore = isCharging || isStationary || h.confidence < minTrust;

  if (shouldIgnore) return;

  lastValidHRTime = Date.now();
  currentHR = h.bpm;
  let now = Date.now();
  
  if (!isJogging) {
    hrHistory.push(h.bpm);
    if (hrHistory.length > 40) hrHistory.shift();
  }
  
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
    } else if (currentZone === 0) { 
      currentZone = newZone; 
    }
    
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

function saveSessionToHistory() {
  if (activeSession.duration < 30) return;
  lastSession = activeSession;
  storage.writeJSON("myhealth_session.json", lastSession);
  sessionHistory.unshift(Object.assign({}, activeSession));
  if (sessionHistory.length > 10) sessionHistory.pop();
  storage.writeJSON("myhealth_history.json", sessionHistory);
}

// --- 4. RENDER FUNKTIONEN ---
function render() {
  if (isMenuOpen) return;
  blinkState = !blinkState;
  
  if (view === "DAY_GRAPH") { drawDayGraphUI(); return; }
  if (view === "HISTORY_DETAIL") { drawHistoryDetailPage(); return; }
  if (view === "GRAPH") { drawHistoryPage(); return; }
  
  const w = g.getWidth(), h = g.getHeight();
  let midX = isJogging ? (w / 2 + 22) : (w / 2);
  let bgColor = "#000", txtCol = "#FFF", labCol = isJogging ? "#333" : "#888";
  
  if (isJogging && currentZone > 0) { 
    bgColor = calculatedZones[currentZone-1].color; 
    txtCol = "#000"; 
  }
  
  g.setBgColor(bgColor).clear();
  Bangle.drawWidgets();
  
  g.setFont("Vector", 16).setColor(isJogging ? txtCol : "#0F0").setFontAlign(-1, -1).drawString("S:"+steps, 5, 28);
  
  if (isJogging) {
    const listYStart = 50, stepH = 22, listW = 48;
    g.setColor("#000").fillRect(0, listYStart, listW, listYStart + (5 * stepH));
    calculatedZones.forEach((z, i) => {
      let y = listYStart + ((4 - i) * stepH);
      if (currentZone === i + 1) {
        g.setColor(blinkState ? "#FFF" : "#666").fillRect(0, y, listW, y + stepH - 1);
        g.setColor("#000");
      } else { g.setColor(z.color); }
      g.setFont("Vector", 14).setFontAlign(-1, -1).drawString(z.name, 2, y + 3);
    });
    let diff = Math.floor((Date.now() - startTime) / 1000);
    g.setFont("Vector", 16).setColor(txtCol).setFontAlign(1, -1).drawString(Math.floor(diff/60)+":"+("0"+(diff%60)).slice(-2), w-5, 28);
  } else {
    drawSettingsIcon(w - 18, 38);
  }
  
  let displayHR = (Date.now() - lastValidHRTime < 30000 && currentHR > 0) ? currentHR : "--";
  g.setFont("Vector", 14).setColor(labCol).setFontAlign(0, -1).drawString("PULS", midX, 55);
  g.setFont("Vector", 40).setColor(txtCol).setFontAlign(0, -1).drawString(displayHR, midX, 70);
  
  if (!isJogging) {    
    let avg = hrHistory.length ? Math.round(hrHistory.reduce((a,b)=>a+b, 0)/hrHistory.length) : "--";
    g.setFont("Vector", 14).setColor("#888").setFontAlign(0, -1).drawString("AVG (10M)", midX, 118);
    g.setFont("Vector", 26).setColor(txtCol).setFontAlign(0, -1).drawString(avg, midX, 132);
  }
  
  g.setColor(isJogging ? "#000" : "#222").fillRect(15, 158, w-15, 175);
  g.setColor(isJogging ? "#FFF" : "#0FF").setFont("Vector", 16).setFontAlign(0,0).drawString(isJogging?"STOP":"START", w/2, 167);
  
  if (isJogging && zoneOverlay) {
    g.setColor("#000").fillRect(10, 65, w-10, 115).setColor("#FFF").drawRect(10, 65, w-10, 115);
    g.setFont("Vector", 22).setFontAlign(0, 0).setColor(calculatedZones[currentZone-1].color).drawString(zoneOverlay, w/2, 90);
  }
  g.flip();
}

function drawGenericSession(s, title) {
  const w = g.getWidth(), h = g.getHeight();
  g.setBgColor("#000").clear();
  Bangle.drawWidgets();
  g.setColor("#0FF").setFont("Vector", 16).setFontAlign(0,-1).drawString(title, w/2, 30);

  if (subView === 0) {
    let stats = [
      {l: "Zeit:", v: Math.floor(s.duration/60) + "m " + (s.duration%60) + "s", c: "#FFF"},
      {l: "Steps:", v: s.steps || "0", c: "#0F0"},
      {l: "Max HR:", v: s.max + " bpm", c: "#F00"}
    ];
    stats.forEach((item, i) => {
      let y = 65 + i*26;
      g.setFont("Vector", 16).setColor("#888").setFontAlign(-1,-1).drawString(item.l, 10, y);
      g.setColor(item.c).setFont("Vector", 20).setFontAlign(1,-1).drawString(item.v, w-10, y);
    });
    g.setColor("#FFF").setFont("Vector", 15).setFontAlign(0, 1).drawString("Wische für Graph >", w/2, h-12);
  } else {
    if (s.points && s.points.length > 1) {
      let pts = s.points, min = s.min - 5, max = s.max + 5;
      let range = (max - min) || 1, gw = w - 30, gh = 50;
      g.setColor("#444").drawRect(15, 60, 15 + gw, 60 + gh);
      g.setColor("#F00");
      for (let i = 0; i < pts.length - 1; i++) {
        let x1 = 15 + (i * gw / (pts.length - 1)), y1 = 60 + gh - ((pts[i] - min) * gh / range);
        let x2 = 15 + ((i + 1) * gw / (pts.length - 1)), y2 = 60 + gh - ((pts[i+1] - min) * gh / range);
        g.drawLine(x1, y1, x2, y2);
      }
      g.setFont("Vector", 14).setColor("#0FF").setFontAlign(-1,-1).drawString("Min:" + s.min, 15, 115);
      g.setColor("#F00").setFontAlign(1,-1).drawString("Max:" + s.max, w-15, 115);
    }
    g.setColor("#FFF").setFont("Vector", 15).setFontAlign(0, 1).drawString("< Zurück wischen", w/2, h-12);
  }
}

function drawHistoryPage() { drawGenericSession(lastSession, "LETZTES TRAINING"); g.flip(); }
function drawHistoryDetailPage() {
  let d = new Date(selectedHistorySession.ts);
  drawGenericSession(selectedHistorySession, d.getHours() + ":" + ("0" + d.getMinutes()).slice(-2) + " UHR");
  g.flip();
}

function drawDayGraphUI() {
  g.setBgColor("#000").clear();
  const w = g.getWidth(), h = g.getHeight();
  Bangle.drawWidgets();
  if (selectedDay) {
    g.setColor("#FFF").setFont("Vector", 14).setFontAlign(0,-1).drawString(selectedDay.date, w/2, 30);
    if (selectedDay.points && selectedDay.points.length > 1) {
      let pts = selectedDay.points, min = selectedDay.min - 5, max = selectedDay.max + 5;
      let range = (max - min) || 1, gw = w - 30, gh = 50;
      g.setColor("#444").drawRect(15, 55, 15 + gw, 55 + gh);
      g.setColor("#0F0");
      for (let i = 0; i < pts.length - 1; i++) {
        let x1 = 15 + (i * gw / (pts.length - 1)), y1 = 55 + gh - ((pts[i] - min) * gh / range);
        let x2 = 15 + ((i + 1) * gw / (pts.length - 1)), y2 = 55 + gh - ((pts[i+1] - min) * gh / range);
        g.drawLine(x1, y1, x2, y2);
      }
    }
    g.setFont("Vector", 14).setColor("#AAA").setFontAlign(0, 0).drawString("Steps: " + selectedDay.steps, w/2, 130);
    g.setFont("Vector", 15).setColor("#FFF").setFontAlign(0, 1).drawString("< Zurück wischen", w/2, h-12);
  }
  g.flip();
}

// --- 5. LOGIK & MENÜS ---
function calculateZones() {
  let maxHR = (settings.maxHROverride > 0) ? settings.maxHROverride : (220 - settings.age);
  let reserve = maxHR - settings.restHR;
  calculatedZones = ZONE_DEFS.map((z, i) => {
    let bpm = Math.round((reserve * z.min) + settings.restHR);
    if (settings.customZones && settings.customZones[i]) bpm = settings.customZones[i];
    return { name: z.name, minBpm: bpm, color: z.color };
  });
}

function saveSettings() { storage.writeJSON("myhealth.json", settings); calculateZones(); }

function exportCSV() {
  E.showMessage("Export...");
  let csv = "Timestamp,BPM,Steps\n";
  let healthMod; try { healthMod = require("health"); } catch(e) {}
  if (healthMod) {
    for(let i=6; i>=0; i--) { 
      let d = new Date(Date.now() - i * 86400000);
      healthMod.readDay(d, h => {
        if (h.bpm > 0 || h.steps > 0) {
          let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h.hr, h.min).toISOString();
          csv += t + "," + (h.bpm || 0) + "," + (h.steps || 0) + "\n";
        }
      });
    }
  }
  storage.write("myhealth_full.csv", csv);
  E.showAlert("CSV gespeichert!").then(() => openMenu());
}

function showIntroMenu() {
  E.showMenu({
    "": { "title": "COACH & INFO" },
    "Herz-Zonen": () => showTextPage("DEINE ZONEN", 
      "Z1 & Z2 (Blau/Gruen):\n" +
      "Regeneration & Fettstoffwechsel. Hier baust du deine Basis auf. Perfekt fuer lange, entspannte Laeufe.\n\n" +
      "Z3 (Gelb):\n" +
      "Aerobe Fitness. Du wirst schneller und ausdauernder.\n\n" +
      "Z4 (Orange):\n" +
      "Tempo-Zone. Verbessert deine Kraft und Lungenkapazitaet. Hier wird es anstrengend.\n\n" +
      "Z5 (Rot):\n" +
      "Maximaler Effort. Nur fuer kurze Sprints!"),

    "Profi-Tipps": () => showTextPage("TRAINING", 
      "1. Die 80/20 Regel:\n" +
      "80% deines Trainings sollte in Z1/Z2 stattfinden. Nur 20% in Z4/Z5.\n\n" +
      "2. Der Sprech-Test:\n" +
      "In Z2 kannst du locker ganze Saetze sprechen. Wenn du nur noch einzelne Woerter schaffst, bist du in Z4.\n\n" +
      "3. Erholung:\n" +
      "Muskeln wachsen in der Pause, nicht beim Sport! Gib deinem Koerper Ruhetage."),

    "Setup-Hilfe": () => showTextPage("EINSTELLUNG", 
      "Warum Alter & Ruhepuls?\n\n" +
      "Diese App nutzt die Karvonen-Formel. Sie ist genauer als die Standard-Formel, da sie deinen individuellen Fitness-Zustand (Ruhepuls) einbezieht.\n\n" +
      "Tipp: Messe deinen Ruhepuls morgens direkt nach dem Aufwachen fuer das beste Ergebnis."),

    "Bedienung": () => showTextPage("STEUERUNG", 
      "START/STOP:\n" +
      "Unten auf das Display tippen.\n\n" +
      "SCROLLEN:\n" +
      "In diesen Texten hoch/runter wischen.\n\n" +
      "ZURUECK:\n" +
      "Einfach auf das Display tippen.\n\n" +
      "MENUE:\n" +
      "Oben rechts auf das Zahnrad tippen (im Dashboard)."),

    "< ZURÜCK": () => openMenu()
  });
}

function openMenu() {
  isMenuOpen = true;
  E.showMenu({
    "": { "title": "-- SETUP --" },
    "EINFÜHRUNG": () => showIntroMenu(),
    "Alter": { value: settings.age, min: 10, max: 99, onchange: v => { settings.age = v; saveSettings(); } },
    "Ruhepuls": { value: settings.restHR, min: 30, max: 120, onchange: v => { settings.restHR = v; saveSettings(); } },
    "ZONEN BPM": () => showZoneMenu(),
    "TRAININGS-LOG": () => showTrainingHistory(),
    "TAGES-LOG": () => showWeeklyLog(),
    "EXPORT CSV": () => exportCSV(),
    "ZURÜCK": () => handleBack()
  });
}

function showTrainingHistory() {
  if (sessionHistory.length === 0) { E.showAlert("Keine Daten").then(() => openMenu()); return; }
  let menu = { "": { "title": "TRAININGS" } };
  sessionHistory.forEach((s, i) => {
    let d = new Date(s.ts);
    let label = `${d.getDate()}.${d.getMonth()+1}. ${d.getHours()}:${("0"+d.getMinutes()).slice(-2)}`;
    menu[label] = () => { selectedHistorySession = s; view = "HISTORY_DETAIL"; subView = 0; isMenuOpen = false; E.showMenu(); setUI(); render(); };
  });
  menu["< ZURÜCK"] = () => openMenu();
  E.showMenu(menu);
}

function showZoneMenu() {
  let menu = { "": { "title": "ZONEN" } };
  if (!settings.customZones) settings.customZones = calculatedZones.map(z => z.minBpm);
  calculatedZones.forEach((z, i) => {
    menu[z.name] = { value: settings.customZones[i], min: 40, max: 200, onchange: v => { settings.customZones[i] = v; saveSettings(); } };
  });
  menu["RESET (AUTO)"] = () => { settings.customZones = null; saveSettings(); showZoneMenu(); };
  menu["< ZURÜCK"] = () => openMenu();
  E.showMenu(menu);
}

function showWeeklyLog() {
  E.showMessage("Lade...");
  setTimeout(() => {
    let menu = { "": { "title": "TAGE" } };
    let healthMod; try { healthMod = require("health"); } catch(e) {}
    for(let i=0; i<7; i++) {
      let d = new Date(Date.now() - i * 86400000);
      let ds = d.toISOString().split('T')[0];
      menu[ds] = () => {
        let stat = { date: ds, min: 250, max: 0, steps: 0, points: [] };
        if (healthMod) healthMod.readDay(d, h => { 
          if(h.bpm>0){ stat.min=Math.min(stat.min, h.bpm); stat.max=Math.max(stat.max, h.bpm); stat.points.push(h.bpm); } 
          if(h.steps>0) stat.steps += h.steps;
        });
        selectedDay = stat; view = "DAY_GRAPH"; isMenuOpen = false; E.showMenu(); setUI(); render();
      };
    }
    menu["ZURÜCK"] = () => openMenu();
    E.showMenu(menu);
  }, 50); 
}

function handleBack() {
  if (view !== "DASHBOARD") { view = "DASHBOARD"; subView = 0; setUI(); render(); return; }
  if (isMenuOpen) { isMenuOpen = false; E.showMenu(); setUI(); render(); return; }
  load(); 
}

function setUI() {
  Bangle.setUI({
    mode: "custom",
    swipe: (dirLR, dirUD) => { 
      if (isMenuOpen) return;
      if (view === "DASHBOARD" && dirLR === -1 && !isJogging) { view = "GRAPH"; render(); }
      else if ((view === "GRAPH" || view === "HISTORY_DETAIL") && dirLR === -1) { subView = 1; render(); }
      else if ((view === "GRAPH" || view === "HISTORY_DETAIL") && dirLR === 1) { if(subView === 1){ subView = 0; render(); } else { view = "DASHBOARD"; render(); } }
      else if (view === "DAY_GRAPH" && dirLR === 1) { view = "DASHBOARD"; render(); }
    },
    touch: (n, e) => {
      if (isMenuOpen) return;
      if (view === "DASHBOARD" && !isJogging && e.x > 120 && e.y < 80) { openMenu(); return; }
      if (view === "DASHBOARD" && e.y > 150) {
        isJogging = !isJogging;
        if (isJogging) { startTime = Date.now(); startSteps = steps; activeSession = { points: [], max: 0, min: 250, ts: Date.now(), duration: 0, steps: 0 }; }
        else { saveSessionToHistory(); }
        Bangle.buzz(100); Bangle.setHRMPower(1, "jog"); render();
      }
    }
  });
}

// --- 6. START ---
setWatch(() => handleBack(), BTN1, {repeat:true, edge:"falling"});
Bangle.on('HRM', h => updateStats(h));
Bangle.on('step', s => steps = s);
setInterval(() => { if (!isMenuOpen) render(); }, 1000);
Bangle.loadWidgets();
calculateZones();
Bangle.setHRMPower(1, "init");
setUI();
render();
