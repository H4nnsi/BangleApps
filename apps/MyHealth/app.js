const storage = require("Storage");

// --- INITIALISIERUNG & SPEICHER ---
let settings = storage.readJSON("myhealth.json", 1) || {
  age: 30,
  restHR: 60
};

function saveSettings() {
  storage.writeJSON("myhealth.json", settings);
  calculateZones();
}

// --- VARIABLEN ---
let currentHR = 0;
let hrHistory = []; 
let steps = 0;
let isJogging = false;
let currentZone = 0;
let view = "DASHBOARD"; 
let isMenuOpen = false;

const ZONE_DEFS = [
  { name: "Aufwaermen", min: 0.50, color: "#00FFFF" },
  { name: "Fettverbrennung", min: 0.60, color: "#00FF00" },
  { name: "Aerob", min: 0.70, color: "#FFFF00" },
  { name: "Anaerob", min: 0.80, color: "#FF8C00" },
  { name: "Maximum", min: 0.90, color: "#FF0000" }
];

let calculatedZones = [];

function calculateZones() {
  let maxHR = 220 - settings.age;
  let reserve = maxHR - settings.restHR;
  calculatedZones = ZONE_DEFS.map((z, i) => {
    let lower = Math.round((reserve * z.min) + settings.restHR);
    let upper = (i < 4) 
      ? Math.round((reserve * ZONE_DEFS[i+1].min) + settings.restHR) - 1 
      : maxHR;
    return { name: z.name, minBpm: lower, maxBpm: upper, color: z.color };
  });
}

function updateStats(bpm) {
  if (bpm < 40) return;
  currentHR = bpm;
  let now = Date.now();
  hrHistory.push({ bpm: bpm, time: now });
  hrHistory = hrHistory.filter(h => h.time > (now - 10 * 60 * 1000));

  if (isJogging) {
    let newZone = 0;
    for (let i = calculatedZones.length - 1; i >= 0; i--) {
      if (bpm >= calculatedZones[i].minBpm) {
        newZone = i + 1;
        break;
      }
    }
    if (newZone !== currentZone && currentZone !== 0) Bangle.buzz(500);
    currentZone = newZone;
  }
}

function getAverageHR() {
  if (hrHistory.length === 0) return 0;
  let sum = hrHistory.reduce((a, b) => a + b.bpm, 0);
  return Math.round(sum / hrHistory.length);
}

// --- EINSTELLUNGEN ---

function showSettingsMenu() {
  isMenuOpen = true;
  let avg = getAverageHR();
  const menu = {
    "": { "title": "-- Setup --" },
    "< Zurueck": () => { isMenuOpen = false; E.showMenu(); view = "DASHBOARD"; render(); },
    "Alter": {
      value: settings.age,
      min: 10, max: 99,
      onchange: v => { settings.age = v; saveSettings(); }
    },
    "Ruhepuls": {
      value: settings.restHR,
      min: 30, max: 120,
      onchange: v => { settings.restHR = v; saveSettings(); }
    },
    "Setze AVG als Ruhe-HR": () => {
      if (avg > 30) {
        settings.restHR = avg;
        saveSettings();
        Bangle.buzz(200);
        E.showAlert("Ruhe-HR auf " + avg + " gesetzt").then(() => showSettingsMenu());
      }
    },
    "Zonen anzeigen": () => { isMenuOpen = false; view = "ZONES"; E.showMenu(); render(); }
  };
  E.showMenu(menu);
}

// --- RENDERING ---

function render() {
  if (isMenuOpen) return;
  const w = g.getWidth();
  const mid = w / 2;

  if (view === "ZONES") {
    g.setBgColor("#000").clear();
    g.setFont("Vector", 18).setColor("#FFF").setFontAlign(0,-1).drawString("DEINE ZONEN", mid, 10);
    
    calculatedZones.forEach((z, i) => {
      let y = 38 + (i * 26);
      g.setColor(z.color).fillRect(10, y, 35, y+20);
      g.setColor("#000").setFont("Vector", 14).setFontAlign(0,0).drawString(i+1, 23, y+11);
      g.setFont("Vector", 12).setColor("#FFF").setFontAlign(-1,-1);
      g.drawString(z.minBpm + "-" + z.maxBpm + " BPM", 42, y);
      g.setFont("Vector", 10).setColor("#AAA").drawString(z.name, 42, y+12);
    });
    
    g.setFont("Vector", 10).setColor("#444").setFontAlign(0,0).drawString("KNOPF = ZURUECK", mid, 168);
    g.flip();
    return;
  }

  let bgColor = "#000";
  let textColor = "#FFF";
  let labelColor = "#AAA";

  if (isJogging && currentZone > 0) {
    bgColor = calculatedZones[currentZone - 1].color;
    textColor = "#000";
    labelColor = "#333";
  }

  g.setBgColor(bgColor).clear();
  
  // Gear Button
  g.setColor(isJogging ? "#000" : "#FFF").drawCircle(w-20, 20, 8);

  // --- SCHRITTE ANZEIGE (AKTUALISIERT) ---
  g.setFont("Vector", 14).setColor(isJogging ? textColor : "#0F0").setFontAlign(-1, -1);
  g.drawString("👟 SCHRITTE: " + steps, 15, 10);
  
  // Werte
  let avg = getAverageHR();
  g.setFont("Vector", 16).setColor(labelColor).setFontAlign(-1, -1);
  g.drawString("Aktuell:", 20, 50);
  g.setFont("Vector", 32).setColor(textColor).setFontAlign(1, -1);
  g.drawString(currentHR > 0 ? currentHR : "--", w - 20, 46);

  g.setFont("Vector", 16).setColor(labelColor).setFontAlign(-1, -1);
  g.drawString("AVG (10m):", 20, 95);
  g.setFont("Vector", 32).setColor(textColor).setFontAlign(1, -1);
  g.drawString(avg > 0 ? avg : "--", w - 20, 91);

  if (isJogging) {
    let zoneName = currentZone > 0 ? calculatedZones[currentZone-1].name : "Suche...";
    g.setFont("Vector", 16).setColor(textColor).setFontAlign(0, 0).drawString(currentZone + ". " + zoneName.toUpperCase(), mid, 135);
  }

  // Button
  g.setColor(isJogging ? "#000" : "#111").fillRect(15, 148, w - 15, 172);
  g.setColor(isJogging ? "#FFF" : "#0FF").setFont("Vector", 12).setFontAlign(0, 0);
  g.drawString(isJogging ? "STOP JOGGING" : "START JOGGING", mid, 160);

  g.flip();
}

// --- HARDWARE ---

setWatch(() => {
  if (isMenuOpen) {
    isMenuOpen = false;
    E.showMenu();
    render();
  } else if (view === "ZONES") {
    view = "DASHBOARD";
    render();
  } else {
    load(); 
  }
}, BTN, { repeat: true, edge: "falling" });

Bangle.on('touch', (n, e) => {
  if (isMenuOpen) return;
  if (view === "ZONES") { view = "DASHBOARD"; render(); return; }
  if (e.x > 130 && e.y < 50) { showSettingsMenu(); return; }
  if (e.y > 140) {
    isJogging = !isJogging;
    currentZone = 0;
    Bangle.buzz(100);
    Bangle.setHRMPower(1, "health");
    render();
  }
});

Bangle.on('HRM', h => { updateStats(h.bpm); render(); });
Bangle.on('step', s => { steps = s; render(); });

calculateZones();
Bangle.setHRMPower(1, "init");
render();
