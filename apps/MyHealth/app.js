const storage = require("Storage");

// --- SETTINGS & PERSISTENZ ---
let settings = storage.readJSON("myhealth.json", 1) || {
  age: 30,
  restHR: 60,
  maxHROverride: 0,
  buzzOnZone: true,
  alertTime: 5
};

// Trainingsdaten (Graph) laden
let lastSession = storage.readJSON("myhealth_session.json", 1) || {
  points: [], // Array von {b: bpm, t: zeitRelativ}
  duration: 0,
  max: 0,
  min: 200
};

let hrHistory = []; // Für den 10min AVG im Dashboard
let steps = 0;
let isJogging = false;
let startTime = 0;
let currentHR = 0;
let currentZone = 0;
let view = "DASHBOARD"; // DASHBOARD, ZONES, GRAPH
let isMenuOpen = false;
let zoneAlertTime = 0;
let zoneAlertVal = 0;

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
    let lower = Math.round((reserve * z.min) + settings.restHR);
    return { name: z.name, minBpm: lower, color: z.color };
  });
}

function updateStats(bpm) {
  if (bpm < 40) return;
  currentHR = bpm;
  let now = Date.now();
  hrHistory.push({ bpm: bpm, time: now });
  hrHistory = hrHistory.filter(h => h.time > (now - 10 * 60 * 1000));

  if (isJogging) {
    // Zone berechnen
    let newZone = 0;
    for (let i = calculatedZones.length - 1; i >= 0; i--) {
      if (bpm >= calculatedZones[i].minBpm) {
        newZone = i + 1;
        break;
      }
    }
    if (newZone !== currentZone && currentZone !== 0) {
      if (settings.buzzOnZone) Bangle.buzz(500);
      zoneAlertTime = now;
      zoneAlertVal = newZone;
    }
    currentZone = newZone;

    // Punkt für Graph speichern (alle 10 Sek)
    if (!lastSession.lastUpdate || now - lastSession.lastUpdate > 10000) {
      lastSession.points.push(bpm);
      lastSession.max = Math.max(lastSession.max, bpm);
      lastSession.min = Math.min(lastSession.min, bpm);
      lastSession.lastUpdate = now;
    }
  }
}

function getAverageHR() {
  if (hrHistory.length === 0) return 0;
  let sum = hrHistory.reduce((a, b) => a + b.bpm, 0);
  return Math.round(sum / hrHistory.length);
}

// --- GRAPH ZEICHNEN ---
function drawGraph() {
  g.setBgColor("#000").clear();
  const w = g.getWidth();
  const h = g.getHeight();
  const pts = lastSession.points;
  
  g.setFont("Vector", 16).setColor("#FFF").setFontAlign(0, -1).drawString("TRAININGS-VERLAUF", w/2, 5);
  
  if (pts.length < 2) {
    g.setFont("Vector", 12).drawString("Zu wenig Daten...", w/2, h/2);
    return;
  }

  let min = lastSession.min - 5;
  let max = lastSession.max + 5;
  let range = max - min;
  let stepX = (w - 20) / (pts.length - 1);

  for (let i = 0; i < pts.length - 1; i++) {
    let x1 = 10 + i * stepX;
    let y1 = (h - 40) - ((pts[i] - min) / range) * (h - 80);
    let x2 = 10 + (i + 1) * stepX;
    let y2 = (h - 40) - ((pts[i+1] - min) / range) * (h - 80);
    
    // Farbe basierend auf Puls-Zone des Punktes
    let pCol = "#FFF";
    for(let zi=calculatedZones.length-1; zi>=0; zi--) {
      if (pts[i] >= calculatedZones[zi].minBpm) { pCol = calculatedZones[zi].color; break; }
    }
    
    g.setColor(pCol).drawLine(x1, y1, x2, y2);
  }
  
  g.setFont("Vector", 10).setColor("#888").setFontAlign(-1, 1);
  g.drawString("Min: " + lastSession.min, 10, h-10);
  g.setFontAlign(1, 1).drawString("Max: " + lastSession.max, w-10, h-10);
}

// --- SETUP MENÜ ---
function showSettingsMenu() {
  isMenuOpen = true;
  E.showMenu({
    "": { "title": "-- Setup --" },
    "Alter": {
      value: settings.age, min: 10, max: 99,
      onchange: v => { settings.age = v; saveSettings(); }
    },
    "Ruhepuls": {
      value: settings.restHR, min: 30, max: 120,
      onchange: v => { settings.restHR = v; saveSettings(); }
    },
    "Letztes Training": () => { isMenuOpen = false; view = "GRAPH"; E.showMenu(); render(); },
    "Zonen Liste": () => { isMenuOpen = false; view = "ZONES"; E.showMenu(); render(); },
    "Vibration": {
      value: settings.buzzOnZone,
      onchange: v => { settings.buzzOnZone = v; saveSettings(); }
    },
    "Verlauf loeschen": () => {
      hrHistory = [];
      lastSession = { points: [], max: 0, min: 200, duration: 0 };
      storage.delete("myhealth_session.json");
      E.showAlert("Geloescht").then(() => showSettingsMenu());
    }
  });
}

