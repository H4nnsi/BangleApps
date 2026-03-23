const storage = require("Storage");

// --- SETTINGS ---
let settings = storage.readJSON("myhealth.json", 1) || {
  age: 30,
  restHR: 60,
  maxHROverride: 0,
  buzzOnZone: true
};

let lastSession = storage.readJSON("myhealth_session.json", 1) || { 
  points: [], max: 0, min: 250, ts: 0, duration: 0 
};
if (!lastSession.points) lastSession = { points: [], max: 0, min: 250, ts: 0, duration: 0 };

let activeSession = { points: [], max: 0, min: 250, ts: 0, duration: 0 };
let hrHistory = [];
let steps = 0, isJogging = false, startTime = 0;
let currentHR = 0, currentZone = 0, view = "DASHBOARD";
let scrollY = 0; 
let isMenuOpen = false, zoneAlertTime = 0, zoneAlertVal = 0, lastUpdate = 0;

const ZONE_DEFS = [
  { name: "Z1", min: 0.50, color: "#00FFFF" },
  { name: "Z2", min: 0.60, color: "#00FF00" },
  { name: "Z3", min: 0.70, color: "#FFFF00" },
  { name: "Z4", min: 0.80, color: "#FF8C00" },
  { name: "Z5", min: 0.90, color: "#FF0000" }
];

let calculatedZones = [];

function calculateZones() {
  let maxHR = settings.maxHROverride > 0 ? settings.maxHROverride : (220 - settings.age);
  let reserve = maxHR - settings.restHR;
  calculatedZones = ZONE_DEFS.map((z, i) => {
    return { 
      minBpm: Math.round((reserve * z.min) + settings.restHR), 
      color: z.color 
    };
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
      zoneAlertTime = now; zoneAlertVal = newZone;
    }
    currentZone = newZone;

    if (now - lastUpdate > 10000) {
      activeSession.points.push(bpm);
      if (activeSession.points.length > 150) activeSession.points.shift();
      activeSession.max = Math.max(activeSession.max, bpm);
      activeSession.min = Math.min(activeSession.min, bpm);
      activeSession.duration = Math.floor((now - startTime) / 1000);
      lastUpdate = now;

      if (now - startTime > 180000) { 
        lastSession = activeSession; 
        storage.writeJSON("myhealth_session.json", lastSession);
      }
    }
  }
}

// --- UI: SCROLLING HISTORY ---
function drawScrollingHistory() {
  g.setBgColor("#000").clear();
  const w = g.getWidth(), h = g.getHeight();
  const off = scrollY;
  
  if (!lastSession.points || lastSession.points.length < 2) {
    g.setFont("Vector", 14).setColor("#FFF").setFontAlign(0, 0).drawString("Keine Daten vorhanden\n(Mind. 3 Min joggen)", w/2, h/2);
    return;
  }

  // Seite 1: Daten
  let dateStr = "--.--.----";
  let timeStr = "--:--";
  
  // Strikte Nutzung des echten Trainings-Startzeipunkts
  if (lastSession.ts > 0) {
    let d = new Date(lastSession.ts);
    dateStr = ("0"+d.getDate()).slice(-2) + "." + ("0"+(d.getMonth()+1)).slice(-2) + "." + d.getFullYear();
    timeStr = ("0"+d.getHours()).slice(-2) + ":" + ("0"+d.getMinutes()).slice(-2);
  }
  
  let durMin = Math.floor((lastSession.duration || 0) / 60);

  g.setColor("#0FF").setFont("Vector", 16).setFontAlign(0, -1).drawString("LETZTES TRAINING", w/2, 15 - off);
  g.setColor("#FFF").setFont("Vector", 24).setFontAlign(0, 0).drawString(dateStr, w/2, 60 - off);
  g.setFont("Vector", 20).drawString(timeStr + " Uhr", w/2, 95 - off);
  g.setColor("#888").setFont("Vector", 16).drawString("Dauer: " + durMin + " Min.", w/2, 135 - off);
  
  // Der Wisch-Text wurde hier wunschgemäß entfernt!

  // Seite 2: Graph
  const gY = h;
  let minG = Math.max(40, lastSession.min - 10), maxG = lastSession.max + 10, range = maxG - minG;
  const gT = gY + 40 - off, gB = gY + h - 50 - off, gH = gB - gT;
  const getY = (bpm) => gB - ((bpm - minG) / range) * gH;

  calculatedZones.forEach((z, i) => {
    let yB = getY(z.minBpm), yT = (i < 4) ? getY(calculatedZones[i+1].minBpm) : getY(maxG + 20);
    yB = Math.min(gB, Math.max(gT, yB)); yT = Math.min(gB, Math.max(gT, yT));
    if (yB > yT) { g.setColor(z.color).fillRect(10, yT, w-10, yB); }
  });

  g.setColor("#FFF");
  let stepX = (w - 20) / (lastSession.points.length - 1);
  for (let i = 0; i < lastSession.points.length - 1; i++) {
    g.drawLine(10 + i * stepX, getY(lastSession.points[i]), 10 + (i + 1) * stepX, getY(lastSession.points[i+1]));
  }
  g.setFont("Vector", 12).setFontAlign(0, -1).drawString("PULS-VERLAUF", w/2, gY + 10 - off);
  g.setFont("Vector", 10).setFontAlign(0, 1).drawString("MIN: " + lastSession.min + " | MAX: " + lastSession.max, w/2, gY + h - 15 - off);
}

