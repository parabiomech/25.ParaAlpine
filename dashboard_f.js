// Global State
let locationData = [], accelData = [], gyroData = [];
let gpsMarkers = [];
let savedSections = [];
let activeSectionData = null;
let gpsRef = { lat: 0, lon: 0, alt: 0 };

let map, polylineGroup, mapMarker;
let isPlaying = false;
let currentIndex = 0;
let playInterval;
let processedMotionData = {};
let motionChartsInitialized = false;

// Plotly Interaction State
let activePlotClickHandler = null;
let activePlotDivId = null;

// Multi-Event Detection State
let detectedEvents = {}; // { eventName: { peaks: [...], config: {...} } }
let activeEventName = null;
let latestCycleStats = null;
let sectionEventStore = { 'full': {} };
let currentSectionId = 'full';

// DOM Elements
const els = {
    btnPlay: document.getElementById('btnPlay'),
    btnPause: document.getElementById('btnPause'),
    slider: document.getElementById('timeSlider'),
    curTime: document.getElementById('currentTime'),
    totTime: document.getElementById('totalTime'),

    // GPS Page
    infoDate: document.getElementById('infoDate'),
    infoTime: document.getElementById('infoTime'),
    infoDevice: document.getElementById('infoDevice'),
    btnMark: document.getElementById('btnMarkEvent'),
    markerList: document.getElementById('markerList'),
    selStart: document.getElementById('gpsStartMarker'),
    selEnd: document.getElementById('gpsEndMarker'),
    secName: document.getElementById('newSectionName'),
    btnSaveSec: document.getElementById('btnSaveSection'),
    secStatsTable: document.getElementById('sectionStatsTable'),

    // Motion Page
    selSection: document.getElementById('sectionSelector'),
    secDetails: document.getElementById('sectionDetails'),

    // Event Detection
    eventName: document.getElementById('eventName'),
    detectDir: document.getElementById('detectDir'),
    algoThreshold: document.getElementById('algoThreshold'),
    algoWindow: document.getElementById('algoWindow'),
    targetVar: document.getElementById('targetVar'),
    btnDetect: document.getElementById('btnDetect'),
    btnAddEvent: document.getElementById('btnAddEvent'),
    btnClear: document.getElementById('btnClear'),
    eventList: document.getElementById('eventList'),

    // Interval Analysis
    intervalStartEvent: document.getElementById('intervalStartEvent'),
    intervalIntermediateEvent: document.getElementById('intervalIntermediateEvent'),
    intervalEndEvent: document.getElementById('intervalEndEvent'),
    btnAnalyzeIntervals: document.getElementById('btnAnalyzeIntervals'),
    btnExport: document.getElementById('btnExport'),
    intervalResults: document.getElementById('intervalResults'),
    intervalSummary: document.getElementById('intervalSummary'),
    cycleStats: document.getElementById('cycleStats'),

    // Analysis Results
    resAvgPeak: document.getElementById('resAvgPeak'),
    resMaxPeak: document.getElementById('resMaxPeak'),
    resAvgTime: document.getElementById('resAvgTime'),
    resCount: document.getElementById('resEventCount'),
    resEPM: document.getElementById('resEventsPerMin'),
    resDur: document.getElementById('resDuration')
};

// ================= FILTERING FUNCTIONS (Internal) =================

function butterworthFilter(data, fs, cutoff) {
    if (!data || data.length === 0) return [];
    const sampleRate = fs || 100;
    const freq = cutoff || 6;
    const omega = 2 * Math.PI * freq / sampleRate;
    const sn = Math.sin(omega);
    const cs = Math.cos(omega);
    const alpha = sn / (2 * 0.707);
    const b0 = (1 - cs) / 2, b1 = 1 - cs, b2 = (1 - cs) / 2;
    const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
    const A1 = a1 / a0, A2 = a2 / a0, B0 = b0 / a0, B1 = b1 / a0, B2 = b2 / a0;
    const result = new Array(data.length).fill(0);
    for (let i = 2; i < data.length; i++) {
        result[i] = B0 * data[i] + B1 * data[i - 1] + B2 * data[i - 2] - A1 * result[i - 1] - A2 * result[i - 2];
    }
    return result;
}

function savitzkyGolayFilter(data) {
    if (!data || data.length < 5) return data;
    const result = [...data];
    for (let i = 2; i < data.length - 2; i++) {
        result[i] = (-3 * data[i - 2] + 12 * data[i - 1] + 17 * data[i] + 12 * data[i + 1] - 3 * data[i + 2]) / 35;
    }
    return result;
}

function processFullMotionData() {
    let fs = 100;
    if (accelData.length > 1) {
        const dur = (parseInt(accelData[accelData.length - 1].time) - parseInt(accelData[0].time)) / 1e9;
        if (dur > 0) fs = accelData.length / dur;
    }

    // Default Filter: Butterworth 6Hz + Savitzky-Golay (Fixed)
    const pipe = (raw) => {
        const floatData = raw.map(d => parseFloat(d));
        const bw = butterworthFilter(floatData, fs, 6);
        return savitzkyGolayFilter(bw);
    };

    const ax = pipe(accelData.map(d => d.x)), ay = pipe(accelData.map(d => d.y)), az = pipe(accelData.map(d => d.z));
    const gx = pipe(gyroData.map(d => d.x * 57.3)), gy = pipe(gyroData.map(d => d.y * 57.3)), gz = pipe(gyroData.map(d => d.z * 57.3));
    const am = ax.map((v, i) => Math.sqrt(v * v + ay[i] * ay[i] + az[i] * az[i]));
    const gm = gx.map((v, i) => Math.sqrt(v * v + gy[i] * gy[i] + gz[i] * gz[i]));
    processedMotionData = { acc_x: ax, acc_y: ay, acc_z: az, acc_mag: am, gyro_x: gx, gyro_y: gy, gyro_z: gz, gyro_mag: gm };
}

