const storage = require("Storage");

// --- SETTINGS & DATA ---
let settings = storage.readJSON("myhealth.json", 1) || {
  age: 30, restHR: 60, maxHROverride: 0, buzzOnZone: true,
  customZones: null // Speichert manuelle BPM-Werte
};

let lastSession = storage.readJSON("myhealth_session.json", 1) || { 
  points: [], max: 0, min: 250, ts: 0, duration: 0, steps: 0 
};

let activeSession = { points: [], max: 0, min: 250, ts: 0, duration: 0, steps: 0 };
let hrHistory = [];
let steps = 0, isJogging = false, startTime = 0, startSteps = 0;
let currentHR = 0, currentZone = 0, view = "DASHBOARD", subView = 0;
let isMenuOpen = false, lastUpdate = 0;

const ZONE_DEFS = [
  { name: "Z1 (Aufwärmen)", min: 0.50, color: "#00FFFF" },
  { name: "Z2 (Fettverb.)", min: 0.60, color: "#00FF00" },
  { name: "Z3 (Ausdauer)", min: 0.70, color: "#FFFF00" },
  { name: "Z4 (Anaerob)", min: 0.80, color: "#FF8C00" },
  { name: "Z5 (Maximum)", min: 0.90, color: "#FF0000" }
];

let calculatedZones = [];

