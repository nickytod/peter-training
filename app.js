'use strict';
// ============================================================
//  Peter Training — app.js
//  Vanilla JS PWA, no frameworks
// ============================================================

// ---- State ----
const S = {
  program:    null,    // loaded from program.json
  logs:       [],      // completed workouts [{id,date,type,startTime,endTime,exercises[]}]
  current:    null,    // in-progress workout session
  tab:        'today',
  expanded:   null,    // currently expanded exercise id
  warmupOpen: false,
  timer:      null,    // rest timer state
  histFilter: 'all',
  statsEx:    null,    // selected exercise id in stats view
  expandedLog: null,   // expanded history entry id
  guided:     false,   // guided workout mode active
  guidedIdx:  0,       // current exercise index in guided mode
  guidedSet:  0,       // current set index in guided mode
  guidedSuperset: 0,   // 0=first exercise, 1=partner in superset
  scheduleSelected: null, // selected day index in schedule view
  calMonth: undefined,    // calendar month (0-11)
  calYear:  undefined,    // calendar year
};

// ---- LocalStorage Keys ----
const LS = {
  LOGS:    'pt_logs_v2',
  CURRENT: 'pt_current_v2',
};

// ---- Recovery Tips ----
const TIPS = [
  { icon: '💤', text: 'Prioritize 7-9 hours of sleep — muscle repair peaks during deep sleep' },
  { icon: '🥩', text: 'Hit your protein target: ~2g/kg bodyweight, spread across 4+ meals' },
  { icon: '🚶', text: 'Light 20-30 min walk aids active recovery and lymphatic circulation' },
  { icon: '🧘', text: 'Mobility work: hip flexors, thoracic spine, shoulder external rotation' },
  { icon: '💧', text: 'Hydration: target 35ml/kg bodyweight. Add electrolytes if sweating' },
  { icon: '❄️', text: 'Cold shower or contrast therapy can reduce DOMS and improve HRV' },
];