// ================= DATA LOADING =================

function parseCSV(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    return lines.slice(1).map(line => {
        if (!line.trim()) return null;
        const values = line.split(',');
        const obj = {};
        headers.forEach((h, i) => {
            let val = values[i] ? values[i].trim() : '';
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            obj[h] = val;
        });
        if (!obj.time && obj.timestamp) obj.time = obj.timestamp;
        if (!obj.latitude && obj.lat) obj.latitude = obj.lat;
        if (!obj.longitude && obj.lon) obj.longitude = obj.lon;
        if (!obj.longitude && obj.long) obj.longitude = obj.long;
        if (!obj.altitude && obj.alt) obj.altitude = obj.alt;
        if (!obj.altitude && obj.height) obj.altitude = obj.height;
        return obj;
    }).filter(x => x !== null);
}

document.getElementById('folderInput').addEventListener('change', async function (e) {
    const files = Array.from(e.target.files);
    let html = '<strong>Found Files:</strong><br>';
    let locationFile, accelFile, gyroFile, metadataFile;

    files.forEach(f => {
        const name = f.name.toLowerCase();
        if (name.includes('location')) locationFile = f;
        else if (name.includes('accelerometer') && !name.includes('uncalibrated')) accelFile = f;
        else if (name.includes('gyroscope') && !name.includes('uncalibrated')) gyroFile = f;
        else if (name.includes('metadata')) metadataFile = f;
        html += `✓ ${f.name}<br>`;
    });

    document.getElementById('fileList').innerHTML = html;

    if (!locationFile || !accelFile || !gyroFile) {
        alert('Missing required files (Location, Accelerometer, Gyroscope)');
        return;
    }

    locationData = parseCSV(await locationFile.text());
    accelData = parseCSV(await accelFile.text());
    gyroData = parseCSV(await gyroFile.text());

    if (metadataFile) {
        try {
            const txt = await metadataFile.text();
            const rows = txt.split('\n');
            if (rows.length >= 2) {
                const h = rows[0].split(','), v = rows[1].split(',');
                const m = {}; h.forEach((k, i) => m[k.trim()] = v[i]);
                if (m['device name']) els.infoDevice.textContent = m['device name'];
            }
        } catch (e) { }
    }

    const date = new Date(parseInt(locationData[0].time) / 1e6);
    els.infoDate.textContent = date.toLocaleDateString();
    els.infoTime.textContent = date.toLocaleTimeString();

    document.getElementById('uploadOverlay').style.display = 'none';
    document.getElementById('fileInfo').textContent = `Loaded ${locationData.length} GPS points`;

    processFullMotionData();
    initGPSPage();
    initPlaybackSystem();

    els.btnMark.onclick = addEventMarker;
    els.btnSaveSec.onclick = saveSection;
    els.selSection.onchange = (e) => loadMotionSection(e.target.value);

    els.btnDetect.onclick = runDetection;
    els.btnAddEvent.onclick = addEventType;
    els.btnClear.onclick = clearAllEvents; // Changed from clearDetection
    els.btnAnalyzeIntervals.onclick = analyzeIntervals;
    els.btnExport.onclick = exportCSV;
});

// ================= PAGE & PLAYBACK =================

function switchPage(pageId) {
    document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`btn-${pageId}`).classList.add('active');
    document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
    document.getElementById(`${pageId}Page`).classList.add('active');

    if (pageId === 'gps') {
        setTimeout(() => { map && map.invalidateSize(); }, 100);
    } else if (pageId === 'motion') {
        if (!motionChartsInitialized) {
            initMotionPage();
            motionChartsInitialized = true;
        } else {
            Object.keys(processedMotionData).forEach(k => Plotly.Plots.resize(`chart_${k}`));
        }
    }
}

function initPlaybackSystem() {
    els.slider.max = locationData.length - 1;
    els.slider.value = 0;
    const start = parseInt(locationData[0].time);
    const end = parseInt(locationData[locationData.length - 1].time);
    els.totTime.textContent = formatTime((end - start) / 1e9);
    els.btnPlay.onclick = play;
    els.btnPause.onclick = pause;
    els.slider.oninput = () => { pause(); updateIndex(parseInt(els.slider.value)); };
}

function play() {
    isPlaying = true;
    els.btnPlay.style.display = 'none';
    els.btnPause.style.display = 'block';
    playInterval = setInterval(() => {
        if (currentIndex >= locationData.length - 1) { pause(); return; }
        updateIndex(currentIndex + 1);
    }, 100);
}

function pause() {
    isPlaying = false;
    clearInterval(playInterval);
    els.btnPlay.style.display = 'block';
    els.btnPause.style.display = 'none';
}

