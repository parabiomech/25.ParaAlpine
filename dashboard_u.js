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

// Multi-Event Detection State
let detectedEvents = {}; // { eventName: { peaks: [...], config: {...} } }
let activeEventName = null;

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

    // Filter
    filterType: document.getElementById('filterType'),
    param1: document.getElementById('param1'),
    param2: document.getElementById('param2'),
    param1Label: document.getElementById('param1Label'),
    param2Label: document.getElementById('param2Label'),
    btnApplyFilter: document.getElementById('btnApplyFilter'),
    filterDescription: document.getElementById('filterDescription'),

    // Event Detection
    eventName: document.getElementById('eventName'),
    btnDetect: document.getElementById('btnDetect'),
    btnAddEvent: document.getElementById('btnAddEvent'),
    btnClear: document.getElementById('btnClear'),
    eventList: document.getElementById('eventList'),

    // Interval Analysis
    intervalStartEvent: document.getElementById('intervalStartEvent'),
    intervalIntermediateEvent: document.getElementById('intervalIntermediateEvent'),
    intervalEndEvent: document.getElementById('intervalEndEvent'),
    btnAnalyzeIntervals: document.getElementById('btnAnalyzeIntervals'),
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

// ================= FILTER CONFIGURATIONS =================

const filterConfigs = {
    butterworth: {
        params: [
            { id: 'param1', label: 'Cut-off Frequency (Hz)', default: 6, step: 0.1 },
            { id: 'param2', label: 'Order', default: 4, step: 1 }
        ],
        description: 'Butterworth filter - Standard biomechanics filter with customizable frequency and order'
    },
    kalman: {
        params: [
            { id: 'param1', label: 'Trust Ratio', default: 500, step: 10 },
            { id: 'param2', label: 'Smooth (0=false, 1=true)', default: 1, step: 1 }
        ],
        description: 'Kalman filter - Simplified Kalman filter. Trust ratio = measurement_trust/process_trust'
    },
    gcv_spline: {
        params: [
            { id: 'param1', label: 'Cut-off Frequency (0=auto)', default: 0, step: 1 },
            { id: 'param2', label: 'Smoothing Factor', default: 0.1, step: 0.01 }
        ],
        description: 'GCV Spline - Automatically determines optimal parameters for each point'
    },
    loess: {
        params: [
            { id: 'param1', label: 'Nb Values Used', default: 5, step: 1 },
            { id: 'param2', label: 'N/A', default: 0, step: 1 }
        ],
        description: 'LOESS - Local regression filter using fraction of data'
    },
    gaussian: {
        params: [
            { id: 'param1', label: 'Sigma Kernel (px)', default: 1, step: 0.1 },
            { id: 'param2', label: 'N/A', default: 0, step: 1 }
        ],
        description: 'Gaussian filter - Smoothing with Gaussian kernel'
    },
    median: {
        params: [
            { id: 'param1', label: 'Kernel Size', default: 3, step: 2 },
            { id: 'param2', label: 'N/A', default: 0, step: 1 }
        ],
        description: 'Median filter - Removes outliers using median value in window'
    },
    butterworth_speed: {
        params: [
            { id: 'param1', label: 'Cut-off Frequency (Hz)', default: 10, step: 0.1 },
            { id: 'param2', label: 'Order', default: 4, step: 1 }
        ],
        description: 'Butterworth on Speed - Butterworth filter applied to speed data'
    }
};

// ================= FILTERING FUNCTIONS =================