// --- RENDERING ---
function render() {
  if (isMenuOpen) return;
  const w = g.getWidth();
  const mid = w / 2;
  const now = Date.now();

  if (view === "GRAPH") { drawGraph(); return; }

  if (view === "ZONES") {
    g.setBgColor("#000").clear();
    g.setFont("Vector", 18).setColor("#FFF").setFontAlign(0,-1).drawString("ZONEN", mid, 5);
    calculatedZones.forEach((z, i) => {
      let y = 30 + (i * 24);
      g.setColor(z.color).fillRect(15, y, 40, y+16);
      g.setColor("#000").setFont("Vector", 12).setFontAlign(0,0).drawString(i+1, 28, y+8);
      g.setFont("Vector", 14).setColor("#FFF").setFontAlign(-1,-1).drawString(z.minBpm + " BPM", 50, y);
    });
    return;
  }

  let bgColor = "#000", textColor = "#FFF", labelColor = "#888";
  if (isJogging && currentZone > 0) {
    bgColor = calculatedZones[currentZone - 1].color;
    textColor = "#000"; labelColor = "#444";
  }

  g.setBgColor(bgColor).clear();

  // Top Bar
  g.setFont("Vector", 12).setColor(isJogging ? textColor : "#0F0").setFontAlign(-1, -1);
  g.drawString("👟 " + steps, 10, 10);
  if (isJogging) {
    let diff = Math.floor((now - startTime) / 1000);
    g.setFont("Vector", 14).setColor(textColor).setFontAlign(1, -1);
    g.drawString(Math.floor(diff/60) + ":" + ("0"+(diff%60)).slice(-2), w - 10, 10);
  } else {
    // Gear Icon (Zahnrad)
    g.setColor("#FFF").drawCircle(w-15, 15, 6);
    for(let i=0; i<8; i++){
      let a = i*Math.PI/4;
      g.drawLine(w-15+Math.cos(a)*6, 15+Math.sin(a)*6, w-15+Math.cos(a)*9, 15+Math.sin(a)*9);
    }
  }

  // Puls Werte
  g.setFont("Vector", 14).setColor(labelColor).setFontAlign(0, -1).drawString("AKTUELL", mid, 40);
  g.setFont("Vector", 54).setColor(textColor).setFontAlign(0, -1).drawString(currentHR > 0 ? currentHR : "--", mid, 52);

  let avg = getAverageHR();
  g.setFont("Vector", 12).setColor(labelColor).setFontAlign(0, -1).drawString("AVG (10M)", mid, 110);
  g.setFont("Vector", 20).setColor(textColor).setFontAlign(0, -1).drawString(avg > 0 ? avg : "--", mid, 122);

  // Status / Alerts
  if (isJogging && (now - zoneAlertTime < settings.alertTime * 1000)) {
    g.setColor(textColor).fillRect(mid-35, 60, mid+35, 130);
    g.setColor(bgColor).setFont("Vector", 60).setFontAlign(0,0).drawString(zoneAlertVal, mid, 98);
  } else if (isJogging) {
    let zoneName = currentZone > 0 ? calculatedZones[currentZone-1].name : "SUCHE PULS...";
    g.setFont("Vector", 14).setColor(textColor).setFontAlign(0, 0).drawString(currentZone > 0 ? currentZone + ". " + zoneName.toUpperCase() : zoneName, mid, 150);
  }

  // Button
  g.setColor(isJogging ? "#000" : "#111").fillRect(20, 162, w - 20, 175);
  g.setColor(isJogging ? "#FFF" : "#0FF").setFont("Vector", 12).setFontAlign(0, 0).drawString(isJogging ? "STOP" : "START JOGGING", mid, 169);
  g.flip();
}

// --- HARDWARE ---
setWatch(() => {
  if (isMenuOpen) { isMenuOpen = false; E.showMenu(); render(); }
  else if (view !== "DASHBOARD") { view = "DASHBOARD"; render(); }
  else { 
    if (lastSession.points.length > 0) storage.writeJSON("myhealth_session.json", lastSession);
    load(); 
  }
}, BTN, { repeat: true, edge: "falling" });

Bangle.on('touch', (n, e) => {
  if (isMenuOpen) return;
  if (view !== "DASHBOARD") { view = "DASHBOARD"; render(); return; }
  if (!isJogging && e.x > 120 && e.y < 50) { showSettingsMenu(); return; }
  if (e.y > 150) {
    isJogging = !isJogging;
    if (isJogging) {
      startTime = Date.now();
      lastSession = { points: [], max: 0, min: 200, lastUpdate: 0 };
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