// ============================================================
//  INIT
// ============================================================
async function init() {
  try {
    const res = await fetch('./program.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    S.program = await res.json();
  } catch (e) {
    document.getElementById('app').innerHTML = `
      <div class="error-state">
        <span class="error-icon">⚠️</span>
        <h2>Couldn't load program</h2>
        <p>Serve this folder over HTTP and make sure program.json exists.<br><br>
           Run: <code>cd workout && python3 -m http.server 8080</code></p>
      </div>`;
    return;
  }

  S.logs    = JSON.parse(localStorage.getItem(LS.LOGS)    || '[]');
  S.current = JSON.parse(localStorage.getItem(LS.CURRENT) || 'null');

  // Archive stale in-progress workout from a different day
  if (S.current && S.current.date !== todayStr()) {
    if (anySetCompleted()) archiveCurrentWorkout();
    else clearCurrent();
  }

  // Default stats exercise to first compound
  if (S.program) {
    const firstWorkout = Object.values(S.program.workouts)[0];
    if (firstWorkout?.exercises?.length) {
      S.statsEx = firstWorkout.exercises[0].id;
    }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  render();
}

// ============================================================
//  DATE / CYCLE
// ============================================================
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateShort(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(startIso, endIso) {
  const mins = Math.round((new Date(endIso) - new Date(startIso)) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins/60)}h ${mins%60}m`;
}

function getTodayType() {
  const startDate = new Date(S.program.startDate + 'T12:00:00');
  const today     = new Date(todayStr() + 'T12:00:00');
  const days      = Math.round((today - startDate) / 86400000);
  const cycle     = S.program.cycleDays;
  return cycle[((days % cycle.length) + cycle.length) % cycle.length];
}

// ============================================================
//  PROGRAM HELPERS
// ============================================================
function getAllExercises() {
  const exMap = {};
  for (const w of Object.values(S.program.workouts)) {
    for (const ex of w.exercises) {
      exMap[ex.id] = ex;
    }
  }
  return exMap;
}

function findProgramEx(id) {
  return getAllExercises()[id] || null;
}

function isAMRAP(ex) { return ex.repsMax >= 100; }
function isBW(ex)    { return ex.startWeight === 0; }

function repsDisplay(ex) {
  if (isAMRAP(ex)) return 'AMRAP';
  if (ex.repsMin === ex.repsMax) return String(ex.repsMin);
  return `${ex.repsMin}–${ex.repsMax}`;
}

function increment(ex) {
  const n = (ex.notes || '').toLowerCase();
  const i = ex.id.toLowerCase();
  if (n.includes('per hand') || n.includes('per arm') || n.includes('per leg') ||
      i.includes('db') || i.includes('dumbbell') || i.includes('hammer') ||
      i.includes('lateral') || i.includes('face-pull') || i.includes('incline-db') ||
      i.includes('bulgarian') || i.includes('walking-lunge'))
    return 2;
  return 2.5;
}

// ============================================================
//  HISTORY / PR HELPERS
// ============================================================
function lastExData(exerciseId) {
  for (let i = S.logs.length - 1; i >= 0; i--) {
    const ex = (S.logs[i].exercises || []).find(e => e.exerciseId === exerciseId);
    if (ex) return ex;
  }
  return null;
}

function lastWeight(exerciseId, programEx) {
  const ex = lastExData(exerciseId);
  if (ex?.sets?.length) {
    const done = ex.sets.filter(s => s.completed);
    if (done.length) return done[done.length - 1].weight;
  }
  return programEx.startWeight;
}

function getPR(exerciseId) {
  let best = null;
  for (const log of S.logs) {
    const ex = (log.exercises || []).find(e => e.exerciseId === exerciseId);
    if (!ex) continue;
    for (const s of ex.sets) {
      if (!s.completed) continue;
      const vol = (s.weight || 0) * (s.reps || 0);
      if (!best || vol > best.volume) {
        best = { weight: s.weight, reps: s.reps, volume: vol, date: log.date };
      }
    }
  }
  return best;
}

function isNewPR(exerciseId, weight, reps) {
  const pr = getPR(exerciseId);
  const vol = (weight || 0) * (reps || 0);
  if (!vol) return false;
  if (!pr) return true;
  return vol > pr.volume;
}

function getWeightHistory(exerciseId, limit = 8) {
  const hist = [];
  for (const log of S.logs) {
    const ex = (log.exercises || []).find(e => e.exerciseId === exerciseId);
    if (!ex) continue;
    const done = (ex.sets || []).filter(s => s.completed && (s.weight > 0 || s.reps > 0));
    if (!done.length) continue;
    const maxW = Math.max(...done.map(s => s.weight || 0));
    const maxR = Math.max(...done.map(s => s.reps || 0));
    hist.push({ date: log.date, weight: maxW, reps: maxR });
  }
  return hist.slice(-limit);
}

function calcVolume(log) {
  let vol = 0;
  for (const ex of (log.exercises || [])) {
    for (const s of (ex.sets || [])) {
      if (s.completed) vol += (s.weight || 0) * (s.reps || 0);
    }
  }
  return vol;
}

function calcTotalSets(log) {
  let total = 0;
  for (const ex of (log.exercises || [])) {
    total += (ex.sets || []).filter(s => s.completed).length;
  }
  return total;
}

// ============================================================
//  WORKOUT SESSION MANAGEMENT
// ============================================================
function anySetCompleted() {
  return S.current?.exercises?.some(ex => ex.sets?.some(s => s.completed));
}

function startWorkout(type) {
  const workout = S.program.workouts[type];
  if (!workout) return;

  S.current = {
    id:        genId(),
    date:      todayStr(),
    type:      type,
    startTime: new Date().toISOString(),
    endTime:   null,
    exercises: workout.exercises.map(ex => ({
      exerciseId: ex.id,
      sets: Array.from({ length: ex.sets }, () => ({
        weight:    lastWeight(ex.id, ex),
        reps:      isAMRAP(ex) ? 0 : ex.repsMax,
        completed: false,
      })),
      rpe: null,
    })),
  };

  saveCurrent();
  S.expanded = workout.exercises[0]?.id || null;
  S.guided = true;
  S.guidedIdx = 0;
  S.guidedSet = 0;
  S.guidedSuperset = 0;
  render();
}

function saveCurrent() {
  localStorage.setItem(LS.CURRENT, JSON.stringify(S.current));
}

function clearCurrent() {
  S.current = null;
  localStorage.removeItem(LS.CURRENT);
}

function archiveCurrentWorkout() {
  if (!S.current) return;
  S.current.endTime = S.current.endTime || new Date().toISOString();
  S.logs.push({ ...S.current });
  localStorage.setItem(LS.LOGS, JSON.stringify(S.logs));
  clearCurrent();
}

function finishWorkout() {
  if (!confirm('Finish workout and save to history?')) return;
  archiveCurrentWorkout();
  stopTimer();
  S.expanded = null;
  showToast('Workout saved! 💪');
  render();
}

function abandonWorkout() {
  if (!confirm('Abandon this workout? Progress will be lost.')) return;
  clearCurrent();
  stopTimer();
  S.expanded = null;
  render();
}

function getProgress() {
  if (!S.current) return { done: 0, total: 0, pct: 0 };
  const total = S.current.exercises.length;
  const done  = S.current.exercises.filter(ex => ex.sets.every(s => s.completed)).length;
  return { done, total, pct: total ? (done / total) * 100 : 0 };
}

function getExData(exId) {
  return S.current?.exercises?.find(e => e.exerciseId === exId) || null;
}

// ============================================================
//  SET OPERATIONS
// ============================================================
function adjustWeight(exId, idx, delta) {
  const ex = getExData(exId);
  if (!ex || ex.sets[idx].completed) return;
  const inc = increment(findProgramEx(exId));
  const cur = parseFloat(ex.sets[idx].weight) || 0;
  ex.sets[idx].weight = Math.max(0, Math.round((cur + delta) / inc) * inc);
  // Round to avoid floating point
  ex.sets[idx].weight = Math.round(ex.sets[idx].weight * 10) / 10;
  saveCurrent();
  // Update DOM directly to avoid losing focus
  const input = document.querySelector(`[data-weight="${exId}-${idx}"]`);
  if (input) input.value = ex.sets[idx].weight;
}

function adjustReps(exId, idx, delta) {
  const ex = getExData(exId);
  if (!ex || ex.sets[idx].completed) return;
  ex.sets[idx].reps = Math.max(0, (parseInt(ex.sets[idx].reps) || 0) + delta);
  saveCurrent();
  const input = document.querySelector(`[data-reps="${exId}-${idx}"]`);
  if (input) input.value = ex.sets[idx].reps;
}

function onWeightBlur(exId, idx, val) {
  const ex = getExData(exId);
  if (!ex) return;
  const v = parseFloat(val);
  if (!isNaN(v) && v >= 0) {
    ex.sets[idx].weight = v;
    saveCurrent();
  }
}

function onRepsBlur(exId, idx, val) {
  const ex = getExData(exId);
  if (!ex) return;
  const v = parseInt(val);
  if (!isNaN(v) && v >= 0) {
    ex.sets[idx].reps = v;
    saveCurrent();
  }
}

function completeSet(exId, idx) {
  const ex = getExData(exId);
  if (!ex) return;

  // Read current input values before marking done
  const wInput = document.querySelector(`[data-weight="${exId}-${idx}"]`);
  const rInput = document.querySelector(`[data-reps="${exId}-${idx}"]`);
  if (wInput) ex.sets[idx].weight = parseFloat(wInput.value) || 0;
  if (rInput) ex.sets[idx].reps   = parseInt(rInput.value) || 0;

  ex.sets[idx].completed = true;
  saveCurrent();

  const programEx = findProgramEx(exId);
  const isLast    = idx >= ex.sets.length - 1;

  // Superset logic
  if (programEx?.supersetWith) {
    const partnerId  = programEx.supersetWith;
    const partnerEx  = getExData(partnerId);
    const partnerDone = (partnerEx?.sets || []).filter(s => s.completed).length;
    // Jump to partner after short rest
    S.expanded = partnerId;
    startTimer(
      programEx.restSeconds,
      `Next: ${findProgramEx(partnerId)?.name || 'Partner exercise'}`,
      () => { S.expanded = partnerId; render(); }
    );
  } else {
    if (!isLast) {
      const nextSet = idx + 1;
      startTimer(
        programEx?.restSeconds || 90,
        `${programEx?.name} — Set ${nextSet + 1}`,
        null
      );
    }
  }

  // Pre-fill next set with same weight if not last
  if (!isLast) {
    ex.sets[idx + 1].weight = ex.sets[idx].weight;
    ex.sets[idx + 1].reps   = isAMRAP(programEx) ? ex.sets[idx].reps : ex.sets[idx].reps;
  }

  saveCurrent();
  render();

  // Scroll to next set or RPE section
  requestAnimationFrame(() => {
    const card = document.getElementById(`card-${exId}`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function logRPE(exId, rpeValue) {
  const ex = getExData(exId);
  if (!ex) return;
  ex.rpe = rpeValue;
  saveCurrent();
  render();
  showToast(`RPE ${rpeValue} logged`);
}

// ============================================================
//  REST TIMER
// ============================================================
function startTimer(seconds, label, onComplete) {
  stopTimer();
  S.timer = {
    total:       seconds,
    remaining:   seconds,
    label:       label || 'Rest',
    onComplete:  onComplete || null,
    startedAt:   Date.now(),
    interval:    null,
    completed:   false,
    postDismiss: null,
  };
  S.timer.interval = setInterval(timerTick, 250);
  renderTimer();
  showTimerOverlay();
}

function timerTick() {
  if (!S.timer) return;
  const elapsed = (Date.now() - S.timer.startedAt) / 1000;
  S.timer.remaining = Math.max(0, S.timer.total - elapsed);
  renderTimer();
  if (S.timer.remaining <= 0 && !S.timer.completed) {
    S.timer.completed = true;
    clearInterval(S.timer.interval);
    onTimerDone();
  }
}

function onTimerDone() {
  // Vibrate
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 300]);
  // Beep
  playBeep();
  // Run callback
  if (S.timer?.onComplete) S.timer.onComplete();
  // Auto-dismiss after 5s
  S.timer.postDismiss = setTimeout(() => {
    stopTimer();
    hideTimerOverlay();
    render();
  }, 5000);
}

function stopTimer() {
  if (!S.timer) return;
  clearInterval(S.timer.interval);
  clearTimeout(S.timer.postDismiss);
  S.timer = null;
}

function skipTimer() {
  if (S.timer?.onComplete) S.timer.onComplete();
  stopTimer();
  hideTimerOverlay();
  render();
}

function showTimerOverlay() {
  document.getElementById('timer-overlay').classList.add('active');
}
function hideTimerOverlay() {
  document.getElementById('timer-overlay').classList.remove('active');
}

function renderTimer() {
  if (!S.timer) return;
  const overlay = document.getElementById('timer-overlay');
  if (!overlay.classList.contains('active')) return;

  const { remaining, total, label, completed } = S.timer;
  const pct     = remaining / total;
  const R       = 95;
  const circ    = 2 * Math.PI * R;
  const offset  = circ * (1 - pct);
  const secStr  = Math.ceil(remaining);
  const urgent  = remaining <= 10 && !completed;
  const done    = completed;

  const fgClass = done ? 'done' : urgent ? 'urgent' : '';

  overlay.innerHTML = `
    <div class="timer-content">
      <div class="timer-heading">Rest Timer</div>
      <div class="timer-ring-wrap">
        <svg class="timer-ring" viewBox="0 0 220 220">
          <circle class="timer-ring-bg" cx="110" cy="110" r="${R}"/>
          <circle class="timer-ring-fg ${fgClass}" cx="110" cy="110" r="${R}"
                  stroke-dasharray="${circ.toFixed(2)}"
                  stroke-dashoffset="${offset.toFixed(2)}"
                  transform="rotate(-90 110 110)"/>
        </svg>
        <div class="timer-seconds">
          <div class="timer-num">${done ? '✓' : secStr}</div>
          <div class="timer-unit">${done ? 'Done!' : 'seconds'}</div>
        </div>
      </div>
      <div class="timer-sub">${escHtml(label)}</div>
      <button class="timer-skip" onclick="skipTimer()">
        ${done ? 'Continue' : 'Skip Rest'}
      </button>
    </div>`;
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[880,0],[880,0.3],[1047,0.6]].forEach(([freq, when]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.4, ctx.currentTime + when);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + when + 0.3);
      osc.start(ctx.currentTime + when);
      osc.stop(ctx.currentTime + when + 0.35);
    });
  } catch (e) { /* audio not available */ }
}

// ============================================================
//  EXERCISE GROUPING (for superset layout)
// ============================================================
function groupExercises(exercises) {
  const groups   = [];
  const seen     = new Set();
  for (const ex of exercises) {
    if (seen.has(ex.id)) continue;
    if (ex.supersetWith) {
      const partner = exercises.find(e => e.id === ex.supersetWith);
      if (partner && !seen.has(partner.id)) {
        groups.push({ type: 'superset', exercises: [ex, partner] });
        seen.add(ex.id);
        seen.add(partner.id);
        continue;
      }
    }
    groups.push({ type: 'single', exercises: [ex] });
    seen.add(ex.id);
  }
  return groups;
}

// ============================================================
//  MAIN RENDER DISPATCHER
// ============================================================
function render() {
  updateNavActive();
  if (S.tab === 'today')   renderToday();
  else if (S.tab === 'history') renderHistory();
  else if (S.tab === 'stats')   renderStats();
}

function switchTab(tab) {
  S.tab = tab;
  render();
  window.scrollTo(0, 0);
}

function updateNavActive() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === S.tab);
  });
}

// ============================================================
//  TODAY VIEW
// ============================================================
function renderToday() {
  const app    = document.getElementById('app');
  const type   = getTodayType();

  if (type === 'rest') {
    app.innerHTML = renderRestDay();
    return;
  }

  const workout = S.program.workouts[type];
  const isActive = S.current && S.current.type === type && S.current.date === todayStr();

  if (!isActive) {
    S.guided = false;
    app.innerHTML = renderStartScreen(type, workout);
    return;
  }

  if (S.guided) {
    app.innerHTML = renderGuidedMode(type, workout);
    return;
  }

  const { done, total, pct } = getProgress();
  const groups = groupExercises(workout.exercises);

  app.innerHTML = `
    <div class="workout-header">
      <div class="workout-day-badge">🏋️ ${type.toUpperCase()}</div>
      <h1 class="workout-title">${workout.name}</h1>
      <p class="workout-date">${fmtDate(todayStr())}</p>
      <div class="progress-section">
        <div class="progress-label">
          <span>Progress</span>
          <span>${done} / ${total} exercises</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
      </div>
    </div>

    <div class="content-area">
      ${renderWarmupCard(workout.warmup)}
      ${groups.map(g => renderGroup(g)).join('')}
      <div class="finish-section">
        <button class="btn btn-primary" onclick="enterGuided()" style="margin-bottom:8px;">
          ▶ Resume Guided Mode
        </button>
        <button class="btn btn-success" onclick="finishWorkout()">
          🏁 Finish Workout
        </button>
        <div style="height:8px"></div>
        <button class="btn btn-outline" onclick="abandonWorkout()" style="color:var(--danger);border-color:var(--danger);">
          Abandon Workout
        </button>
      </div>
    </div>`;
}

function renderStartScreen(type, workout) {
  const icons = { push: '💪', pull: '🦾', legs: '🦵' };
  return `
    <div class="workout-header">
      <div class="workout-day-badge">📅 ${fmtDate(todayStr())}</div>
    </div>
    <div class="content-area">
      <div class="start-screen">
        <div class="start-workout-icon">${icons[type] || '🏋️'}</div>
        <h2>${workout.name}</h2>
        <p>${workout.exercises.length} exercises · ${type === 'push' ? '~60' : type === 'pull' ? '~55' : '~65'} min</p>
        <button class="btn btn-primary" style="max-width:280px;" onclick="startWorkout('${type}')">
          Start Workout
        </button>
      </div>
      <div class="card">
        ${renderWarmupCardInner(workout.warmup, true)}
      </div>
      <div class="section-gap"></div>
      ${groupExercises(workout.exercises).map(g => renderGroupPreview(g)).join('')}
      ${renderUpcomingSchedule()}
    </div>`;
}

function renderRestDay() {
  return `
    <div class="rest-screen">
      <div class="rest-icon">😴</div>
      <h2>Rest Day</h2>
      <p class="rest-date">${fmtDate(todayStr())}</p>
      <div class="recovery-tips">
        ${TIPS.map(t => `
          <div class="recovery-tip">
            <span class="tip-icon">${t.icon}</span>
            <span>${t.text}</span>
          </div>`).join('')}
      </div>
      ${renderUpcomingSchedule()}
    </div>`;
}

function renderUpcomingSchedule() {
  const icons = { push: '💪', pull: '🦾', legs: '🦵', rest: '😴' };
  const names = { push: 'Push', pull: 'Pull', legs: 'Legs', rest: 'Rest' };
  const cycle = S.program.cycleDays;
  
  // Running config from program.json or defaults
  const runConfig = S.program.running || {};
  const runsPerCycle = runConfig.runsPerCycle || [0, 2]; // which cycle indices get runs (push=0, legs=2)
  const runType = runConfig.currentPhase || 'z2'; // 'z2' or 'mixed'
  
  // Build cycle items: strength + runs interleaved
  const items = [];
  const startDate = new Date(S.program.startDate + 'T12:00:00');
  const today = new Date(todayStr() + 'T12:00:00');
  const daysSinceStart = Math.round((today - startDate) / 86400000);
  const currentCyclePos = ((daysSinceStart % cycle.length) + cycle.length) % cycle.length;
  
  // Show 2 full cycles (8 sessions)
  for (let i = 0; i < cycle.length * 2; i++) {
    const type = cycle[i % cycle.length];
    const isCurrent = i === currentCyclePos;
    const isPast = i < currentCyclePos;
    
    items.push({
      kind: 'strength',
      type,
      isCurrent,
      isPast,
      idx: items.length,
    });
    
    // Add run after this strength session if applicable
    if (type !== 'rest' && runsPerCycle.includes(i % cycle.length)) {
      items.push({
        kind: 'run',
        runType: runType === 'mixed' && items.filter(it => it.kind === 'run').length % 3 === 2 ? 'intervals' : 'z2',
        parentType: type,
        isCurrent: false,
        isPast,
        idx: items.length,
      });
    }
  }
  
  const selected = S.scheduleSelected;
  const selItem = selected !== null && selected !== undefined ? items[selected] : null;
  
  return `
    <div class="schedule-section">
      <div class="schedule-title">Training Cycle</div>
      <div class="cycle-list">
        ${items.map((item, i) => {
          if (item.kind === 'strength') {
            const isRest = item.type === 'rest';
            const workout = !isRest ? S.program.workouts[item.type] : null;
            const isSelected = selected === i;
            
            return `
              <div class="cycle-item ${item.isCurrent ? 'current' : ''} ${item.isPast ? 'past' : ''} ${isRest ? 'rest' : ''} ${isSelected ? 'selected' : ''}"
                   onclick="selectScheduleDay(${i})">
                <div class="cycle-item-icon">${icons[item.type]}</div>
                <div class="cycle-item-info">
                  <div class="cycle-item-name">${names[item.type]}${isRest ? '' : ' Day'}</div>
                  ${workout ? `<div class="cycle-item-meta">${workout.exercises.length} exercises</div>` : 
                    `<div class="cycle-item-meta">Recovery</div>`}
                </div>
                ${item.isCurrent ? '<div class="cycle-today-badge">Today</div>' : ''}
                <div class="cycle-chevron">${isSelected ? '▲' : '▼'}</div>
              </div>
              ${isSelected ? renderCycleDetail(item, workout) : ''}`;
          } else {
            // Run item
            const isSelected = selected === i;
            const runIcon = item.runType === 'intervals' ? '⚡' : '🏃';
            const runName = item.runType === 'intervals' ? 'Interval Run' : 'Zone 2 Run';
            const runMeta = item.runType === 'intervals' ? '4×4 min @ 85-90% HR' : '30-45 min · HR <130';
            
            return `
              <div class="cycle-item run ${item.isPast ? 'past' : ''} ${isSelected ? 'selected' : ''}"
                   onclick="selectScheduleDay(${i})">
                <div class="cycle-item-icon">${runIcon}</div>
                <div class="cycle-item-info">
                  <div class="cycle-item-name">${runName}</div>
                  <div class="cycle-item-meta">${runMeta}</div>
                </div>
                <div class="cycle-chevron">${isSelected ? '▲' : '▼'}</div>
              </div>
              ${isSelected ? renderRunDetail(item) : ''}`;
          }
        }).join('')}
      </div>
    </div>`;
}

function renderCycleDetail(item, workout) {
  if (item.type === 'rest') {
    return `<div class="cycle-detail rest-detail">
      <div class="schedule-detail-rest">Recovery — sleep, protein, light walk, mobility work</div>
    </div>`;
  }
  
  return `
    <div class="cycle-detail">
      <div class="schedule-detail-exercises">
        ${workout.exercises.map(ex => `
          <div class="schedule-ex-row">
            <span class="schedule-ex-name">${escHtml(ex.name)}</span>
            <span class="schedule-ex-meta">${ex.sets}×${repsDisplay(ex)} ${isBW(ex) ? 'BW' : ex.startWeight + 'kg'}</span>
          </div>
        `).join('')}
      </div>
      ${item.isCurrent ? `
        <div class="cycle-detail-action">
          <button class="btn btn-primary" onclick="event.stopPropagation(); startWorkout('${item.type}')">
            ▶ Start ${workout.name}
          </button>
        </div>` : ''}
    </div>`;
}

function renderRunDetail(item) {
  if (item.runType === 'intervals') {
    return `
      <div class="cycle-detail">
        <div class="run-detail-content">
          <div class="run-protocol">
            <div class="run-protocol-title">Interval Protocol</div>
            <div class="run-step">🔥 Warm-up: 10 min easy jog</div>
            <div class="run-step">⚡ 4 × 4 min @ 85-90% max HR (156-166 bpm)</div>
            <div class="run-step">🚶 3 min easy recovery between intervals</div>
            <div class="run-step">❄️ Cool-down: 5 min easy jog</div>
            <div class="run-total">~35 min total</div>
          </div>
        </div>
        <div class="cycle-detail-action">
          <button class="btn btn-success" onclick="event.stopPropagation(); logRun('intervals')">
            ✅ Mark Complete
          </button>
        </div>
      </div>`;
  }
  
  return `
    <div class="cycle-detail">
      <div class="run-detail-content">
        <div class="run-protocol">
          <div class="run-protocol-title">Zone 2 Protocol</div>
          <div class="run-step">🎯 HR target: 110-129 bpm (hard ceiling 130)</div>
          <div class="run-step">🏃 Pace: 5.5-6.0 km/h, 2-3% incline</div>
          <div class="run-step">⏱️ Duration: 30-45 min</div>
          <div class="run-step">💡 Should feel easy — can hold a conversation</div>
          <div class="run-total">Use iFit trail program + manual speed override</div>
        </div>
      </div>
      <div class="cycle-detail-action">
        <button class="btn btn-success" onclick="event.stopPropagation(); logRun('z2')">
          ✅ Mark Complete
        </button>
      </div>
    </div>`;
}

function logRun(type) {
  const runLog = {
    id: genId(),
    date: todayStr(),
    type: 'run-' + type,
    kind: 'run',
    runType: type,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    exercises: [],
  };
  S.logs.push(runLog);
  localStorage.setItem(LS.LOGS, JSON.stringify(S.logs));
  showToast(type === 'z2' ? 'Zone 2 run logged! 🏃' : 'Interval run logged! ⚡');
  S.scheduleSelected = null;
  render();
}

function selectScheduleDay(idx) {
  S.scheduleSelected = S.scheduleSelected === idx ? null : idx;
  render();
  // Scroll to detail
  requestAnimationFrame(() => {
    const el = document.querySelector('.schedule-detail');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ---- Warmup ----
function renderWarmupCard(warmup) {
  return `
    <div class="card" style="margin-bottom:12px;">
      <button class="warmup-toggle ${S.warmupOpen ? 'open' : ''}" onclick="toggleWarmup()">
        <span>🔥</span>
        <span class="label">Warm-up</span>
        <span class="chevron">▼</span>
      </button>
      ${S.warmupOpen ? `<div class="warmup-body">${escHtml(warmup)}</div>` : ''}
    </div>`;
}

function renderWarmupCardInner(warmup, open = true) {
  return `
    <button class="warmup-toggle open" style="pointer-events:none;">
      <span>🔥</span>
      <span class="label">Warm-up</span>
    </button>
    <div class="warmup-body">${escHtml(warmup)}</div>`;
}

function toggleWarmup() {
  S.warmupOpen = !S.warmupOpen;
  render();
}

// ---- Exercise Groups ----
function renderGroup(group) {
  if (group.type === 'superset') {
    return `
      <div class="superset-group">
        <div class="superset-label">⚡ Superset</div>
        <div class="superset-cards">
          ${group.exercises.map(ex => renderExCard(ex)).join('')}
        </div>
      </div>`;
  }
  return renderExCard(group.exercises[0]);
}

function renderGroupPreview(group) {
  if (group.type === 'superset') {
    return `
      <div class="superset-group">
        <div class="superset-label">⚡ Superset</div>
        <div class="superset-cards">
          ${group.exercises.map(ex => renderExCardPreview(ex)).join('')}
        </div>
      </div>`;
  }
  return renderExCardPreview(group.exercises[0]);
}

function renderExCardPreview(ex) {
  const wt = isBW(ex) ? 'BW' : `${ex.startWeight}kg`;
  return `
    <div class="card">
      <div class="exercise-card-header" style="pointer-events:none;opacity:0.75;">
        <div class="exercise-status-dot"></div>
        <div class="exercise-card-info">
          <div class="exercise-card-name">${escHtml(ex.name)}</div>
          <div class="exercise-card-meta">
            <span class="meta-pill">${ex.sets} × ${repsDisplay(ex)}</span>
            <span class="meta-pill">${wt}</span>
          </div>
        </div>
      </div>
    </div>`;
}

// ---- Exercise Card ----
function renderExCard(ex) {
  const exData     = getExData(ex.id);
  const isExpanded = S.expanded === ex.id;
  const allDone    = exData?.sets?.every(s => s.completed) || false;
  const anyDone    = exData?.sets?.some(s => s.completed) || false;

  const dotClass   = allDone ? 'done' : (isExpanded || anyDone) ? 'active' : '';
  const dotContent = allDone ? '✓' : anyDone ? `${exData.sets.filter(s=>s.completed).length}` : '';

  const firstW  = exData?.sets?.[0]?.weight;
  const wtLabel = isBW(ex) ? 'BW' : (firstW !== undefined ? `${firstW}kg` : `${ex.startWeight}kg`);

  return `
    <div class="card ${allDone ? 'completed' : ''} ${isExpanded ? 'expanded' : ''}" id="card-${ex.id}">
      <div class="exercise-card-header" onclick="toggleEx('${ex.id}')">
        <div class="exercise-status-dot ${dotClass}">${dotContent}</div>
        <div class="exercise-card-info">
          <div class="exercise-card-name">${escHtml(ex.name)}</div>
          <div class="exercise-card-meta">
            <span class="meta-pill">${ex.sets} × ${repsDisplay(ex)}</span>
            <span class="meta-pill ${isExpanded ? 'accent' : ''}">${wtLabel}</span>
            ${ex.isCompound ? '<span class="meta-pill accent">Compound</span>' : ''}
          </div>
        </div>
        <span class="exercise-chevron">▼</span>
      </div>
      ${isExpanded ? renderExDetail(ex, exData) : ''}
    </div>`;
}

function renderExDetail(ex, exData) {
  if (!exData) return '';

  const lastEx    = lastExData(ex.id);
  const lastSets  = lastEx?.sets?.filter(s => s.completed) || [];
  const lastText  = lastSets.length
    ? lastSets.map(s => isBW(ex) ? `${s.reps}` : `${s.weight}kg×${s.reps}`).join(', ')
    : null;

  const pr       = getPR(ex.id);
  const prText   = pr ? (isBW(ex) ? `${pr.reps} reps` : `${pr.weight}kg × ${pr.reps}`) : null;

  const allDone  = exData.sets.every(s => s.completed);
  const showRPE  = ex.isCompound && allDone;

  return `
    <div class="exercise-detail">
      ${ex.notes ? `<div class="exercise-notes">${escHtml(ex.notes)}</div>` : ''}
      ${lastText ? `
        <div class="last-workout-line">
          <span>Last:</span>
          <strong>${escHtml(lastText)}</strong>
        </div>` : ''}
      ${prText ? `
        <div class="last-workout-line">
          <span>PR:</span>
          <strong>${escHtml(prText)}</strong>
          ${pr?.date ? `<span style="color:var(--text-dim);font-size:11px;">(${fmtDateShort(pr.date)})</span>` : ''}
        </div>` : ''}

      <div class="sets-list">
        ${exData.sets.map((set, i) => renderSetRow(ex, set, i)).join('')}
      </div>

      ${showRPE ? renderRPESection(ex.id, exData.rpe) : ''}
    </div>`;
}

function renderSetRow(ex, set, i) {
  const bw  = isBW(ex);
  const inc = increment(ex);
  const isPR = !set.completed && !bw &&
    isNewPR(ex.id, set.weight, set.reps);

  return `
    <div class="set-row ${set.completed ? 'completed' : ''}">
      <span class="set-number">Set ${i+1}</span>

      ${bw
        ? `<span class="bw-label">BW</span>`
        : `<div class="input-group">
            <button class="adj-btn" onclick="adjustWeight('${ex.id}',${i},${-inc})"
                    ${set.completed ? 'disabled' : ''}>−</button>
            <input class="set-input" type="number" inputmode="decimal"
                   data-weight="${ex.id}-${i}"
                   value="${set.weight}" step="${inc}" min="0"
                   onblur="onWeightBlur('${ex.id}',${i},this.value)"
                   ${set.completed ? 'disabled' : ''}>
            <button class="adj-btn" onclick="adjustWeight('${ex.id}',${i},${inc})"
                    ${set.completed ? 'disabled' : ''}>+</button>
          </div>
          <span class="input-unit">kg</span>`
      }

      <div class="input-group">
        <button class="adj-btn" onclick="adjustReps('${ex.id}',${i},-1)"
                ${set.completed ? 'disabled' : ''}>−</button>
        <input class="set-input" type="number" inputmode="numeric"
               data-reps="${ex.id}-${i}"
               value="${set.reps}" min="0"
               onblur="onRepsBlur('${ex.id}',${i},this.value)"
               ${set.completed ? 'disabled' : ''}>
        <button class="adj-btn" onclick="adjustReps('${ex.id}',${i},1)"
                ${set.completed ? 'disabled' : ''}>+</button>
      </div>
      <span class="input-unit">${isAMRAP(ex) ? 'reps' : 'reps'}</span>

      ${isPR ? '<span class="pr-badge">🏆 PR</span>' : ''}

      <button class="complete-btn ${set.completed ? 'done' : ''}"
              onclick="${set.completed ? '' : `completeSet('${ex.id}',${i})`}"
              ${set.completed ? 'disabled' : ''}>✓</button>
    </div>`;
}

function renderRPESection(exId, currentRPE) {
  if (currentRPE !== null && currentRPE !== undefined) {
    return `<div class="rpe-logged" style="margin-top:14px;">
      RPE logged: <strong>${currentRPE}</strong> / 10
      <button onclick="clearRPE('${exId}')" style="background:none;border:none;color:var(--text-dim);font-size:12px;cursor:pointer;margin-left:8px;">edit</button>
    </div>`;
  }
  return `
    <div class="rpe-section">
      <div class="rpe-label">Rate of Perceived Exertion</div>
      <div class="rpe-buttons">
        ${[6,7,8,9,10].map(r => `
          <button class="rpe-btn rpe-${r} ${currentRPE === r ? 'selected' : ''}"
                  onclick="logRPE('${exId}',${r})">${r}</button>`).join('')}
      </div>
      <div class="rpe-scale"><span>Light</span><span>Max</span></div>
    </div>`;
}

function clearRPE(exId) {
  const ex = getExData(exId);
  if (ex) { ex.rpe = null; saveCurrent(); render(); }
}

function toggleEx(exId) {
  S.expanded = S.expanded === exId ? null : exId;
  render();
  if (S.expanded) {
    requestAnimationFrame(() => {
      const card = document.getElementById(`card-${exId}`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

// ============================================================
//  GUIDED WORKOUT MODE
// ============================================================
function getGuidedExerciseList(workout) {
  // Flatten exercises, grouping supersets as pairs
  const list = [];
  const seen = new Set();
  for (const ex of workout.exercises) {
    if (seen.has(ex.id)) continue;
    if (ex.supersetWith) {
      const partner = workout.exercises.find(e => e.id === ex.supersetWith);
      if (partner && !seen.has(partner.id)) {
        list.push({ type: 'superset', exercises: [ex, partner] });
        seen.add(ex.id);
        seen.add(partner.id);
        continue;
      }
    }
    list.push({ type: 'single', exercises: [ex] });
    seen.add(ex.id);
  }
  return list;
}

function renderGuidedMode(type, workout) {
  const exList = getGuidedExerciseList(workout);
  const total = exList.length;
  const idx = Math.min(S.guidedIdx, total - 1);
  const group = exList[idx];
  
  // Determine current exercise
  const isSuperset = group.type === 'superset';
  const curExIdx = isSuperset ? S.guidedSuperset : 0;
  const ex = group.exercises[curExIdx];
  const exData = getExData(ex.id);
  
  // Calculate overall progress
  const { done: exDone, total: exTotal } = getProgress();
  
  // Current set info
  const completedSets = exData ? exData.sets.filter(s => s.completed).length : 0;
  const totalSets = ex.sets;
  const currentSetIdx = Math.min(completedSets, totalSets - 1);
  const allSetsDone = completedSets >= totalSets;
  
  // Check if this exercise group is fully done
  const groupDone = group.exercises.every(e => {
    const d = getExData(e.id);
    return d && d.sets.every(s => s.completed);
  });
  
  // Last workout data
  const lastEx = lastExData(ex.id);
  const lastSets = lastEx?.sets?.filter(s => s.completed) || [];
  const lastText = lastSets.length
    ? lastSets.map(s => isBW(ex) ? `${s.reps}` : `${s.weight}×${s.reps}`).join(', ')
    : null;
    
  // Show RPE prompt?
  const showRPE = ex.isCompound && allSetsDone && exData && exData.rpe === null;

  return `
    <div class="guided-container">
      <!-- Progress bar -->
      <div class="guided-progress">
        <div class="guided-progress-dots">
          ${exList.map((g, i) => {
            const gDone = g.exercises.every(e => {
              const d = getExData(e.id);
              return d && d.sets.every(s => s.completed);
            });
            return `<div class="guided-dot ${i === idx ? 'current' : ''} ${gDone ? 'done' : ''} ${i < idx ? 'past' : ''}" 
                         onclick="guidedGoTo(${i})"></div>`;
          }).join('')}
        </div>
        <div class="guided-progress-text">Exercise ${idx + 1} of ${total}</div>
      </div>

      <!-- Exercise header -->
      <div class="guided-header">
        ${isSuperset ? `<div class="guided-superset-badge">⚡ SUPERSET ${curExIdx + 1}/2</div>` : ''}
        <h2 class="guided-exercise-name">${escHtml(ex.name)}</h2>
        <div class="guided-meta">
          <span class="meta-pill accent">${ex.sets} × ${repsDisplay(ex)}</span>
          ${!isBW(ex) ? `<span class="meta-pill">${exData?.sets?.[0]?.weight || ex.startWeight}kg</span>` : `<span class="meta-pill">BW</span>`}
          ${ex.isCompound ? '<span class="meta-pill accent">Compound</span>' : ''}
        </div>
        ${ex.notes ? `<div class="guided-notes">${escHtml(ex.notes)}</div>` : ''}
        ${lastText ? `<div class="guided-last">Last: ${escHtml(lastText)}</div>` : ''}
      </div>

      <!-- Sets -->
      <div class="guided-sets">
        ${exData ? exData.sets.map((set, i) => renderGuidedSetRow(ex, set, i, currentSetIdx, allSetsDone)).join('') : ''}
      </div>

      ${showRPE ? `
        <div class="guided-rpe">
          <div class="rpe-label">How hard was that?</div>
          <div class="rpe-buttons">
            ${[6,7,8,9,10].map(r => `
              <button class="rpe-btn rpe-${r}" onclick="guidedLogRPE('${ex.id}',${r})">${r}</button>`).join('')}
          </div>
          <div class="rpe-scale"><span>Light</span><span>Max</span></div>
        </div>` : ''}

      ${groupDone && !showRPE ? `
        <div class="guided-done-msg">
          <span>✅</span> ${isSuperset ? 'Superset' : 'Exercise'} complete!
        </div>` : ''}

      <!-- Bottom action area -->
      <div class="guided-actions">
        ${!allSetsDone && !showRPE ? `
          <button class="btn btn-primary guided-complete-btn" 
                  onclick="guidedCompleteSet('${ex.id}', ${currentSetIdx})">
            Complete Set ${currentSetIdx + 1}
          </button>` : ''}
        
        ${groupDone && !showRPE ? `
          ${idx < total - 1 ? `
            <button class="btn btn-primary guided-complete-btn" onclick="guidedNext()">
              Next Exercise →
            </button>` : `
            <button class="btn btn-success guided-complete-btn" onclick="finishWorkout()">
              🏁 Finish Workout
            </button>`}` : ''}
        
        <div class="guided-nav">
          <button class="guided-nav-btn" onclick="guidedPrev()" ${idx === 0 ? 'disabled' : ''}>← Prev</button>
          <button class="guided-nav-btn" onclick="guidedShowList()">☰ List</button>
          <button class="guided-nav-btn" onclick="guidedNext()" ${idx >= total - 1 ? 'disabled' : ''}>Next →</button>
        </div>
      </div>
    </div>`;
}

function renderGuidedSetRow(ex, set, i, currentSetIdx, allSetsDone) {
  const bw = isBW(ex);
  const inc = increment(ex);
  const isCurrent = !allSetsDone && i === currentSetIdx;
  
  return `
    <div class="guided-set-row ${set.completed ? 'completed' : ''} ${isCurrent ? 'current' : ''} ${!set.completed && i > currentSetIdx ? 'upcoming' : ''}">
      <span class="set-number">Set ${i + 1}</span>
      ${bw
        ? `<span class="bw-label">BW</span>`
        : `<div class="input-group">
            <button class="adj-btn" onclick="adjustWeight('${ex.id}',${i},${-inc})" ${set.completed ? 'disabled' : ''}>−</button>
            <input class="set-input" type="number" inputmode="decimal"
                   data-weight="${ex.id}-${i}" value="${set.weight}" step="${inc}" min="0"
                   onblur="onWeightBlur('${ex.id}',${i},this.value)" ${set.completed ? 'disabled' : ''}>
            <button class="adj-btn" onclick="adjustWeight('${ex.id}',${i},${inc})" ${set.completed ? 'disabled' : ''}>+</button>
          </div>`
      }
      <div class="input-group">
        <button class="adj-btn" onclick="adjustReps('${ex.id}',${i},-1)" ${set.completed ? 'disabled' : ''}>−</button>
        <input class="set-input" type="number" inputmode="numeric"
               data-reps="${ex.id}-${i}" value="${set.reps}" min="0"
               onblur="onRepsBlur('${ex.id}',${i},this.value)" ${set.completed ? 'disabled' : ''}>
        <button class="adj-btn" onclick="adjustReps('${ex.id}',${i},1)" ${set.completed ? 'disabled' : ''}>+</button>
      </div>
      <div class="guided-set-status">
        ${set.completed ? '<span class="guided-check">✓</span>' : isCurrent ? '<span class="guided-arrow">→</span>' : ''}
      </div>
    </div>`;
}

function guidedCompleteSet(exId, setIdx) {
  const ex = getExData(exId);
  if (!ex) return;
  
  // Read current input values
  const wInput = document.querySelector(`[data-weight="${exId}-${setIdx}"]`);
  const rInput = document.querySelector(`[data-reps="${exId}-${setIdx}"]`);
  if (wInput) ex.sets[setIdx].weight = parseFloat(wInput.value) || 0;
  if (rInput) ex.sets[setIdx].reps = parseInt(rInput.value) || 0;
  
  ex.sets[setIdx].completed = true;
  
  const programEx = findProgramEx(exId);
  const isLast = setIdx >= ex.sets.length - 1;
  
  // Pre-fill next set with same weight
  if (!isLast) {
    ex.sets[setIdx + 1].weight = ex.sets[setIdx].weight;
    if (!isAMRAP(programEx)) ex.sets[setIdx + 1].reps = ex.sets[setIdx].reps;
  }
  
  saveCurrent();
  
  // Get workout and exercise list for superset logic
  const workout = S.program.workouts[S.current.type];
  const exList = getGuidedExerciseList(workout);
  const group = exList[S.guidedIdx];
  const isSuperset = group.type === 'superset';
  
  if (isSuperset && !isLast) {
    // In superset: alternate to partner exercise
    const partnerIdx = S.guidedSuperset === 0 ? 1 : 0;
    const partner = group.exercises[partnerIdx];
    const partnerData = getExData(partner.id);
    const partnerCompletedSets = partnerData ? partnerData.sets.filter(s => s.completed).length : 0;
    const partnerTotalSets = partner.sets;
    
    if (partnerCompletedSets < partnerTotalSets) {
      // Switch to partner after short rest
      startTimer(
        15, // short rest between superset exercises
        `${partner.name} — Set ${partnerCompletedSets + 1}`,
        () => { S.guidedSuperset = partnerIdx; render(); }
      );
      return;
    }
  }
  
  if (isSuperset && isLast) {
    // Check if partner still has sets
    const partnerIdx = S.guidedSuperset === 0 ? 1 : 0;
    const partner = group.exercises[partnerIdx];
    const partnerData = getExData(partner.id);
    const partnerDone = partnerData && partnerData.sets.every(s => s.completed);
    
    if (!partnerDone) {
      // Full rest, then switch to partner
      startTimer(
        programEx?.restSeconds || 75,
        `${partner.name}`,
        () => { S.guidedSuperset = partnerIdx; render(); }
      );
      return;
    }
  }
  
  if (!isLast) {
    // Normal rest between sets
    startTimer(
      programEx?.restSeconds || 90,
      `${programEx?.name} — Set ${setIdx + 2}`,
      () => render()
    );
  } else {
    // Last set done — show RPE if compound, otherwise just render
    render();
  }
}

function guidedLogRPE(exId, rpeValue) {
  const ex = getExData(exId);
  if (ex) {
    ex.rpe = rpeValue;
    saveCurrent();
    showToast(`RPE ${rpeValue} logged`);
    
    // Auto-advance to next exercise after a moment
    setTimeout(() => {
      const workout = S.program.workouts[S.current.type];
      const exList = getGuidedExerciseList(workout);
      if (S.guidedIdx < exList.length - 1) {
        guidedNext();
      } else {
        render();
      }
    }, 500);
  }
}

function guidedNext() {
  const workout = S.program.workouts[S.current.type];
  const exList = getGuidedExerciseList(workout);
  if (S.guidedIdx < exList.length - 1) {
    S.guidedIdx++;
    S.guidedSuperset = 0;
    render();
    window.scrollTo(0, 0);
  }
}

function guidedPrev() {
  if (S.guidedIdx > 0) {
    S.guidedIdx--;
    S.guidedSuperset = 0;
    render();
    window.scrollTo(0, 0);
  }
}

function guidedGoTo(idx) {
  S.guidedIdx = idx;
  S.guidedSuperset = 0;
  render();
  window.scrollTo(0, 0);
}

function guidedShowList() {
  S.guided = false;
  render();
}

// Re-enter guided mode from list view
function enterGuided() {
  S.guided = true;
  render();
}

// ============================================================
//  HISTORY VIEW
// ============================================================
function renderHistory() {
  const app = document.getElementById('app');
  
  // Build calendar data for current month
  const now = new Date();
  const calMonth = S.calMonth !== undefined ? S.calMonth : now.getMonth();
  const calYear = S.calYear !== undefined ? S.calYear : now.getFullYear();
  const monthName = new Date(calYear, calMonth, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  
  // Build log lookup by date
  const logsByDate = {};
  for (const log of S.logs) {
    if (!logsByDate[log.date]) logsByDate[log.date] = [];
    logsByDate[log.date].push(log);
  }
  
  // Calendar grid
  const firstDay = new Date(calYear, calMonth, 1);
  const startDow = (firstDay.getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const todayDate = todayStr();
  
  const calCells = [];
  for (let i = 0; i < startDow; i++) calCells.push(null); // leading blanks
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${pad(calMonth + 1)}-${pad(d)}`;
    const dayLogs = logsByDate[dateStr] || [];
    const totalMin = dayLogs.reduce((sum, l) => {
      if (l.startTime && l.endTime) return sum + Math.round((new Date(l.endTime) - new Date(l.startTime)) / 60000);
      return sum;
    }, 0);
    const isToday = dateStr === todayDate;
    calCells.push({ day: d, dateStr, logs: dayLogs, totalMin, isToday });
  }
  
  // Past workouts list (reverse chronological)
  const pastList = [...S.logs].reverse();
  
  app.innerHTML = `
    <div class="page-header" style="padding-bottom:8px;">
      <h1>Log</h1>
    </div>
    
    <!-- Calendar -->
    <div class="cal-section">
      <div class="cal-header">
        <span class="cal-title">Calendar</span>
        <div class="cal-nav">
          <button class="cal-nav-btn" onclick="calPrev()">‹</button>
          <span class="cal-month">${monthName}</span>
          <button class="cal-nav-btn" onclick="calNext()">›</button>
        </div>
      </div>
      <div class="cal-grid">
        <div class="cal-dow">Mo</div><div class="cal-dow">Tu</div><div class="cal-dow">We</div>
        <div class="cal-dow">Th</div><div class="cal-dow">Fr</div><div class="cal-dow">Sa</div><div class="cal-dow">Su</div>
        ${calCells.map(cell => {
          if (!cell) return '<div class="cal-cell empty"></div>';
          const hasWorkout = cell.logs.length > 0;
          return `
            <div class="cal-cell ${hasWorkout ? 'worked' : ''} ${cell.isToday ? 'today' : ''}">
              <span class="cal-day-num">${cell.day}</span>
              ${hasWorkout ? `<span class="cal-duration">${cell.totalMin}m</span>` : ''}
            </div>`;
        }).join('')}
      </div>
    </div>
    
    <!-- Past Workouts -->
    <div class="past-section">
      <div class="past-header">
        <span class="past-title">Past Workouts</span>
      </div>
      ${pastList.length === 0
        ? `<div class="empty-state">
             <span class="empty-icon">📋</span>
             No workouts yet. Complete your first session!
           </div>`
        : pastList.map(log => renderHistEntry(log)).join('')
      }
    </div>`;
}

function calPrev() {
  if (S.calMonth === undefined) { const n = new Date(); S.calMonth = n.getMonth(); S.calYear = n.getFullYear(); }
  S.calMonth--;
  if (S.calMonth < 0) { S.calMonth = 11; S.calYear--; }
  render();
}
function calNext() {
  if (S.calMonth === undefined) { const n = new Date(); S.calMonth = n.getMonth(); S.calYear = n.getFullYear(); }
  S.calMonth++;
  if (S.calMonth > 11) { S.calMonth = 0; S.calYear++; }
  render();
}

function renderHistEntry(log) {
  const isExp    = S.expandedLog === log.id;
  const vol      = calcVolume(log);
  const sets     = calcTotalSets(log);
  const typeIcon = { push: '💪', pull: '🦾', legs: '🦵', 'run-z2': '🏃', 'run-intervals': '⚡' }[log.type] || '🏋️';
  const dur      = log.endTime ? fmtDuration(log.startTime, log.endTime) : '—';
  const typeName = log.kind === 'run' 
    ? (log.runType === 'intervals' ? 'Interval Run' : 'Zone 2 Run')
    : (S.program.workouts[log.type]?.name) || log.type;
  const isRun = log.kind === 'run';
  
  // Date label
  const logDate = log.date === todayStr() ? 'TODAY' : fmtDateShort(log.date).toUpperCase();

  return `
    <div class="hist-card" onclick="toggleHistEntry('${log.id}')">
      <div class="hist-card-date">
        <span class="hist-date-dot ${isRun ? 'run' : ''}"></span>
        <span>${logDate}</span>
        <span class="hist-card-dur">${dur}</span>
      </div>
      <div class="hist-card-body">
        <div class="hist-card-title">
          <span class="hist-card-icon">${typeIcon}</span>
          <span>${escHtml(typeName)}</span>
        </div>
        <div class="hist-card-stats">
          ${!isRun ? `
            <div class="hist-stat">
              <div class="hist-stat-val">${sets}</div>
              <div class="hist-stat-label">SETS</div>
            </div>
            ${vol > 0 ? `
            <div class="hist-stat">
              <div class="hist-stat-val">${(vol/1000).toFixed(1)}t</div>
              <div class="hist-stat-label">VOLUME</div>
            </div>` : ''}
            <div class="hist-stat">
              <div class="hist-stat-val">${(log.exercises || []).filter(e => e.sets?.some(s => s.completed)).length}</div>
              <div class="hist-stat-label">EXERCISES</div>
            </div>` : `
            <div class="hist-stat">
              <div class="hist-stat-val">${log.runType === 'z2' ? 'Zone 2' : 'Intervals'}</div>
              <div class="hist-stat-label">TYPE</div>
            </div>`}
        </div>
      </div>
      ${isExp ? renderHistDetail(log) : ''}
    </div>`;
}

function renderHistDetail(log) {
  return `
    <div class="history-detail">
      ${(log.exercises || []).map(ex => {
        const progEx = findProgramEx(ex.exerciseId);
        const done   = (ex.sets || []).filter(s => s.completed);
        if (!done.length) return '';
        const bw = progEx ? isBW(progEx) : false;
        const setsStr = done.map(s => bw ? `${s.reps}` : `${s.weight}kg×${s.reps}`).join(' · ');
        return `
          <div class="history-ex-row">
            <div>
              <div class="history-ex-name">${progEx?.name || ex.exerciseId}</div>
              <div class="history-ex-sets">${setsStr}${ex.rpe ? ` · RPE ${ex.rpe}` : ''}</div>
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

function toggleHistEntry(id) {
  S.expandedLog = S.expandedLog === id ? null : id;
  render();
}

function setHistFilter(f) {
  S.histFilter = f;
  render();
}

// ============================================================
//  STATS VIEW
// ============================================================
function renderStats() {
  const app   = document.getElementById('app');
  const allEx = getAllExercises();
  const exIds = Object.keys(allEx);

  // Weekly volume
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekLogs = S.logs.filter(l => new Date(l.date + 'T12:00:00') >= weekAgo);
  const weekVol  = weekLogs.reduce((a, l) => a + calcVolume(l), 0);
  const weekSets = weekLogs.reduce((a, l) => a + calcTotalSets(l), 0);

  // Selected exercise
  if (!S.statsEx || !allEx[S.statsEx]) S.statsEx = exIds[0];
  const selEx    = allEx[S.statsEx];
  const selHist  = getWeightHistory(S.statsEx);
  const selPR    = getPR(S.statsEx);

  app.innerHTML = `
    <div class="page-header">
      <h1>Stats & PRs</h1>
      <p class="subtitle">Personal records and trends</p>
    </div>
    <div class="stats-content">

      <!-- Weekly Summary -->
      <div class="stat-section">
        <div class="stat-section-title">This Week</div>
        <div class="volume-grid">
          <div class="volume-cell">
            <div class="vol-num">${weekLogs.length}</div>
            <div class="vol-label">Sessions</div>
          </div>
          <div class="volume-cell">
            <div class="vol-num">${weekSets}</div>
            <div class="vol-label">Total Sets</div>
          </div>
          <div class="volume-cell">
            <div class="vol-num">${weekVol > 0 ? (weekVol/1000).toFixed(1) + 't' : '0'}</div>
            <div class="vol-label">Volume</div>
          </div>
        </div>
      </div>

      <!-- Progression Chart -->
      <div class="stat-section">
        <div class="stat-section-title">Weight Progression</div>
        <div class="exercise-picker">
          ${exIds.map(id => `
            <button class="picker-btn ${S.statsEx === id ? 'active' : ''}"
                    onclick="setStatsEx('${id}')">
              ${escHtml(allEx[id].name)}
            </button>`).join('')}
        </div>
        ${selEx ? `
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">
            <strong style="color:var(--text);">${escHtml(selEx.name)}</strong>
            ${selPR ? ` · PR: <strong style="color:var(--accent-light);">${isBW(selEx) ? selPR.reps + ' reps' : selPR.weight + 'kg × ' + selPR.reps}</strong>` : ''}
          </div>` : ''}
        ${selHist.length >= 2
          ? `<div class="chart-container"><canvas id="chart-main"></canvas></div>`
          : `<div class="chart-empty">Log at least 2 sessions to see progression</div>`}
      </div>

      <!-- All PRs -->
      <div class="stat-section">
        <div class="stat-section-title">Personal Records</div>
        <div class="pr-grid">
          ${exIds.map(id => {
            const ex  = allEx[id];
            const pr  = getPR(id);
            return `
              <div class="pr-row">
                <span class="pr-ex-name">${escHtml(ex.name)}</span>
                ${pr
                  ? `<span class="pr-value gold">${isBW(ex) ? pr.reps + ' reps' : pr.weight + 'kg × ' + pr.reps}</span>`
                  : `<span class="pr-none">No data</span>`}
              </div>`;
          }).join('')}
        </div>
      </div>

    </div>`;

  // Draw chart after DOM is ready
  if (selHist.length >= 2) {
    requestAnimationFrame(() => {
      const canvas = document.getElementById('chart-main');
      if (canvas) {
        canvas.width  = canvas.offsetWidth * window.devicePixelRatio;
        canvas.height = canvas.offsetHeight * window.devicePixelRatio;
        const ctx = canvas.getContext('2d');
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        drawChart(ctx, selHist, canvas.offsetWidth, canvas.offsetHeight, isBW(selEx));
      }
    });
  }
}

function setStatsEx(id) {
  S.statsEx = id;
  renderStats();
}

function drawChart(ctx, data, W, H, bwMode) {
  const pad  = { top: 20, right: 16, bottom: 32, left: bwMode ? 32 : 42 };
  const vals = data.map(d => bwMode ? d.reps : d.weight);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const rng  = maxV - minV || 5;
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top  - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  for (let g = 0; g <= 4; g++) {
    const y = pad.top + innerH * (g / 4);
    const v = maxV - (rng * g / 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    // Label
    ctx.fillStyle  = 'rgba(255,255,255,0.3)';
    ctx.font       = `11px -apple-system`;
    ctx.textAlign  = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(v), pad.left - 4, y);
  }

  // Points
  const pts = data.map((d, i) => ({
    x: pad.left + (data.length === 1 ? innerW / 2 : innerW * (i / (data.length - 1))),
    y: pad.top  + innerH * (1 - (vals[i] - minV) / rng),
  }));

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
  grad.addColorStop(0,   'rgba(74,144,217,0.35)');
  grad.addColorStop(1,   'rgba(74,144,217,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, H - pad.bottom);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(pts[pts.length - 1].x, H - pad.bottom);
  ctx.closePath();
  ctx.fill();

  // Line
  ctx.strokeStyle = '#4A90D9';
  ctx.lineWidth   = 2.5;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.stroke();

  // Dots + hover labels
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle   = '#4A90D9';
    ctx.fill();
    ctx.strokeStyle = '#0F0F0F';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Value label above dot
    ctx.fillStyle    = 'rgba(255,255,255,0.7)';
    ctx.font         = 'bold 11px -apple-system';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(vals[i] + (bwMode ? '' : 'kg'), p.x, p.y - 7);
  });

  // X-axis dates
  ctx.fillStyle    = 'rgba(255,255,255,0.3)';
  ctx.font         = '10px -apple-system';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  pts.forEach((p, i) => {
    if (i === 0 || i === pts.length - 1 || (pts.length > 5 && i === Math.floor(pts.length / 2))) {
      const d = new Date(data[i].date + 'T12:00:00');
      ctx.fillText(`${d.getDate()}/${d.getMonth()+1}`, p.x, H - pad.bottom + 5);
    }
  });
}

// ============================================================
//  UTILITIES
// ============================================================
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// Export workout logs as JSON file
function exportLogs() {
  const data = JSON.stringify({ workoutLogs: S.logs }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `peter-training-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
//  BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', init);
