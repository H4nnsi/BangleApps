// --- EINSTELLUNGEN ---
const USER_AGE = 30;
const HR_REST = 60;
const HISTORY_MS = 10 * 60 * 1000; // 10 Minuten Fenster

// --- VARIABLEN ---
let currentHR = 0;
let hrHistory = []; 
let steps = 0;
let isJogging = false;
let currentZone = 0; // 0 = Keine, 1-5 = Zonen

const ZONES = [
  { name: "Aufwaermen", min: 0.50, color: "#00FFFF" }, // Cyan
  { name: "Fettverbrennung", min: 0.60, color: "#00FF00" }, // Gruen
  { name: "Aerob", min: 0.70, color: "#FFFF00" }, // Gelb
  { name: "Anaerob", min: 0.80, color: "#FF8C00" }, // Orange
  { name: "Maximum", min: 0.90, color: "#FF0000" }  // Rot
];

// --- LOGIK ---

function getTargetHR(intensity) {
  let maxHR = 220 - USER_AGE;
  let reserve = maxHR - HR_REST;
  return Math.round((reserve * intensity) + HR_REST);
}

function updateStats(bpm) {
  if (bpm < 40) return;
  currentHR = bpm;
  let now = Date.now();

  hrHistory.push({ bpm: bpm, time: now });
  hrHistory = hrHistory.filter(h => h.time > (now - HISTORY_MS));

  if (isJogging) {
    let newZone = 0;
    for (let i = ZONES.length - 1; i >= 0; i--) {
      if (bpm >= getTargetHR(ZONES[i].min)) {
        newZone = i + 1;
        break;
      }
    }
    // Vibration bei Zonenwechsel
    if (newZone !== currentZone && currentZone !== 0) {
      Bangle.buzz(500);
    }
    currentZone = newZone;
  }
}

function getAverageHR() {
  if (hrHistory.length === 0) return 0;
  let sum = hrHistory.reduce((a, b) => a + b.bpm, 0);
  return Math.round(sum / hrHistory.length);
}

Bangle.on('HRM', h => { updateStats(h.bpm); render(); });
Bangle.on('step', s => { steps = s; render(); });

// --- UI RENDERING ---

function render() {
  const w = g.getWidth();
  const mid = w / 2;
  
  // Hintergrundfarbe bestimmen
  let bgColor = "#000";
  let textColor = "#FFF";
  let labelColor = "#AAA";

  if (isJogging && currentZone > 0) {
    bgColor = ZONES[currentZone - 1].color;
    textColor = "#000"; // Schwarz auf hellen Farben besser lesbar
    labelColor = "#333";
  }

  g.setBgColor(bgColor);
  g.clear();

  // 1. SCHRITTE (Oben)
  g.setFont("Vector", 14).setColor(isJogging ? textColor : "#0F0").setFontAlign(-1, -1);
  g.drawString("👟 SCHRITTE: " + steps, 20, 10);
  g.setColor(labelColor).drawLine(10, 28, w - 10, 28);

  // 2. LISTE (Aktuell & AVG)
  let avg = getAverageHR();
  
  // Aktuell
  g.setFont("Vector", 16).setColor(labelColor).setFontAlign(-1, -1);
  g.drawString("Aktuell:", 20, 50);
  g.setFont("Vector", 28).setColor(textColor).setFontAlign(1, -1);
  g.drawString(currentHR > 0 ? currentHR : "--", w - 20, 46);

  // AVG (10 Min)
  g.setFont("Vector", 16).setColor(labelColor).setFontAlign(-1, -1);
  g.drawString("AVG (10m):", 20, 95);
  g.setFont("Vector", 28).setColor(textColor).setFontAlign(1, -1);
  g.drawString(avg > 0 ? avg : "--", w - 20, 91);

  // 3. ZONE INFO (Nur beim Joggen)
  if (isJogging) {
    let zoneName = currentZone > 0 ? ZONES[currentZone-1].name : "Suche...";
    g.setFont("Vector", 14).setColor(textColor).setFontAlign(0, 0);
    g.drawString("[" + zoneName.toUpperCase() + "]", mid, 130);
  }

  // 4. BUTTON
  g.setColor(isJogging ? "#000" : "#111").fillRect(10, 145, w - 10, 172);
  g.setColor(isJogging ? "#FFF" : "#0FF").setFont("Vector", 12).setFontAlign(0, 0);
  g.drawString(isJogging ? "STOP JOGGING" : "TAP TO START JOGGING", mid, 158);

  g.flip();
}

Bangle.on('touch', (n, e) => {
  if (e.y > 140) {
    isJogging = !isJogging;
    currentZone = 0;
    Bangle.buzz(100);
    Bangle.setHRMPower(1, "health");
  }
  render();
});

// Start
Bangle.setHRMPower(1, "init");
render();