function updateIndex(idx) {
    currentIndex = idx;
    els.slider.value = idx;
    const start = parseInt(locationData[0].time);
    const curr = parseInt(locationData[idx].time);
    els.curTime.textContent = formatTime((curr - start) / 1e9);

    if (mapMarker) mapMarker.setLatLng([locationData[idx].latitude, locationData[idx].longitude]);

    const pt = locationData[idx];
    const localPos = getLocalCoords(parseFloat(pt.latitude), parseFloat(pt.longitude), parseFloat(pt.altitude || 0));
    const marker3d = {
        x: [[localPos.x]],
        y: [[localPos.y]],
        z: [[localPos.z]]
    };
    Plotly.restyle('gps3dChart', marker3d, [1]);

    const shape = { type: 'line', x0: idx, x1: idx, y0: 0, y1: 1, yref: 'paper', line: { color: 'red', width: 1 } };
    const activePage = document.querySelector('.page.active').id;
    if (activePage === 'gpsPage') {
        Plotly.relayout('elevationChart', { shapes: [shape] });
        Plotly.relayout('speedChart', { shapes: [shape] });
    } else if (activePage === 'motionPage') {
        let mIdx = 0;
        if (activeSectionData) {
            if (parseInt(pt.time) >= activeSectionData.timeRange[0] && parseInt(pt.time) <= activeSectionData.timeRange[1]) {
                const relTime = parseInt(pt.time) - activeSectionData.timeRange[0];
                const totalSectionTime = activeSectionData.timeRange[1] - activeSectionData.timeRange[0];
                const ratio = relTime / totalSectionTime;
                const secLen = activeSectionData.data.acc_x.length;
                mIdx = Math.floor(ratio * secLen);
                const mShape = { type: 'line', x0: mIdx, x1: mIdx, y0: 0, y1: 1, yref: 'paper', line: { color: 'red', width: 1 } };
                Object.keys(processedMotionData).forEach(k => Plotly.relayout(`chart_${k}`, { shapes: [mShape] }));
            }
        } else {
            mIdx = Math.floor(idx * (accelData.length / locationData.length));
            const mShape = { type: 'line', x0: mIdx, x1: mIdx, y0: 0, y1: 1, yref: 'paper', line: { color: 'red', width: 1 } };
            Object.keys(processedMotionData).forEach(k => Plotly.relayout(`chart_${k}`, { shapes: [mShape] }));
        }
    }
}

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ================= GPS PAGE LOGIC =================

function getLocalCoords(lat, lon, alt) {
    const x = (lon - gpsRef.lon) * 111320 * Math.cos(gpsRef.lat * Math.PI / 180);
    const y = (lat - gpsRef.lat) * 110574;
    const z = alt - gpsRef.alt;
    return { x, y, z };
}