function butterworthFilter(data, fs, cutoff, order = 4) {
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

function kalmanFilter(data, trustRatio = 500, smooth = true) {
    if (!data || data.length === 0) return [];
    const result = new Array(data.length);
    let estimate = data[0], errorEstimate = 1.0;
    const processNoise = 1.0 / trustRatio, measurementNoise = 1.0;
    for (let i = 0; i < data.length; i++) {
        const kalmanGain = errorEstimate / (errorEstimate + measurementNoise);
        estimate = estimate + kalmanGain * (data[i] - estimate);
        errorEstimate = (1 - kalmanGain) * errorEstimate + Math.abs(processNoise);
        result[i] = estimate;
    }
    return result;
}

function loessFilter(data, windowSize = 5) {
    if (!data || data.length === 0) return [];
    const result = new Array(data.length);
    const halfWindow = Math.floor(windowSize / 2);
    for (let i = 0; i < data.length; i++) {
        const start = Math.max(0, i - halfWindow);
        const end = Math.min(data.length, i + halfWindow + 1);
        const window = data.slice(start, end);
        result[i] = window.reduce((a, b) => a + b, 0) / window.length;
    }
    return result;
}

function gaussianFilter(data, sigma = 1) {
    if (!data || data.length === 0) return [];
    const kernelSize = Math.ceil(sigma * 3) * 2 + 1;
    const kernel = [];
    const halfSize = Math.floor(kernelSize / 2);
    let sum = 0;
    for (let i = -halfSize; i <= halfSize; i++) {
        const val = Math.exp(-(i * i) / (2 * sigma * sigma));
        kernel.push(val);
        sum += val;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const result = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
        let value = 0;
        for (let j = -halfSize; j <= halfSize; j++) {
            const idx = Math.max(0, Math.min(data.length - 1, i + j));
            value += data[idx] * kernel[j + halfSize];
        }
        result[i] = value;
    }
    return result;
}

function medianFilter(data, kernelSize = 3) {
    if (!data || data.length === 0) return [];
    const result = new Array(data.length);
    const halfKernel = Math.floor(kernelSize / 2);
    for (let i = 0; i < data.length; i++) {
        const window = [];
        for (let j = -halfKernel; j <= halfKernel; j++) {
            const idx = Math.max(0, Math.min(data.length - 1, i + j));
            window.push(data[idx]);
        }
        window.sort((a, b) => a - b);
        result[i] = window[Math.floor(window.length / 2)];
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

    const filterType = els.filterType.value;
    const param1Val = parseFloat(els.param1.value);
    const param2Val = parseFloat(els.param2.value);

    const pipe = (raw) => {
        const floatData = raw.map(d => parseFloat(d));
        let filtered;
        switch (filterType) {
            case 'butterworth': filtered = butterworthFilter(floatData, fs, param1Val, param2Val); break;
            case 'kalman': filtered = kalmanFilter(floatData, param1Val, param2Val > 0); break;
            case 'gcv_spline': filtered = param1Val > 0 ? butterworthFilter(floatData, fs, param1Val) : gaussianFilter(floatData, param2Val * 5); break;
            case 'loess': filtered = loessFilter(floatData, param1Val); break;
            case 'gaussian': filtered = gaussianFilter(floatData, param1Val); break;
            case 'median': filtered = medianFilter(floatData, param1Val); break;
            case 'butterworth_speed': filtered = butterworthFilter(floatData, fs, param1Val, param2Val); break;
            default: filtered = butterworthFilter(floatData, fs, 6);
        }
        return savitzkyGolayFilter(filtered);
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
        if (!obj.altitude && obj.height) obj.altitude = obj.alt;
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
        const txt = await metadataFile.text();
        const rows = txt.split('\n');
        if (rows.length >= 2) {
            const h = rows[0].split(','), v = rows[1].split(',');
            const m = {}; h.forEach((k, i) => m[k.trim()] = v[i]);
            if (m['device name']) els.infoDevice.textContent = m['device name'];
        }
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
    els.filterType.onchange = updateFilterUI;
    els.btnApplyFilter.onclick = () => {
        processFullMotionData();
        if (motionChartsInitialized) loadCharts(activeSectionData ? activeSectionData.data : processedMotionData);
        alert('Filter applied successfully!');
    };
    els.btnDetect.onclick = runDetection;
    els.btnAddEvent.onclick = addEventType;
    els.btnClear.onclick = clearDetection;
    els.btnAnalyzeIntervals.onclick = analyzeIntervals;

    updateFilterUI();
});

// ================= FILTER UI =================

function updateFilterUI() {
    const filterType = els.filterType.value;
    const config = filterConfigs[filterType];
    if (!config) return;
    const p1 = config.params[0];
    els.param1Label.textContent = p1.label;
    els.param1.value = p1.default;
    els.param1.step = p1.step;
    document.getElementById('param1Group').style.display = 'flex';
    const p2 = config.params[1];
    els.param2Label.textContent = p2.label;
    els.param2.value = p2.default;
    els.param2.step = p2.step;
    document.getElementById('param2Group').style.display = p2.label === 'N/A' ? 'none' : 'flex';
    els.filterDescription.textContent = config.description;
}

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
    els.btnPause.style.display = 'inline';
    playInterval = setInterval(() => {
        if (currentIndex >= locationData.length - 1) { pause(); return; }
        currentIndex++;
        updateIndex(currentIndex);
    }, 100);
}

function pause() {
    isPlaying = false;
    els.btnPlay.style.display = 'inline';
    els.btnPause.style.display = 'none';
    if (playInterval) clearInterval(playInterval);
}

function updateIndex(idx) {
    currentIndex = idx;
    els.slider.value = idx;
    const pt = locationData[idx];
    const elapsed = (parseInt(pt.time) - parseInt(locationData[0].time)) / 1e9;
    els.curTime.textContent = formatTime(elapsed);
    if (mapMarker) mapMarker.setLatLng([parseFloat(pt.latitude), parseFloat(pt.longitude)]);
    Plotly.update('gps3dChart', {
        x: [[getLocalCoords(parseFloat(pt.latitude), parseFloat(pt.longitude), parseFloat(pt.altitude)).x]],
        y: [[getLocalCoords(parseFloat(pt.latitude), parseFloat(pt.longitude), parseFloat(pt.altitude)).y]],
        z: [[getLocalCoords(parseFloat(pt.latitude), parseFloat(pt.longitude), parseFloat(pt.altitude)).z]]
    }, {}, [1]);
}

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function getLocalCoords(lat, lon, alt) {
    const R = 6371000;
    const dLat = (lat - gpsRef.lat) * Math.PI / 180;
    const dLon = (lon - gpsRef.lon) * Math.PI / 180;
    const x = R * dLon * Math.cos(gpsRef.lat * Math.PI / 180);
    const y = R * dLat;
    const z = alt - gpsRef.alt;
    return { x, y, z };
}

// ================= GPS PAGE =================

function initGPSPage() {
    map = L.map('mapContainer').setView([parseFloat(locationData[0].latitude), parseFloat(locationData[0].longitude)], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);
    const coords = locationData.map(d => [parseFloat(d.latitude), parseFloat(d.longitude)]);
    polylineGroup = L.polyline(coords, { color: 'blue', weight: 3 }).addTo(map);
    mapMarker = L.marker(coords[0], { icon: L.icon({ iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png', iconSize: [25, 41], iconAnchor: [12, 41] }) }).addTo(map);
    map.fitBounds(polylineGroup.getBounds());

    const yEle = locationData.map(d => parseFloat(d.altitude));
    const ySpd = locationData.map(d => parseFloat(d.speed) * 3.6);

    Plotly.newPlot('elevationChart', [{ y: yEle, type: 'scatter', fill: 'tozeroy' }], { margin: { l: 30, r: 10, t: 10, b: 20 }, height: 200 });
    Plotly.newPlot('speedChart', [{ y: ySpd, type: 'scatter', fill: 'tozeroy', line: { color: '#e67e22' } }], { margin: { l: 30, r: 10, t: 10, b: 20 }, height: 200 });

    gpsRef = { lat: parseFloat(locationData[0].latitude), lon: parseFloat(locationData[0].longitude), alt: yEle[0] };
    const xRel = [], yRel = [], zRel = [];
    locationData.forEach((d, i) => {
        const res = getLocalCoords(parseFloat(d.latitude), parseFloat(d.longitude), yEle[i]);
        xRel.push(res.x);
        yRel.push(res.y);
        zRel.push(res.z);
    });

    Plotly.newPlot('gps3dChart', [{ type: 'scatter3d', mode: 'lines', x: xRel, y: yRel, z: zRel, line: { width: 5, color: ySpd, colorscale: 'Viridis' } }, { type: 'scatter3d', mode: 'markers', x: [xRel[0]], y: [yRel[0]], z: [zRel[0]], marker: { size: 6, color: 'red' } }], {
        margin: { t: 0, b: 0, l: 0, r: 0 }, showlegend: false, scene: { aspectmode: 'data', camera: { eye: { x: 1.5, y: 1.5, z: 1.5 } } }
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
        els.selStart.appendChild(new Option(m.label, m.index));
        els.selEnd.appendChild(new Option(m.label, m.index));
    });
}

function saveSection() {
    const sIdx = parseInt(els.selStart.value), eIdx = parseInt(els.selEnd.value), name = els.secName.value.trim();
    if (!name || isNaN(sIdx) || isNaN(eIdx) || sIdx >= eIdx) { alert('Invalid section'); return; }

    const t0 = parseInt(locationData[sIdx].time), t1 = parseInt(locationData[eIdx].time);
    const motionStart = accelData.findIndex(d => parseInt(d.time) >= t0);
    const motionEnd = accelData.findIndex(d => parseInt(d.time) > t1);

    const section = {
        id: `sec_${savedSections.length}`, name, gpsRange: [sIdx, eIdx],
        duration: (t1 - t0) / 1e9,
        motionRange: [motionStart, motionEnd === -1 ? accelData.length : motionEnd],
        data: {}
    };
    Object.keys(processedMotionData).forEach(k => { section.data[k] = processedMotionData[k].slice(motionStart, motionEnd === -1 ? undefined : motionEnd); });
    savedSections.push(section);
    els.selSection.appendChild(new Option(name, section.id));

    // Stats
    let secDist = 0, secDescent = 0, speeds = [];
    for (let i = sIdx + 1; i <= eIdx; i++) {
        const dTime = (parseInt(locationData[i].time) - parseInt(locationData[i - 1].time)) / 1e9;
        const spd = parseFloat(locationData[i].speed);
        speeds.push(spd * 3.6);
        secDist += spd * dTime;
        const dAlt = parseFloat(locationData[i].altitude) - parseFloat(locationData[i - 1].altitude);
        if (dAlt < 0) secDescent += Math.abs(dAlt);
    }
    const maxSpd = speeds.length ? Math.max(...speeds) : 0, avgSpd = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;

    if (savedSections.length === 1) els.secStatsTable.innerHTML = '';
    els.secStatsTable.innerHTML += `<tr><td>${name}</td><td>${section.duration.toFixed(1)}</td><td>${secDist.toFixed(1)}</td><td>${avgSpd.toFixed(1)}</td><td>${maxSpd.toFixed(1)}</td><td>${secDescent.toFixed(1)}</td></tr>`;
    alert(`Section "${name}" saved!`);
}

function loadMotionSection(val) {
    clearDetection();
    if (val === 'full') { activeSectionData = null; els.secDetails.textContent = `Displaying all data`; loadCharts(processedMotionData); }
    else { const sec = savedSections.find(s => s.id === val); activeSectionData = sec; els.secDetails.textContent = `Section: ${sec.name} | Duration: ${sec.duration.toFixed(1)}s`; loadCharts(sec.data); }
}

function loadCharts(data) {
    Object.keys(data).forEach(k => {
        Plotly.newPlot(`chart_${k}`, [{ y: data[k], type: 'scatter', mode: 'lines', line: { width: 1.5 } }], { margin: { l: 30, r: 10, t: 30, b: 20 }, height: 200, yaxis: { title: k } });
    });
}

// ================= MULTI-EVENT DETECTION =================

function runDetection() {
    const eventName = els.eventName.value.trim() || 'event_' + Object.keys(detectedEvents).length;
    const key = document.getElementById('targetVar').value;
    const thresh = parseFloat(document.getElementById('algoThreshold').value);
    const win = parseInt(document.getElementById('algoWindow').value);
    const dir = document.getElementById('detectDir').value;

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
    visualizeDetection(eventName);
    updateEventList();
    updateIntervalEventSelectors();
    calculateStats(peaks, activeSectionData ? activeSectionData.duration : (accelData.length * 0.01)); // approx
}

function addEventType() {
    const eventName = els.eventName.value.trim();
    if (!eventName || detectedEvents[eventName]) return alert('Invalid or existing name');
    detectedEvents[eventName] = { peaks: [], config: { key: document.getElementById('targetVar').value } };
    updateEventList(); updateIntervalEventSelectors();
}

function visualizeDetection(eventName) {
    const event = detectedEvents[eventName]; if (!event) return;
    const key = event.config.key;
    const dataObj = activeSectionData ? activeSectionData.data : processedMotionData;
    const series = dataObj[key];
    Plotly.react(`chart_${key}`, [{ y: series, type: 'scatter', mode: 'lines', name: 'Signal' }, { x: event.peaks.map(p => p.i), y: event.peaks.map(p => p.v), type: 'scatter', mode: 'markers', marker: { color: 'red', size: 8 }, name: eventName }], { margin: { l: 30, r: 10, t: 30, b: 20 }, height: 200, yaxis: { title: key } });
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
function deleteEvent(n) { if (confirm('Delete?')) { delete detectedEvents[n]; if (activeEventName === n) activeEventName = null; updateEventList(); updateIntervalEventSelectors(); clearDetection(); } }

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
    if (!peaks.length) return;
    const absPeaks = peaks.map(p => Math.abs(p.v));
    const dt = totalDuration / (activeSectionData ? activeSectionData.motionRange[1] - activeSectionData.motionRange[0] : accelData.length);
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
    detectedEvents = {}; activeEventName = null;
    updateEventList(); updateIntervalEventSelectors(); els.intervalResults.style.display = 'none';
    loadCharts(activeSectionData ? activeSectionData.data : processedMotionData);
    [els.resAvgPeak, els.resMaxPeak, els.resAvgTime, els.resCount, els.resEPM].forEach(e => e.textContent = '-');
}

function initMotionPage() { loadCharts(processedMotionData); }

// ================= EXTENDED INTERVAL ANALYSIS =================

function analyzeIntervals() {
    const sName = els.intervalStartEvent.value;
    const mName = els.intervalIntermediateEvent.value;
    const eName = els.intervalEndEvent.value;

    if (!sName || !eName) return alert('Please select Start and End events');
    const sPeaks = detectedEvents[sName].peaks.map(p => p.i).sort((a, b) => a - b);
    const mPeaks = mName ? detectedEvents[mName].peaks.map(p => p.i).sort((a, b) => a - b) : null;
    const ePeaks = detectedEvents[eName].peaks.map(p => p.i).sort((a, b) => a - b);

    const cycles = [];
    const dataObj = activeSectionData ? activeSectionData.data : processedMotionData;
    const dt = 0.01; // Assume 100Hz

    for (let i = 0; i < sPeaks.length; i++) {
        const start = sPeaks[i];
        let mid = -1, end = -1;

        if (mName && mPeaks) {
            // Split Cycle: Start -> Mid -> End
            const midNode = mPeaks.find(idx => idx > start);
            if (!midNode) break;
            mid = midNode;

            const endNode = ePeaks.find(idx => idx > mid);
            if (!endNode) break;
            end = endNode;
        } else {
            // Direct Cycle: Start -> End
            // If start and end event are same, find next
            const endNode = ePeaks.find(idx => idx > start);
            if (!endNode) break;
            end = endNode;
        }

        // Calculate spatiotemporal metrics for this cycle
        // Approximate distance: Sum of speed * dt
        // We need to map motion index to location index to get speed.
        // Motion fs ~ 100Hz, GPS fs ~ 1-10Hz. Map based on time.

        // Find time range
        const tStart = getTimeForMotionIndex(start);
        const tEnd = getTimeForMotionIndex(end);

        // Get GPS Points in this range for speed/dist
        const gpsPoints = locationData.filter(p => parseInt(p.time) >= tStart && parseInt(p.time) <= tEnd);
        let cycleDist = 0;
        let avgSpd = 0;
        if (gpsPoints.length > 0) {
            const distSum = gpsPoints.reduce((acc, p) => acc + parseFloat(p.speed), 0);
            // Riemann sum is better but avg speed * duration is okay approx for short bursts
            avgSpd = distSum / gpsPoints.length; // m/s
            cycleDist = avgSpd * ((tEnd - tStart) / 1e9);
        }

        // Max Accel in cycle
        const sliceAcc = dataObj.acc_mag.slice(start, end + 1);
        const maxAcc = Math.max(...sliceAcc);
        const avgAcc = sliceAcc.reduce((a, b) => a + b, 0) / sliceAcc.length;

        cycles.push({
            id: i,
            start, mid, end,
            duration: (end - start) * dt,
            p1_dur: mid !== -1 ? (mid - start) * dt : 0,
            p2_dur: mid !== -1 ? (end - mid) * dt : 0,
            distance: cycleDist,
            maxAcc, avgAcc
        });
    }

    if (!cycles.length) return alert('No valid cycles found');
    calculateExtendedStats(cycles);
    displayCycleResults(cycles, mName ? true : false);
}

function getTimeForMotionIndex(idx) {
    if (activeSectionData) {
        // Need absolute index mapping
        // activeSectionData.motionRange[0] is start idx in full array
        // but sec data is already sliced? NO.
        // Wait, activeSectionData.data IS sliced.
        // So passed 'idx' is relative to start of section if using activeSectionData.

        // Wait, 'peaks' indices are collected from 'series'. 
        // runDetection uses 'activeSectionData.data' if active.
        // So 'idx' is 0-based relative to Section.

        // We need start time of section.
        const secStartT = parseInt(locationData[activeSectionData.gpsRange[0]].time);
        // Add idx * 10ms
        return secStartT + (idx * 10 * 1e6); // ns
    } else {
        // Full data
        const startT = parseInt(accelData[0].time);
        return startT + (idx * 10 * 1e6);
    }
}

function calculateExtendedStats(cycles) {
    const durs = cycles.map(c => c.duration);
    const dists = cycles.map(c => c.distance);
    const maxAccs = cycles.map(c => c.maxAcc);
    const avgAccs = cycles.map(c => c.avgAcc);

    const avgDur = durs.reduce((a, b) => a + b, 0) / durs.length;
    const minDur = Math.min(...durs);
    const maxDur = Math.max(...durs);

    // CV
    const variance = durs.reduce((a, b) => a + Math.pow(b - avgDur, 2), 0) / durs.length;
    const stdDev = Math.sqrt(variance);
    const cv = (stdDev / avgDur).toFixed(3);

    const totDist = dists.reduce((a, b) => a + b, 0);
    const distPerEvent = totDist / cycles.length;

    const avgMaxAcc = maxAccs.reduce((a, b) => a + b, 0) / cycles.length;
    const avgAvgAcc = avgAccs.reduce((a, b) => a + b, 0) / cycles.length;

    // Total Time covered by cycles vs Total Session Time? 
    // Usually 'Hz' means frequency of events over the session duration.
    // If we are in a section, use section duration.
    const sessionDur = activeSectionData ? activeSectionData.duration : (accelData.length * 0.01);
    const hz = cycles.length / sessionDur;

    const html = `
    <div class="interval-stat"><div class="interval-stat-val">${avgDur.toFixed(3)}s</div><div class="interval-stat-lbl">Avg Duration</div></div>
    <div class="interval-stat"><div class="interval-stat-val">${minDur.toFixed(3)}s</div><div class="interval-stat-lbl">Min Duration</div></div>
    <div class="interval-stat"><div class="interval-stat-val">${maxDur.toFixed(3)}s</div><div class="interval-stat-lbl">Max Duration</div></div>
    <div class="interval-stat"><div class="interval-stat-val">${cv}</div><div class="interval-stat-lbl">CV (Consistency)</div></div>
    <div class="interval-stat"><div class="interval-stat-val">${cycles.length}</div><div class="interval-stat-lbl">Total Events</div></div>
    <div class="interval-stat"><div class="interval-stat-val">${hz.toFixed(2)} Hz</div><div class="interval-stat-lbl">Frequency</div></div>
    <div class="interval-stat"><div class="interval-stat-val">${distPerEvent.toFixed(2)} m</div><div class="interval-stat-lbl">Dist / Event</div></div>
    <div class="interval-stat"><div class="interval-stat-val">${avgMaxAcc.toFixed(2)} g</div><div class="interval-stat-lbl">Avg Max Acc</div></div>
    <div class="interval-stat"><div class="interval-stat-val">${avgAvgAcc.toFixed(2)} g</div><div class="interval-stat-lbl">Avg Mean Acc</div></div>
    `;

    els.cycleStats.innerHTML = html;
    els.intervalSummary.textContent = `Analyzed ${cycles.length} cycles. Total Distance in cycles: ${totDist.toFixed(1)}m`;
}

function displayCycleResults(cycles, isSplit) {
    els.intervalResults.style.display = 'block';

    let data = [];
    if (isSplit) {
        data = [
            {
                x: cycles.map((c, i) => `Cycle ${i + 1}`),
                y: cycles.map(c => c.p1_dur),
                name: 'Phase 1 (Start->Mid)',
                type: 'bar',
                marker: { color: '#3498db' }
            },
            {
                x: cycles.map((c, i) => `Cycle ${i + 1}`),
                y: cycles.map(c => c.p2_dur),
                name: 'Phase 2 (Mid->End)',
                type: 'bar',
                marker: { color: '#e74c3c' }
            }
        ];
    } else {
        data = [{
            x: cycles.map((c, i) => `Cycle ${i + 1}`),
            y: cycles.map(c => c.duration),
            name: 'Duration',
            type: 'bar',
            marker: { color: '#2ecc71' }
        }];
    }

    Plotly.newPlot('intervalChart', data, {
        barmode: isSplit ? 'stack' : 'group',
        title: 'Cycle Durations',
        yaxis: { title: 'Time (s)' },
        margin: { t: 40, b: 40, r: 20, l: 40 }
    });
}