// --- DASHBOARD UI ---
function drawZoneSidebar(isJog, curZ, txtCol) {
  const barX = 5, barW = 12, barH = 110, barY = 35, stepH = barH / 5;
  for (let i = 0; i < 5; i++) {
    let zIdx = 4 - i, y = barY + (i * stepH), zone = calculatedZones[zIdx];
    g.setColor(zone.color);
    if (curZ === (zIdx + 1)) {
      g.fillRect(barX, y, barX + barW + 4, y + stepH - 2);
      g.setColor(txtCol).setFont("Vector", 10).setFontAlign(-1, 0).drawString("Z" + (zIdx + 1), barX + barW + 8, y + stepH/2);
    } else { g.drawRect(barX, y, barX + barW, y + stepH - 2); }
    g.setColor(isJog ? txtCol : "#888").setFont("Vector", 8).setFontAlign(-1, 1).drawString(zone.minBpm, barX + barW + 5, y + stepH);
  }
}

function render() {
  if (isMenuOpen) return;
  const w = g.getWidth(), mid = w / 2 + 10, now = Date.now();
  if (view === "GRAPH") { drawScrollingHistory(); g.flip(); return; }

  let bgColor = "#000", txtCol = "#FFF", labCol = "#888";
  if (isJogging && currentZone > 0) { bgColor = calculatedZones[currentZone - 1].color; txtCol = "#000"; labCol = "#333"; }
  g.setBgColor(bgColor).clear();

  // Sidebar NUR zeichnen, wenn Jogging gestartet wurde!
  if (isJogging) {
    drawZoneSidebar(isJogging, currentZone, txtCol);
  }

  g.setFont("Vector", 12).setColor(isJogging ? txtCol : "#0F0").setFontAlign(-1, -1).drawString("👟 " + steps, 30, 10);
  
  if (isJogging) {
    let diff = Math.floor((now - startTime) / 1000);
    g.setFont("Vector", 14).setColor(txtCol).setFontAlign(1, -1).drawString(Math.floor(diff/60) + ":" + ("0"+(diff%60)).slice(-2), w - 10, 10);
    if (now - zoneAlertTime < 4000) {
      g.setColor(txtCol).fillRect(mid-35, 55, mid+35, 125);
      g.setColor(bgColor).setFont("Vector", 60).setFontAlign(0,0).drawString(zoneAlertVal, mid, 93);
    }
  }

  g.setFont("Vector", 12).setColor(labCol).setFontAlign(0, -1).drawString("AKTUELL", mid, 38);
  g.setFont("Vector", 52).setColor(txtCol).setFontAlign(0, -1).drawString(currentHR > 0 ? currentHR : "--", mid, 48);
  let avg = hrHistory.length ? Math.round(hrHistory.reduce((a,b)=>a+b, 0)/hrHistory.length) : "--";
  g.setFont("Vector", 12).setColor(labCol).setFontAlign(0, -1).drawString("AVG (10M)", mid, 100);
  g.setFont("Vector", 22).setColor(txtCol).setFontAlign(0, -1).drawString(avg, mid, 112);

  g.setColor(isJogging ? "#000" : "#111").fillRect(30, 158, w - 20, 172);
  g.setColor(isJogging ? "#FFF" : "#0FF").setFont("Vector", 12).setFontAlign(0, 0).drawString(isJogging ? "STOP" : "START JOGGING", w/2 + 5, 165);
  
  if(!isJogging) g.setColor("#FFF").drawCircle(w-15, 15, 6);
  g.flip();
}