function initGPSPage() {
    if (!locationData.length) return;
    map = L.map('map').setView([locationData[0].latitude, locationData[0].longitude], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

    mapMarker = L.circleMarker([locationData[0].latitude, locationData[0].longitude], { color: 'red', radius: 6, fillOpacity: 1 }).addTo(map);

    const yEle = locationData.map(d => parseFloat(d.altitude));
    const ySpd = locationData.map(d => parseFloat(d.speed) * 3.6);

    // Calculate 95th percentile for better color scaling
    const sortedSpd = [...ySpd].sort((a, b) => a - b);
    const p95 = sortedSpd[Math.floor(sortedSpd.length * 0.95)] || 100;

    // 2D Map Coloring
    const pts = locationData;
    const stride = pts.length > 5000 ? 2 : 1;
    for (let i = 0; i < pts.length - stride; i += stride) {
        const p1 = pts[i], p2 = pts[i + stride];
        const spd = parseFloat(p1.speed) * 3.6;

        // Simple Gradient-like logic
        let color = '#3498db'; // blue (slow)
        if (spd > p95 * 0.8) color = '#e74c3c'; // red (fast)
        else if (spd > p95 * 0.4) color = '#f1c40f'; // yellow (medium)
        else if (spd > p95 * 0.2) color = '#2ecc71'; // green

        L.polyline([[p1.latitude, p1.longitude], [p2.latitude, p2.longitude]], { color: color, weight: 4 }).addTo(map);
    }

    Plotly.newPlot('elevationChart', [{ y: yEle, type: 'scatter', fill: 'tozeroy' }], { margin: { l: 30, r: 10, t: 10, b: 20 }, autosize: true });
    Plotly.newPlot('speedChart', [{ y: ySpd, type: 'scatter', fill: 'tozeroy', line: { color: '#e67e22' } }], { margin: { l: 30, r: 10, t: 10, b: 20 }, autosize: true });

    gpsRef = { lat: parseFloat(locationData[0].latitude), lon: parseFloat(locationData[0].longitude), alt: yEle[0] };
    const xRel = [], yRel = [], zRel = [];
    locationData.forEach((d, i) => {
        const res = getLocalCoords(parseFloat(d.latitude), parseFloat(d.longitude), yEle[i]);
        xRel.push(res.x); yRel.push(res.y); zRel.push(res.z);
    });

    Plotly.newPlot('gps3dChart', [{
        type: 'scatter3d', mode: 'lines', x: xRel, y: yRel, z: zRel,
        line: { width: 5, color: ySpd, colorscale: 'Jet', cmin: 0, cmax: p95 } // Use Jet and Cap
    }, {
        type: 'scatter3d', mode: 'markers', x: [xRel[0]], y: [yRel[0]], z: [zRel[0]],
        marker: { size: 6, color: 'red' }
    }], {
        margin: { t: 0, b: 0, l: 0, r: 0 }, showlegend: false,
        scene: { aspectmode: 'data', camera: { eye: { x: 1.5, y: 1.5, z: 1.5 } } }
    });

    const dur = (parseInt(locationData[locationData.length - 1].time) - parseInt(locationData[0].time)) / 1e9 / 60;
    let dist = 0, descent = 0;
    for (let i = 1; i < locationData.length; i++) {
        dist += (parseFloat(locationData[i].speed) * (parseInt(locationData[i].time) - parseInt(locationData[i - 1].time)) / 1e9);
        const dAlt = parseFloat(locationData[i].altitude) - parseFloat(locationData[i - 1].altitude);
        if (dAlt < 0) descent += Math.abs(dAlt);
    }
    document.getElementById('statDuration').textContent = dur.toFixed(1);
    document.getElementById('statDist').textContent = (dist / 1000).toFixed(2);
    document.getElementById('statAvgSpeed').textContent = (ySpd.reduce((a, b) => a + b, 0) / ySpd.length).toFixed(1);
    document.getElementById('statMaxSpeed').textContent = Math.max(...ySpd).toFixed(1);
    document.getElementById('statDescent').textContent = descent.toFixed(1);
}

function addEventMarker() {
    const pt = locationData[currentIndex];
    gpsMarkers.push({ id: gpsMarkers.length, index: currentIndex, time: pt.time, label: `Marker (${els.curTime.textContent})` });
    renderMarkerList();
}

function deleteMarker(idx) {
    gpsMarkers = gpsMarkers.filter(m => m.id !== idx);
    renderMarkerList();
}

function renderMarkerList() {
    els.markerList.innerHTML = '';
    els.selStart.innerHTML = '<option value="">Start</option>';
    els.selEnd.innerHTML = '<option value="">End</option>';
    gpsMarkers.forEach(m => {
        const div = document.createElement('div');
        div.style.display = 'flex'; div.style.justifyContent = 'space-between'; div.style.alignItems = 'center'; div.style.padding = '2px 0';
        div.innerHTML = `<span>📍 ${m.label}</span>`;
        const btnDel = document.createElement('span'); btnDel.textContent = '❌'; btnDel.style.cursor = 'pointer'; btnDel.onclick = () => deleteMarker(m.id);
        div.appendChild(btnDel);
        els.markerList.appendChild(div);
        els.selStart.appendChild(new Option(m.label, m.id));
        els.selEnd.appendChild(new Option(m.label, m.id));
    });
}

function saveSection() {
    const sId = parseInt(els.selStart.value), eId = parseInt(els.selEnd.value), name = els.secName.value || `Section ${savedSections.length + 1}`;
    const m1 = gpsMarkers.find(m => m.id === sId), m2 = gpsMarkers.find(m => m.id === eId);
    if (!m1 || !m2 || m1.index >= m2.index) { alert("Invalid Selection"); return; }

    const tStart = parseInt(m1.time), tEnd = parseInt(m2.time);
    const aStart = accelData.findIndex(d => parseInt(d.time) >= tStart);
    let aEnd = accelData.findIndex(d => parseInt(d.time) > tEnd);
    if (aEnd === -1) aEnd = accelData.length;

    const sliceObj = {};
    Object.keys(processedMotionData).forEach(k => sliceObj[k] = processedMotionData[k].slice(aStart, aEnd));

    const section = {
        id: `sec_${savedSections.length}`, name, timeRange: [tStart, tEnd], gpsRange: [m1.index, m2.index],
        motionRange: [aStart, aEnd], data: sliceObj, duration: (tEnd - tStart) / 1e9
    };
    // Initialize storage for new section
    if (!sectionEventStore[section.id]) sectionEventStore[section.id] = {};

    savedSections.push(section);
    els.selSection.appendChild(new Option(name, section.id));

    // Stats
    let secDist = 0, secDescent = 0, speeds = [];
    for (let i = m1.index + 1; i <= m2.index; i++) {
        const dTime = (parseInt(locationData[i].time) - parseInt(locationData[i - 1].time)) / 1e9;
        const spd = parseFloat(locationData[i].speed);
        speeds.push(spd * 3.6);
        secDist += spd * dTime;
        const dAlt = parseFloat(locationData[i].altitude) - parseFloat(locationData[i - 1].altitude);
        if (dAlt < 0) secDescent += Math.abs(dAlt);
    }
    const maxSpd = speeds.length ? Math.max(...speeds) : 0, avgSpd = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;

    if (savedSections.length === 1) els.secStatsTable.innerHTML = '';
    const row = document.createElement('tr');
    row.innerHTML = `<td>${name}</td><td>${section.duration.toFixed(1)}</td><td>${secDist.toFixed(1)}</td><td>${avgSpd.toFixed(1)}</td><td>${maxSpd.toFixed(1)}</td><td>${secDescent.toFixed(1)}</td>`;
    els.secStatsTable.appendChild(row);
    alert(`Section "${name}" saved! Stats added.`);
}

function loadMotionSection(val) {
    // 1. Save events of current section
    sectionEventStore[currentSectionId] = detectedEvents;

    // 2. Switch context
    currentSectionId = val;

    // 3. Load events of new section
    detectedEvents = sectionEventStore[currentSectionId] || {};
    activeEventName = null;
    updateEventList();
    updateIntervalEventSelectors();
    resetAnalysisUI(); // Just reset UI, don't wipe data

    if (val === 'full') {
        activeSectionData = null; els.secDetails.textContent = `Displaying all data`;
        loadCharts(processedMotionData);
    } else {
        const sec = savedSections.find(s => s.id === val);
        activeSectionData = sec; els.secDetails.textContent = `Section: ${sec.name} | Duration: ${sec.duration.toFixed(1)}s`;
        loadCharts(sec.data);
    }
}

function loadCharts(data) {
    Object.keys(data).forEach(k => {
        Plotly.newPlot(`chart_${k}`, [{ y: data[k], type: 'scatter', mode: 'lines', line: { width: 1.5 } }], {
            margin: { l: 30, r: 10, t: 30, b: 20 }, height: 200, yaxis: { title: k }
        });
    });
}

// ================= MULTI-EVENT DETECTION =================

function runDetection() {
    const eventName = els.eventName.value.trim() || 'event_' + Object.keys(detectedEvents).length;
    const key = els.targetVar.value;
    const thresh = parseFloat(els.algoThreshold.value);
    const win = parseInt(els.algoWindow.value);
    const dir = els.detectDir.value;

    const dataObj = activeSectionData ? activeSectionData.data : processedMotionData;
    const series = dataObj[key];
    const peaks = [];

    for (let i = 0; i < series.length; i += win) {
        let maxV = -Infinity, pI = -1, minV = Infinity, mI = -1;
        for (let j = i; j < Math.min(i + win, series.length); j++) {
            if (series[j] > maxV) { maxV = series[j]; pI = j; }
            if (series[j] < minV) { minV = series[j]; mI = j; }
        }
        if ((dir === 'pos' || dir === 'abs') && maxV > thresh) peaks.push({ i: pI, v: maxV });
        if ((dir === 'neg' || dir === 'abs') && minV < -thresh) peaks.push({ i: mI, v: minV });
    }

    detectedEvents[eventName] = { peaks, config: { key, thresh, win, dir } };
    activeEventName = eventName;

    updateEventList();
    updateIntervalEventSelectors();
    visualizeDetection(eventName);

    const sessDur = activeSectionData ? activeSectionData.duration : (locationData.length > 0 ? (parseInt(locationData[locationData.length - 1].time) - parseInt(locationData[0].time)) / 1e9 : 1);
    calculateStats(peaks, sessDur);
}

function addEventType() {
    const eventName = els.eventName.value.trim();
    if (!eventName || detectedEvents[eventName]) return alert('Invalid or existing name');
    detectedEvents[eventName] = { peaks: [], config: { key: els.targetVar.value } };
    updateEventList(); updateIntervalEventSelectors();
}

function visualizeDetection(eventName) {
    const event = detectedEvents[eventName]; if (!event) return;
    const key = event.config.key;
    const dataObj = activeSectionData ? activeSectionData.data : processedMotionData;
    const series = dataObj[key];
    const divId = `chart_${key}`;
    const plotDiv = document.getElementById(divId);

    // Clean up previous handler to prevent duplicates
    if (activePlotDivId && activePlotClickHandler) {
        const oldDiv = document.getElementById(activePlotDivId);
        if (oldDiv && oldDiv.removeListener) {
            oldDiv.removeListener('plotly_click', activePlotClickHandler);
        }
    }

    Plotly.react(divId, [
        { y: series, type: 'scatter', mode: 'lines', name: 'Signal' },
        {
            x: event.peaks.map(p => p.i),
            y: event.peaks.map(p => p.v),
            type: 'scatter',
            mode: 'markers',
            marker: { color: 'red', size: 10, line: { color: 'white', width: 1 } },
            name: eventName,
            hoverinfo: 'x+y'
        }
    ], {
        margin: { l: 30, r: 10, t: 30, b: 20 },
        height: 200,
        yaxis: { title: key },
        showlegend: false,
        hovermode: 'closest'
    });

    // Define new click handler for Add/Remove
    const handler = function (data) {
        if (!data || !data.points || data.points.length === 0) return;
        const pt = data.points[0];

        // Curve 1: Marker Trace -> Remove
        if (pt.curveNumber === 1) {
            const clickIdx = pt.x;
            if (confirm(`Remove event marker at index ${clickIdx}?`)) {
                event.peaks = event.peaks.filter(p => p.i !== clickIdx);
                refresh();
            }
        }
        // Curve 0: Signal Trace -> Add
        else if (pt.curveNumber === 0) {
            const clickIdx = Math.round(pt.x);
            const clickVal = series[clickIdx];
            if (confirm(`Add event marker at index ${clickIdx}?`)) {
                // Insert maintaining sort order
                event.peaks.push({ i: clickIdx, v: clickVal });
                event.peaks.sort((a, b) => a.i - b.i);
                refresh();
            }
        }
    };

    function refresh() {
        visualizeDetection(eventName);
        const sessDur = activeSectionData ? activeSectionData.duration : (locationData.length > 0 ? (parseInt(locationData[locationData.length - 1].time) - parseInt(locationData[0].time)) / 1e9 : 1);
        calculateStats(event.peaks, sessDur);
        updateEventList();
        updateIntervalEventSelectors();
    }

    plotDiv.on('plotly_click', handler);
    activePlotClickHandler = handler;
    activePlotDivId = divId;
}

function updateEventList() {
    els.eventList.innerHTML = Object.keys(detectedEvents).length ? '' : '<div style="font-size: 12px; color: #999; text-align: center;">No events detected yet</div>';
    Object.keys(detectedEvents).forEach(name => {
        const div = document.createElement('div'); div.className = `event-item ${name === activeEventName ? 'active' : ''}`;
        div.innerHTML = `<div><span class="event-badge">${name}</span><span style="font-size: 12px; color: #666;">${detectedEvents[name].peaks.length} peaks</span></div>
        <div style="display:flex;gap:8px;"><button onclick="selectEvent('${name}')" style="background:#3498db;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:11px;padding:4px 8px;">View</button><button onclick="deleteEvent('${name}')" style="background:#e74c3c;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:11px;padding:4px 8px;">Delete</button></div>`;
        els.eventList.appendChild(div);
    });
}

function selectEvent(n) { activeEventName = n; visualizeDetection(n); updateEventList(); }

function deleteEvent(n) {
    if (confirm(`Delete event group "${n}"?`)) {
        delete detectedEvents[n];
        if (activeEventName === n) {
            activeEventName = null;
            resetAnalysisUI(); // Only reset UI if we deleted the active one
        }
        updateEventList();
        updateIntervalEventSelectors();
    }
}

function clearAllEvents() {
    if (confirm("Clear ALL detected events for this section?")) {
        detectedEvents = {};
        resetAnalysisUI();
        updateEventList();
        updateIntervalEventSelectors();
    }
}

function resetAnalysisUI() {
    activeEventName = null;
    els.intervalResults.style.display = 'none';
    const dataObj = activeSectionData ? activeSectionData.data : processedMotionData;
    loadCharts(dataObj);
    [els.resAvgPeak, els.resMaxPeak, els.resAvgTime, els.resCount, els.resEPM].forEach(e => e.textContent = '-');
}

function updateIntervalEventSelectors() {
    els.intervalStartEvent.innerHTML = '<option value="">Select Event</option>';
    els.intervalIntermediateEvent.innerHTML = '<option value="">None (Direct Cycle)</option>';
    els.intervalEndEvent.innerHTML = '<option value="">Select Event</option>';
    Object.keys(detectedEvents).forEach(name => {
        els.intervalStartEvent.appendChild(new Option(name, name));
        els.intervalIntermediateEvent.appendChild(new Option(name, name));
        els.intervalEndEvent.appendChild(new Option(name, name));
    });
}

function calculateStats(peaks, totalDuration) {
    if (!peaks.length) {
        [els.resAvgPeak, els.resMaxPeak, els.resAvgTime, els.resCount, els.resEPM].forEach(e => e.textContent = '-');
        return;
    }
    const absPeaks = peaks.map(p => Math.abs(p.v));
    const totalSamples = activeSectionData ? activeSectionData.motionRange[1] - activeSectionData.motionRange[0] : accelData.length;
    let dt = totalDuration / totalSamples;
    if (!dt || isNaN(dt)) dt = 0.01;

    let intervals = [];
    peaks.sort((a, b) => a.i - b.i);
    for (let i = 1; i < peaks.length; i++) intervals.push((peaks[i].i - peaks[i - 1].i) * dt);

    els.resAvgPeak.textContent = (absPeaks.reduce((a, b) => a + b, 0) / peaks.length).toFixed(2);
    els.resMaxPeak.textContent = Math.max(...absPeaks).toFixed(2);
    els.resAvgTime.textContent = intervals.length ? (intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(3) : '-';
    els.resCount.textContent = peaks.length;
    els.resEPM.textContent = ((peaks.length / totalDuration) * 60).toFixed(1);
    els.resDur.textContent = totalDuration.toFixed(1);
}

function clearDetection() {
    // This function is refactored to clearAllEvents for full data wipe,
    // and resetAnalysisUI for UI/chart reset without clearing event data.
    // The instruction implies this function should be removed or aliased.
    // For safety and to avoid breaking existing calls, it's aliased to clearAllEvents
    // if it's meant to clear all data, or resetAnalysisUI if it's meant for UI only.
    // Given the instruction "Refactor clearDetection to resetAnalysisUI (clears charts/stats/active selection but NOT data)",
    // and "Create clearAllEvents for the main Clear button (with confirmation)",
    // it seems clearDetection should now be clearAllEvents if it's the "clear all" button handler.
    // However, the provided snippet for clearDetection *was* clearing detectedEvents.
    // So, `clearDetection` is now `clearAllEvents` in functionality.
    clearAllEvents();
}

function initMotionPage() { loadCharts(processedMotionData); }


// ================= EXTENDED INTERVAL ANALYSIS =================

function analyzeIntervals() {
    const sName = els.intervalStartEvent.value;
    const mName = els.intervalIntermediateEvent.value;
    const eName = els.intervalEndEvent.value;

    if (!sName || !eName) return alert('Please select Start and End events');
    if (!detectedEvents[sName] || !detectedEvents[eName]) return alert('Events not found');

    // Keep {i, v} objects
    const sPeaks = [...detectedEvents[sName].peaks].sort((a, b) => a.i - b.i);
    const mPeaks = mName && detectedEvents[mName] ? [...detectedEvents[mName].peaks].sort((a, b) => a.i - b.i) : null;
    const ePeaks = [...detectedEvents[eName].peaks].sort((a, b) => a.i - b.i);

    const cycles = [];
    const dataObj = activeSectionData ? activeSectionData.data : processedMotionData;

    // Estimate dt
    const totalDuration = activeSectionData ? activeSectionData.duration : (locationData.length > 0 ? (parseInt(locationData[locationData.length - 1].time) - parseInt(locationData[0].time)) / 1e9 : 1);
    const totalSamples = activeSectionData ? activeSectionData.motionRange[1] - activeSectionData.motionRange[0] : accelData.length;
    let dt = totalDuration / totalSamples;
    if (!dt) dt = 0.01;

    for (let i = 0; i < sPeaks.length; i++) {
        const startNode = sPeaks[i];
        const start = startNode.i;
        let mid = -1, end = -1;
        let midVal = 0, endVal = 0;

        if (mName && mPeaks) {
            // Split Cycle: Start -> Mid -> End
            const midNode = mPeaks.find(p => p.i > start);
            if (!midNode) continue;
            mid = midNode.i;
            midVal = midNode.v;

            const endNode = ePeaks.find(p => p.i > mid);
            if (!endNode) continue;
            end = endNode.i;
            endVal = endNode.v;
        } else {
            // Direct Cycle: Start -> End
            const endNode = ePeaks.find(p => p.i > start);
            if (!endNode) continue;
            end = endNode.i;
            endVal = endNode.v;
        }

        // Distance Calculation
        const tStart = getTimeForMotionIndex(start);
        const tEnd = getTimeForMotionIndex(end);
        const gpsPoints = locationData.filter(p => parseInt(p.time) >= tStart && parseInt(p.time) <= tEnd);
        let cycleDist = 0;
        if (gpsPoints.length > 0) {
            const distSum = gpsPoints.reduce((acc, p) => acc + parseFloat(p.speed), 0);
            const avgSpd = distSum / gpsPoints.length; // m/s
            cycleDist = avgSpd * ((tEnd - tStart) / 1e9);
        }

        const sliceAcc = dataObj.acc_mag.slice(start, end + 1);
        const maxAcc = sliceAcc.length ? Math.max(...sliceAcc) : 0;
        // Not used per new requirement but kept for internal logic if needed, user wants "Max Acc in cycle"
        // User def: "최대 가속 : 주기 구간의 최대 가속도 평균" -> avg of maxAccs.

        cycles.push({
            id: i,
            start, mid, end,
            startVal: startNode.v, midVal, endVal,
            duration: (end - start) * dt,
            p1_dur: mid !== -1 ? (mid - start) * dt : 0,
            p2_dur: mid !== -1 ? (end - mid) * dt : 0,
            distance: cycleDist,
            maxAcc
        });
    }

    if (!cycles.length) return alert('No valid cycles found');
    calculateExtendedStats(cycles, totalDuration, mName);
}

function getTimeForMotionIndex(idx) {
    if (activeSectionData) {
        const secStartT = parseInt(locationData[activeSectionData.gpsRange[0]].time); // approx
        return secStartT + (idx * 10 * 1e6); // 100Hz assumed for simplicity in mapping
    } else {
        const startT = parseInt(accelData[0].time);
        return startT + (idx * 10 * 1e6);
    }
}

function calculateExtendedStats(cycles, sessionDur, mName) {
    // 1. Durations
    const durs = cycles.map(c => c.duration);
    const avgDur = durs.reduce((a, b) => a + b, 0) / durs.length;
    const minDur = Math.min(...durs);
    const maxDur = Math.max(...durs);

    // 2. SD
    const variance = durs.reduce((a, b) => a + Math.pow(b - avgDur, 2), 0) / durs.length;
    const stdDev = Math.sqrt(variance);

    // 3. Phases
    const hasPhases = (mName && cycles[0].mid !== -1);
    const p1Durs = hasPhases ? cycles.map(c => c.p1_dur) : [];
    const p2Durs = hasPhases ? cycles.map(c => c.p2_dur) : [];
    const avgP1 = hasPhases ? p1Durs.reduce((a, b) => a + b, 0) / p1Durs.length : 0;
    const avgP2 = hasPhases ? p2Durs.reduce((a, b) => a + b, 0) / p2Durs.length : 0;

    // 4. Counts & Hz
    const count = cycles.length;
    const hz = count / sessionDur;

    // 5. Distance
    const totDist = cycles.map(c => c.distance).reduce((a, b) => a + b, 0);
    const distPerEvent = totDist / count;

    // 6. Max Acc (in Cycle)
    const avgMaxAcc = cycles.map(c => c.maxAcc).reduce((a, b) => a + b, 0) / count;

    // 7. Acc/Dec at Event Points
    // Collect all relevant event values (Start, Mid, End) used in cycles
    let posVals = [];
    let negVals = [];

    cycles.forEach(c => {
        [c.startVal, c.midVal, c.endVal].forEach(v => {
            if (v === 0 && !hasPhases && c.mid === -1) return; // Skip invalid mid
            if (v > 0) posVals.push(v);
            if (v < 0) negVals.push(v);
        });
    });

    const avgAccelVal = posVals.length ? posVals.reduce((a, b) => a + b, 0) / posVals.length : 0;
    const avgDecelVal = negVals.length ? negVals.reduce((a, b) => a + b, 0) / negVals.length : 0;

    // Store for Export
    latestCycleStats = {
        avgDur, minDur, maxDur, stdDev, count, hz, distPerEvent, avgMaxAcc,
        avgP1, avgP2, avgAccelVal, avgDecelVal, hasPhases, totDist
    };

    let phasesHtml = '';
    if (hasPhases) {
        phasesHtml = `
        <div class="interval-stat" title="스타트에서 중간 이벤트까지의 평균 시간"><div class="interval-stat-val">${avgP1.toFixed(3)}s</div><div class="interval-stat-lbl">Phase 1 (초기 구간)</div></div>
        <div class="interval-stat" title="중간에서 종료 이벤트까지의 평균 시간"><div class="interval-stat-val">${avgP2.toFixed(3)}s</div><div class="interval-stat-lbl">Phase 2 (후기 구간)</div></div>
        `;
    }

    const html = `
    <div class="interval-stat" title="모든 사이클 주기의 평균 시간입니다."><div class="interval-stat-val">${avgDur.toFixed(3)}s</div><div class="interval-stat-lbl">Avg Duration (평균 주기)</div></div>
    <div class="interval-stat" title="주기의 최소시간"><div class="interval-stat-val">${minDur.toFixed(3)}s</div><div class="interval-stat-lbl">Min Duration (최소 주기)</div></div>
    <div class="interval-stat" title="주기의 최대시간"><div class="interval-stat-val">${maxDur.toFixed(3)}s</div><div class="interval-stat-lbl">Max Duration (최대 주기)</div></div>
    <div class="interval-stat" title="주기의 편차"><div class="interval-stat-val">${stdDev.toFixed(3)}</div><div class="interval-stat-lbl">SD (표준편차)</div></div>
    <div class="interval-stat" title="주기 수"><div class="interval-stat-val">${count}</div><div class="interval-stat-lbl">Total Events (총 이벤트)</div></div>
    ${phasesHtml}
    <div class="interval-stat" title="초당 주기 수"><div class="interval-stat-val">${hz.toFixed(2)} Hz</div><div class="interval-stat-lbl">Frequency (빈도)</div></div>
    <div class="interval-stat" title="주기당 이동 거리"><div class="interval-stat-val">${distPerEvent.toFixed(2)} m</div><div class="interval-stat-lbl">Dist / Event (거리)</div></div>
    <div class="interval-stat" title="주기 구간의 최대 가속도 평균"><div class="interval-stat-val">${avgMaxAcc.toFixed(2)} g</div><div class="interval-stat-lbl">Avg Max Acc (최대 가속)</div></div>
    <div class="interval-stat" title="이벤트 선정한 시점의 +값 평균"><div class="interval-stat-val" style="color:#27ae60">${avgAccelVal.toFixed(2)}</div><div class="interval-stat-lbl">Acceleration (가속)</div></div>
    <div class="interval-stat" title="이벤트 선정한 시점의 -값 평균"><div class="interval-stat-val" style="color:#e74c3c">${avgDecelVal.toFixed(2)}</div><div class="interval-stat-lbl">Deceleration (감속)</div></div>
    `;

    els.cycleStats.innerHTML = html;
    els.intervalSummary.textContent = `Analyzed ${cycles.length} cycles over ${totDist.toFixed(1)}m.`;

    displayCycleResults(cycles, mName ? true : false, avgDur);
}

function displayCycleResults(cycles, isSplit, avgValue) {
    els.intervalResults.style.display = 'block';

    let data = [];
    if (isSplit) {
        data = [
            {
                x: cycles.map((c, i) => `Cycle ${i + 1}`),
                y: cycles.map(c => c.p1_dur),
                name: 'Phase 1', type: 'bar', marker: { color: '#3498db' }
            },
            {
                x: cycles.map((c, i) => `Cycle ${i + 1}`),
                y: cycles.map(c => c.p2_dur),
                name: 'Phase 2', type: 'bar', marker: { color: '#e74c3c' }
            }
        ];
    } else {
        data = [{
            x: cycles.map((c, i) => `Cycle ${i + 1}`),
            y: cycles.map(c => c.duration),
            name: 'Duration', type: 'bar', marker: { color: '#2ecc71' }
        }];
    }

    const layout = {
        barmode: isSplit ? 'stack' : 'group',
        title: 'Cycle Durations (Vertical)',
        xaxis: { title: 'Cycle', automargin: true },
        yaxis: { title: 'Time (s)', dtick: 0.1 },
        margin: { t: 40, b: 60, r: 20, l: 60 },
        height: 350, // Fixed height for vertical chart
        shapes: []
    };

    // Add Average Line (Horizontal)
    if (avgValue) {
        layout.shapes.push({
            type: 'line',
            x0: -0.5, x1: cycles.length - 0.5,
            y0: avgValue, y1: avgValue,
            line: {
                color: 'red',
                width: 2,
                dash: 'dashdot'
            }
        });
        layout.annotations = [{
            x: cycles.length - 1,
            y: avgValue,
            xref: 'x', yref: 'y',
            text: `Avg: ${avgValue.toFixed(2)}s`,
            showarrow: false,
            yshift: 10,
            xanchor: 'right',
            font: { color: 'red', size: 12 }
        }];
    }

    Plotly.newPlot('intervalChart', data, layout);
}

function exportCSV() {
    let csv = "\uFEFF"; // BOM for Excel encoding

    // 1. Measurement Info
    csv += "=== Measurement Info ===\n";
    csv += `Date,${els.infoDate.textContent}\n`;
    csv += `Time,${els.infoTime.textContent}\n`;
    csv += `Device,${els.infoDevice.textContent}\n`;
    csv += `Total Duration,${document.getElementById('statDuration').textContent} min\n`;
    csv += `Total Distance,${document.getElementById('statDist').textContent} km\n`;
    csv += `Avg Speed,${document.getElementById('statAvgSpeed').textContent} km/h\n`;
    csv += `Max Speed,${document.getElementById('statMaxSpeed').textContent} km/h\n\n`;

    // 2. GPS Sections
    csv += "=== GPS Section Analysis ===\n";
    if (savedSections.length > 0) {
        csv += "Name,Duration (s),Distance (m),Avg Speed (km/h),Max Speed (km/h),Descent (m)\n";
        savedSections.forEach(s => {
            // Re-calc stats locally or store them. Recalc is safer for simplicity or grab from DOM? 
            // Logic exists in saveSection but not stored persistently in 's'. 
            // Ideally we should have stored them. Let's quick-calc again or grab from existing logic if possible.
            // Accessing the table is easiest or re-running the loop.
            // We'll re-run the simple loop logic for accuracy.

            let secDist = 0;
            let secDescent = 0;
            const speeds = [];
            for (let i = s.gpsRange[0] + 1; i <= s.gpsRange[1]; i++) {
                const dTime = (parseInt(locationData[i].time) - parseInt(locationData[i - 1].time)) / 1e9;
                const spd = parseFloat(locationData[i].speed);
                speeds.push(spd * 3.6);
                secDist += spd * dTime;
                const dAlt = parseFloat(locationData[i].altitude) - parseFloat(locationData[i - 1].altitude);
                if (dAlt < 0) secDescent += Math.abs(dAlt);
            }
            const maxSpd = speeds.length ? Math.max(...speeds) : 0;
            const avgSpd = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;

            csv += `${s.name},${s.duration.toFixed(1)},${secDist.toFixed(1)},${avgSpd.toFixed(1)},${maxSpd.toFixed(1)},${secDescent.toFixed(1)}\n`;
        });
    } else {
        csv += "No sections recorded.\n";
    }
    csv += "\n";

    // 3. Cycle Analysis
    csv += "=== Cycle Interval Analysis ===\n";
    if (latestCycleStats) {
        const s = latestCycleStats;
        csv += `Total Events (Count),${s.count}\n`;
        csv += `Avg Duration (s),${s.avgDur.toFixed(3)}\n`;
        csv += `Min Duration (s),${s.minDur.toFixed(3)}\n`;
        csv += `Max Duration (s),${s.maxDur.toFixed(3)}\n`;
        csv += `SD (Standard Deviation),${s.stdDev.toFixed(3)}\n`;
        csv += `Frequency (Hz),${s.hz.toFixed(2)}\n`;
        csv += `Distance per Event (m),${s.distPerEvent.toFixed(2)}\n`;
        csv += `Avg Max Acceleration (g),${s.avgMaxAcc.toFixed(2)}\n`;
        csv += `Avg Acceleration (+ Peaks),${s.avgAccelVal.toFixed(2)}\n`;
        csv += `Avg Deceleration (- Peaks),${s.avgDecelVal.toFixed(2)}\n`;

        if (s.hasPhases) {
            csv += `Phase 1 Avg (s),${s.avgP1.toFixed(3)}\n`;
            csv += `Phase 2 Avg (s),${s.avgP2.toFixed(3)}\n`;
        }
    } else {
        csv += "No cycle analysis performed yet.\n";
    }

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", "para_alpine_analysis.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