function calculateZones() {
  let maxHR = (settings.maxHROverride > 0) ? settings.maxHROverride : (220 - settings.age);
  let reserve = maxHR - settings.restHR;
  
  calculatedZones = ZONE_DEFS.map((z, i) => {
    let bpm = Math.round((reserve * z.min) + settings.restHR);
    // Falls manuelle Werte existieren, diese nehmen
    if (settings.customZones && settings.customZones[i]) {
      bpm = settings.customZones[i];
    }
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
    if (newZone !== currentZone && currentZone !== 0) {
      if (settings.buzzOnZone) Bangle.buzz(500);
    }
    currentZone = newZone;

    if (now - lastUpdate > 10000) {
      activeSession.points.push(bpm);
      if (activeSession.points.length > 120) activeSession.points.shift();
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

// --- ZONEN EDITOR MENÜ ---
function openZoneEditor() {
  let menu = { "": { "title": "BPM ANPASSEN", "back": () => openMenu() } };
  
  if (!settings.customZones) {
    settings.customZones = calculatedZones.map(z => z.minBpm);
  }

  calculatedZones.forEach((z, i) => {
    menu[z.name] = {
      value: settings.customZones[i],
      min: 40, max: 220,
      onchange: v => {
        settings.customZones[i] = v;
        saveSettings();
      }
    };
  });
  
  menu["Zonen Reset"] = () => {
    settings.customZones = null;
    saveSettings();
    openZoneEditor();
  };
  
  E.showMenu(menu);
}

// --- HAUPTMENÜ ---
function openMenu() {
  isMenuOpen = true;
  calculateZones();
  E.showMenu({
    "": { "title": "-- SETUP --", "back": () => { isMenuOpen=false; E.showMenu(); setUI(); render(); }},
    "Alter": { value: settings.age, min: 10, max: 99, onchange: v => { settings.age = v; saveSettings(); } },
    "Ruhepuls": { value: settings.restHR, min: 30, max: 120, onchange: v => { settings.restHR = v; saveSettings(); } },
    "Max Puls": { 
      value: (settings.maxHROverride > 0 ? settings.maxHROverride : (220-settings.age)), 
      min: 100, max: 230, 
      onchange: v => { settings.maxHROverride = v; saveSettings(); } 
    },
    "Puls-Modus": { 
      value: (settings.maxHROverride > 0), 
      format: v => v ? "MANUELL" : "AUTO (220-A)",
      onchange: v => { 
        settings.maxHROverride = v ? (220 - settings.age) : 0;
        saveSettings();
      } 
    },
    "ZONEN BEARBEITEN": () => openZoneEditor(),
    "Vibration": { value: !!settings.buzzOnZone, onchange: v => { settings.buzzOnZone = v; saveSettings(); } },
    "Letztes Training": () => { isMenuOpen=false; E.showMenu(); view="GRAPH"; subView=0; setUI(); render(); },
    "DATEN LÖSCHEN": () => { E.showPrompt("Sicher?").then(c => { if(c) { storage.delete("myhealth_session.json"); lastSession={points:[]}; } openMenu(); }); }
  });
}

// --- RENDER DASHBOARD & HISTORY (wie V37) ---
function drawHistoryPage() {
  g.setBgColor("#000").clear();
  const w = g.getWidth(), h = g.getHeight();
  if (subView === 0) {
    let d = new Date(lastSession.ts || Date.now());
    g.setColor("#0FF").setFont("Vector", 14).setFontAlign(0,-1).drawString("LETZTES TRAINING", w/2, 10);
    g.setColor("#FFF").setFont("Vector", 18).drawString(("0"+d.getDate()).slice(-2)+"."+("0"+(d.getMonth()+1)).slice(-2)+"."+d.getFullYear(), w/2, 30);
    let stats = [
      {l: "Dauer:", v: Math.floor(lastSession.duration/60) + " Min", c: "#FFF"},
      {l: "Schritte:", v: lastSession.steps || "0", c: "#0F0"},
      {l: "Puls Max:", v: lastSession.max + " bpm", c: "#F00"}
    ];
    stats.forEach((s, i) => {
      g.setFont("Vector", 16).setColor("#888").setFontAlign(-1,-1).drawString(s.l, 15, 65 + i*25);
      g.setColor(s.c).setFontAlign(1,-1).drawString(s.v, w-15, 62 + i*25);
    });
    g.setColor("#333").fillRect(0, h-24, w, h);
    g.setFont("Vector", 12).setColor("#0FF").setFontAlign(0, 0).drawString("<< WISCHEN FÜR GRAPH >>", w/2, h-12);
  } else {
    g.setColor("#FFF").setFont("Vector", 12).setFontAlign(0,-1).drawString("PULSVERLAUF", w/2, 5);
    let minP = (lastSession.min||60) - 5, maxP = (lastSession.max||180) + 5, range = maxP - minP;
    const gT = 30, gB = h-35, gH = gB - gT;
    const getYp = (p) => gB - ((p - minP) / range) * gH;
    calculatedZones.forEach(z => {
      let y = getYp(z.minBpm);
      if (y >= gT && y <= gB) { g.setColor(z.color).drawLine(10, y, w-10, y); }
    });
    g.setColor("#FFF");
    if (lastSession.points.length > 1) {
      let stepX = (w-20) / (lastSession.points.length-1);
      for (let i=0; i<lastSession.points.length-1; i++) {
        g.drawLine(10+i*stepX, getYp(lastSession.points[i]), 10+(i+1)*stepX, getYp(lastSession.points[i+1]));
      }
    }
    g.setColor("#333").fillRect(0, h-24, w, h);
    g.setFontAlign(0,0).setColor("#0FF").setFont("Vector", 12).drawString("<< ZURÜCK ZU STATS >>", w/2, h-12);
  }
}

function render() {
  if (isMenuOpen) return;
  if (view === "GRAPH") { drawHistoryPage(); g.flip(); return; }
  const w = g.getWidth(), mid = w / 2 + 10, now = Date.now();
  let bgColor = "#000", txtCol = "#FFF", labCol = "#888";
  if (isJogging && currentZone > 0) { bgColor = calculatedZones[currentZone-1].color; txtCol = "#000"; labCol = "#333"; }
  g.setBgColor(bgColor).clear();
  g.setFont("Vector", 14).setColor(isJogging ? txtCol : "#0F0").setFontAlign(-1, -1).drawString("👟 " + steps, 15, 10);
  if (isJogging) {
    const barY = 35, stepH = 110/5;
    calculatedZones.forEach((z, i) => {
      let y = barY + ((4-i) * stepH);
      g.setColor(z.color);
      if (currentZone === i+1) {
        g.fillRect(5, y, 18, y + stepH - 2);
        g.setColor(txtCol).setFont("Vector", 11).setFontAlign(-1, 0).drawString(z.minBpm, 26, y + stepH/2);
      } else {
        g.drawRect(5, y, 12, y + stepH - 2);
        g.setColor(labCol).setFont("Vector", 9).setFontAlign(-1, 0).drawString(z.minBpm, 18, y + stepH/2);
      }
    });
    let diff = Math.floor((now - startTime) / 1000);
    g.setFont("Vector", 14).setColor(txtCol).setFontAlign(1,-1).drawString(Math.floor(diff/60)+":"+("0"+(diff%60)).slice(-2), w-10, 10);
  }
  g.setFont("Vector", 12).setColor(labCol).setFontAlign(0,-1).drawString("AKTUELL", mid, 38);
  g.setFont("Vector", 52).setColor(txtCol).setFontAlign(0,-1).drawString(currentHR||"--", mid, 48);
  let avg = hrHistory.length ? Math.round(hrHistory.reduce((a,b)=>a+b, 0)/hrHistory.length) : "--";
  g.setFont("Vector", 12).setColor(labCol).setFontAlign(0,-1).drawString("AVG (10M)", mid, 100);
  g.setFont("Vector", 24).setColor(txtCol).setFontAlign(0,-1).drawString(avg, mid, 115);
  g.setColor(isJogging ? "#000" : "#111").fillRect(30, 158, w-20, 175);
  g.setColor(isJogging ? "#FFF" : "#0FF").setFont("Vector", 14).setFontAlign(0,0).drawString(isJogging?"STOP":"START JOGGING", w/2+5, 167);
  if (!isJogging) g.setColor("#FFF").drawCircle(w-15, 15, 7);
  g.flip();
}

function setUI() {
  Bangle.setUI({
    mode: "custom",
    swipe: (dir) => { if (view === "GRAPH") { subView = (subView === 0) ? 1 : 0; Bangle.buzz(40); render(); } },
    touch: (n, e) => {
      if (view === "GRAPH") return;
      if (!isJogging && e.x > 120 && e.y < 50) { openMenu(); return; }
      if (e.y > 150) {
        isJogging = !isJogging;
        if (isJogging) { startTime = Date.now(); startSteps = steps; activeSession = { points: [], max: 0, min: 250, ts: Date.now(), duration: 0, steps: 0 }; }
        Bangle.buzz(100); Bangle.setHRMPower(1, "health"); render();
      }
    }
  });
}

setWatch(() => {
  if (isMenuOpen) { isMenuOpen=false; E.showMenu(); setUI(); render(); }
  else if (view === "GRAPH") { view="DASHBOARD"; setUI(); render(); }
  else { load(); }
}, BTN1, { repeat: true, edge: "falling" });

Bangle.on('HRM', h => { updateStats(h.bpm); if(!isMenuOpen) render(); });
Bangle.on('step', s => { steps = s; if(!isMenuOpen) render(); });
setInterval(() => { if (isJogging && !isMenuOpen) render(); }, 1000);

calculateZones();
Bangle.setHRMPower(1, "init");
setUI();
render();