// --- INTERACTION ---
Bangle.on('drag', e => {
  if (view === "GRAPH") {
    scrollY -= e.dy;
    if (scrollY < 0) scrollY = 0;
    if (scrollY > g.getHeight()) scrollY = g.getHeight();
    render();
  }
});

function showSettingsMenu() {
  isMenuOpen = true;
  E.showMenu({
    "": { "title": "-- SETUP --" },
    "Alter": { value: settings.age, min: 10, max: 99, onchange: v => { settings.age = v; saveSettings(); } },
    "Ruhepuls": { value: settings.restHR, min: 30, max: 120, onchange: v => { settings.restHR = v; saveSettings(); } },
    "Vibration": { value: settings.buzzOnZone, onchange: v => { settings.buzzOnZone = v; saveSettings(); } },
    "Letztes Training": () => { isMenuOpen = false; view = "GRAPH"; scrollY = 0; E.showMenu(); render(); },
    "DATEN LOESCHEN": () => {
      E.showPrompt("Wirklich loeschen?").then(confirm => {
        if (confirm) {
          lastSession = { points: [], max: 0, min: 250, ts: 0, duration: 0 };
          storage.delete("myhealth_session.json");
          E.showAlert("Geloescht!").then(() => showSettingsMenu());
        } else showSettingsMenu();
      });
    },
    "<- Zurueck": () => { isMenuOpen = false; E.showMenu(); render(); }
  });
}

Bangle.on('touch', (n, e) => {
  if (isMenuOpen) return;
  if (view === "GRAPH") return;
  if (!isJogging && e.x > 120 && e.y < 50) { showSettingsMenu(); return; }
  if (e.y > 155) {
    isJogging = !isJogging;
    if (isJogging) {
      startTime = Date.now();
      activeSession = { points: [], max: 0, min: 250, ts: Date.now(), duration: 0 };
      lastUpdate = 0;
      currentZone = 0; // Zone beim Start sicherheitshalber resetten
    } else if (Date.now() - startTime > 180000) {
      lastSession = activeSession;
      storage.writeJSON("myhealth_session.json", lastSession);
    }
    Bangle.buzz(100); Bangle.setHRMPower(1, "health"); render();
  }
});

setWatch(() => {
  if (isMenuOpen) { isMenuOpen = false; E.showMenu(); render(); }
  else if (view !== "DASHBOARD") { view = "DASHBOARD"; render(); }
  else { load(); }
}, BTN, { repeat: true, edge: "falling" });

Bangle.on('HRM', h => { updateStats(h.bpm); render(); });
Bangle.on('step', s => { steps = s; render(); });
setInterval(() => { if (isJogging) render(); }, 1000);

calculateZones();
Bangle.setHRMPower(1, "init");
render();
