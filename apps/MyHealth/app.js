const storage = require("Storage");

// --- SETTINGS ---
let settings = storage.readJSON("myhealth.json", 1) || {
  age: 30,
  restHR: 60,
  maxHROverride: 0,
  buzzOnZone: true
};

// --- DATA PERSISTENCE ---
let lastSession = storage.readJSON("myhealth_session.json", 1) || {
  points: [],
  max: 0,
  min: 250
};

let hrHistory = []; // Für 10min AVG
let steps = 0;
let isJogging = false;
let startTime = 0;
let currentHR = 0;
let currentZone = 0;
let view = "DASHBOARD";
let isMenuOpen = false;
let zoneAlertTime = 0;
let zoneAlertVal = 0;
let lastUpdate = 0;

function saveSettings() {
  storage.writeJSON("myhealth.json", settings);
  calculateZones();
}

const ZONE_DEFS = [
  { name: "Aufwaermen", min: 0.50, color: "#00FFFF" },
  { name: "Fettverbrennung", min: 0.60, color: "#00FF00" },
  { name: "Aerob", min: 0.70, color: "#FFFF00" },
  { name: "Anaerob", min: 0.80, color: "#FF8C00" },
  { name: "Maximum", min: 0.90, color: "#FF0000" }
];

let calculatedZones = [];

function calculateZones() {
  let maxHR = settings.maxHROverride > 0 ? settings.maxHROverride : (220 - settings.age);
  let reserve = maxHR - settings.restHR;
  calculatedZones = ZONE_DEFS.map((z, i) => {
    return { 
      name: z.name, 
      minBpm: Math.round((reserve * z.min) + settings.restHR), 
      color: z.color 
    };
  });
}

function updateStats(bpm) {
  if (bpm < 40 || bpm > 230) return;
  currentHR = bpm;
  let now = Date.now();
  
  // 10-Minuten-History für Dashboard (Begrenzt auf 60 Einträge für Performance)
  hrHistory.push(bpm);
  if (hrHistory.length > 60) hrHistory.shift();

  if (isJogging) {
    // Zone berechnen
    let newZone = 0;
    for (let i = calculatedZones.length - 1; i >= 0; i--) {
      if (bpm >= calculatedZones[i].minBpm) {
        newZone = i + 1;
        break;
      }
    }
    
    // Zonenwechsel-Logik
    if (newZone !== currentZone && currentZone !== 0) {
      if (settings.buzzOnZone) Bangle.buzz(500);
      zoneAlertTime = now;
      zoneAlertVal = newZone;
    }
    currentZone = newZone;

    // Datenpunkt für Graph alle 10 Sek (Max 200 Punkte für Speed)
    if (now - lastUpdate > 10000) {
      lastSession.points.push(bpm);
      if (lastSession.points.length > 200) lastSession.points.shift();
      lastSession.max = Math.max(lastSession.max, bpm);
      lastSession.min = Math.min(lastSession.min, bpm);
      lastUpdate = now;
      // Background save
      storage.writeJSON("myhealth_session.json", lastSession);
    }
  }
}

function getAverageHR() {
  if (hrHistory.length === 0) return 0;
  let sum = 0;
  for(let b of hrHistory) sum += b;
  return Math.round(sum / hrHistory.length);
}

// --- UI: GRAPH ---
function drawGraph() {
  g.setBgColor("#000").clear();
  const w = g.getWidth(), h = g.getHeight();
  const pts = lastSession.points;
  
  g.setFont("Vector", 16).setColor("#FFF").setFontAlign(0, -1).drawString("TRAINING", w/2, 10);
  
  if (!pts || pts.length < 2) {
    g.setFont("Vector", 14).drawString("Keine Daten vorhanden", w/2, h/2);
    g.setFont("Vector", 10).setColor("#888").drawString("Starte ein Training!", w/2, h/2 + 20);
    return;
  }

  let min = lastSession.min - 5, max = lastSession.max + 5;
  let range = max - min;
  let stepX = (w - 30) / (pts.length - 1);

  for (let i = 0; i < pts.length - 1; i++) {
    let x1 = 15 + i * stepX, x2 = 15 + (i + 1) * stepX;
    let y1 = (h - 50) - ((pts[i] - min) / range) * (h - 90);
    let y2 = (h - 50) - ((pts[i+1] - min) / range) * (h - 90);
    
    let pCol = "#FFF";
    for(let zi=calculatedZones.length-1; zi>=0; zi--) {
      if (pts[i] >= calculatedZones[zi].minBpm) { pCol = calculatedZones[zi].color; break; }
    }
    g.setColor(pCol).drawLine(x1, y1, x2, y2);
  }
  
  g.setFont("Vector", 12).setColor("#AAA").setFontAlign(0, 1);
  g.drawString("Min: " + lastSession.min + "  |  Max: " + lastSession.max, w/2, h-15);
}

// --- SETUP MENÜ ---
function showSettingsMenu() {
  isMenuOpen = true;
  const main = {
    "": { "title": "-- SETUP --" },
    "Alter": { value: settings.age, min: 10, max: 99, onchange: v => { settings.age = v; saveSettings(); } },
    "Ruhepuls": { value: settings.restHR, min: 30, max: 120, onchange: v => { settings.restHR = v; saveSettings(); } },
    "Letztes Training": () => { isMenuOpen = false; view = "GRAPH"; E.showMenu(); render(); },
    "Zonen Liste": () => { isMenuOpen = false; view = "ZONES"; E.showMenu(); render(); },
    "Vibration": { value: settings.buzzOnZone, onchange: v => { settings.buzzOnZone = v; saveSettings(); } },
    "DATEN LOESCHEN": () => {
      E.showPrompt("Wirklich loeschen?").then(confirm => {
        if (confirm) {
          lastSession = { points: [], max: 0, min: 250 };
          hrHistory = [];
          storage.delete("myhealth_session.json");
          E.showAlert("Geloescht!").then(() => showSettingsMenu());
        } else {
          showSettingsMenu();
        }
      });
    }
  };
  E.showMenu(main);
}

// --- RENDERING ---
function render() {
  if (isMenuOpen) return;
  const w = g.getWidth(), mid = w / 2, now = Date.now();

  if (view === "GRAPH") { drawGraph(); g.flip(); return; }
  if (view === "ZONES") {
    g.setBgColor("#000").clear();
    g.setFont("Vector", 18).setColor("#FFF").setFontAlign(0,-1).drawString("ZONEN", mid, 10);
    calculatedZones.forEach((z, i) => {
      let y = 40 + (i * 24);
      g.setColor(z.color).fillRect(15, y, 45, y+18);
      g.setColor("#000").setFont("Vector", 14).setFontAlign(0,0).drawString(i+1, 30, y+10);
      g.setFont("Vector", 14).setColor("#FFF").setFontAlign(-1,-1).drawString(z.minBpm + " BPM", 55, y);
    });
    g.flip(); return;
  }

  let bgColor = "#000", textColor = "#FFF", labelColor = "#888";
  if (isJogging && currentZone > 0) {
    bgColor = calculatedZones[currentZone - 1].color;
    textColor = "#000"; labelColor = "#333";
  }

  g.setBgColor(bgColor).clear();

  // Top Bar
  g.setFont("Vector", 12).setColor(isJogging ? textColor : "#0F0").setFontAlign(-1, -1).drawString("👟 " + steps, 10, 10);
  if (isJogging) {
    let diff = Math.floor((now - startTime) / 1000);
    g.setFont("Vector", 14).setColor(textColor).setFontAlign(1, -1).drawString(Math.floor(diff/60) + ":" + ("0"+(diff%60)).slice(-2), w - 10, 10);
  } else {
    // Zahnrad
    g.setColor("#FFF").drawCircle(w-15, 15, 6);
    for(let i=0; i<8; i++){
      let a = i*Math.PI/4;
      g.drawLine(w-15+Math.cos(a)*6, 15+Math.sin(a)*6, w-15+Math.cos(a)*9, 15+Math.sin(a)*9);
    }
  }

  // Dashboard Werte
  g.setFont("Vector", 14).setColor(labelColor).setFontAlign(0, -1).drawString("AKTUELL", mid, 45);
  g.setFont("Vector", 54).setColor(textColor).setFontAlign(0, -1).drawString(currentHR > 0 ? currentHR : "--", mid, 58);

  let avg = getAverageHR();
  g.setFont("Vector", 12).setColor(labelColor).setFontAlign(0, -1).drawString("AVG (10M)", mid, 115);
  g.setFont("Vector", 22).setColor(textColor).setFontAlign(0, -1).drawString(avg > 0 ? avg : "--", mid, 128);

  // Status / Alerts
  if (isJogging && (now - zoneAlertTime < 4000)) {
    g.setColor(textColor).fillRect(mid-40, 65, mid+40, 135);
    g.setColor(bgColor).setFont("Vector", 60).setFontAlign(0,0).drawString(zoneAlertVal, mid, 103);
  } else if (isJogging) {
    let zoneName = currentZone > 0 ? calculatedZones[currentZone-1].name : "SUCHE PULS...";
    g.setFont("Vector", 14).setColor(textColor).setFontAlign(0, 0).drawString(currentZone > 0 ? currentZone + ". " + zoneName.toUpperCase() : zoneName, mid, 155);
  }

  // Button
  g.setColor(isJogging ? "#000" : "#111").fillRect(25, 165, w - 25, 175);
  g.setColor(isJogging ? "#FFF" : "#0FF").setFont("Vector", 12).setFontAlign(0, 0).drawString(isJogging ? "STOP" : "START JOGGING", mid, 171);
  g.flip();
}

// --- LOGIK & HARDWARE ---
setWatch(() => {
  if (isMenuOpen) { isMenuOpen = false; E.showMenu(); render(); }
  else if (view !== "DASHBOARD") { view = "DASHBOARD"; render(); }
  else { load(); }
}, BTN, { repeat: true, edge: "falling" });

Bangle.on('touch', (n, e) => {
  if (isMenuOpen) return;
  if (view !== "DASHBOARD") { view = "DASHBOARD"; render(); return; }
  if (!isJogging && e.x > 120 && e.y < 50) { showSettingsMenu(); return; }
  if (e.y > 155) {
    isJogging = !isJogging;
    if (isJogging) {
      startTime = Date.now();
      lastSession = { points: [], max: 0, min: 250 };
      lastUpdate = 0;
    } else {
      storage.writeJSON("myhealth_session.json", lastSession);
    }
    Bangle.buzz(100);
    Bangle.setHRMPower(1, "health");
    render();
  }
});

Bangle.on('HRM', h => { updateStats(h.bpm); render(); });
Bangle.on('step', s => { steps = s; render(); });
setInterval(() => { if (isJogging) render(); }, 1000);

calculateZones();
Bangle.setHRMPower(1, "init");
render();
