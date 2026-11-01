// ============================================================================
// PALESTRA — Gestione Allenamenti, Circuiti, Timer & Progressi (1RM)
// Ottimizzata per Samsung S25 Ultra (Offline-first LocalStorage + Web Audio + WakeLock)
// ============================================================================

const STORAGE_KEY = 'palestra_app_data_v2';

const DEFAULT_EXERCISES = [];

const DEFAULT_WORKOUTS = [];

// Calcolo 1RM stimato (Formula di Epley + Brzycki blend per alta accuratezza su basse rep)
// Rende confrontabili carichi diversi (es. 100kg x 4 vs 120kg x 3)
function calculateEffectiveLoad(weight, reps) {
  const w = parseFloat(weight) || 0;
  const r = parseInt(reps, 10) || 0;
  if (w <= 0 || r <= 0) return 0;
  if (r === 1) return Math.round(w * 10) / 10;
  // Formula di Epley: W * (1 + r / 30)
  // Es. 100kg x 4 -> 113.3 kg | 120kg x 3 -> 132.0 kg
  const epley = w * (1 + r / 30);
  return Math.round(epley * 10) / 10;
}

function formatSeconds(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function formatDurationClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function formatDurationVerbose(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (hrs > 0) {
    return `${hrs}h ${mins}m ${rem}s`;
  }
  if (mins > 0) {
    return `${mins} min ${rem} sec`;
  }
  return `${rem} sec`;
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ============================================================================
// SISTEMA AUDIO & VIBRAZIONE (Web Audio API per cue precisi)
// - Inizio esercizio: 3 beep nei 3s finali + 1 beep di AVVIO diverso (più acuto)
// - Fine esercizio a tempo: 2 beep nei 2s finali + 1 beep FINALE diverso (doppio tono)
// ============================================================================
const SoundEngine = {
  ctx: null,
  enabled: true,
  vibrationEnabled: true,

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  },

  tone(freq, durationMs, type = 'sine', gainVal = 0.25, delayMs = 0) {
    if (!this.enabled) return;
    try {
      this.init();
      if (!this.ctx) return;
      const start = this.ctx.currentTime + delayMs / 1000;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(gainVal, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + durationMs / 1000);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(start);
      osc.stop(start + durationMs / 1000);
    } catch (e) {
      // Ignore audio errors if blocked
    }
  },

  vibrate(pattern) {
    if (this.vibrationEnabled && navigator.vibrate) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {}
    }
  },

  // Beep singolo di preparazione (usato per i 3 beep prima dell'inizio o 2 beep prima della fine)
  playCountdownPip() {
    this.tone(660, 110, 'sine', 0.22);
    this.vibrate(60);
  },

  // Beep di AVVIO ESERCIZIO (diverso dagli altri: tono alto energico 1046Hz C6)
  playStartCue() {
    this.tone(1046.5, 340, 'triangle', 0.35);
    this.vibrate([180]);
  },

  // Beep di FINE ESERCIZIO (diverso dagli altri: accordo discendente 880Hz -> 587Hz)
  playFinishCue() {
    this.tone(880, 160, 'triangle', 0.3, 0);
    this.tone(587.3, 320, 'triangle', 0.35, 170);
    this.vibrate([140, 80, 220]);
  }
};

// ============================================================================
// WAKE LOCK (Mantiene lo schermo acceso su S25 Ultra durante l'allenamento)
// ============================================================================
const WakeLockManager = {
  sentinel: null,
  async request() {
    if ('wakeLock' in navigator) {
      try {
        this.sentinel = await navigator.wakeLock.request('screen');
      } catch (e) {}
    }
  },
  async release() {
    if (this.sentinel) {
      try {
        await this.sentinel.release();
        this.sentinel = null;
      } catch (e) {}
    }
  }
};

// ============================================================================
// APPLICAZIONE PRINCIPALE
// ============================================================================
const App = {
  state: {
    exercises: [],
    workouts: [],
    logs: [], // { id, exerciseId, workoutId, dateISO, weight, reps, effective1RM, setNumber }
    settings: {
      sound: true,
      vibration: true,
      wakeLock: true
    }
  },
  currentTab: 'workouts',
  editingWorkout: null, // Oggetto temporaneo durante la creazione/modifica scheda
  selectedProgressExerciseId: null,
  live: null, // Stato dell'allenamento live in corso
  liveInterval: null,

  init() {
    this.loadData();
    this.render();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.live && this.state.settings.wakeLock) {
        WakeLockManager.request();
      }
    });
  },

  loadData() {
    try {
      // Rimuove eventuali dati demo della versione precedente
      localStorage.removeItem('palestra_app_data_v1');
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.state.exercises = parsed.exercises || [];
        this.state.workouts = parsed.workouts || [];
        this.state.logs = parsed.logs || [];
        this.state.settings = { ...this.state.settings, ...(parsed.settings || {}) };
      } else {
        this.state.exercises = [];
        this.state.workouts = [];
        this.state.logs = [];
        this.saveData();
      }
    } catch (e) {
      this.state.exercises = [];
      this.state.workouts = [];
      this.state.logs = [];
    }
    SoundEngine.enabled = this.state.settings.sound;
    SoundEngine.vibrationEnabled = this.state.settings.vibration;
  },

  saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  },

  getExerciseById(id) {
    return this.state.exercises.find((e) => e.id === id) || { id, name: 'Esercizio rimosso', category: 'Altro' };
  },

  toast(msg) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 2600);
  },

  switchTab(tab) {
    this.editingWorkout = null;
    this.currentTab = tab;
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    this.render();
  },

  render() {
    const titleEl = document.getElementById('header-title');
    const actionsEl = document.getElementById('header-actions');
    const container = document.getElementById('view-container');

    actionsEl.innerHTML = '';

    if (this.editingWorkout) {
      titleEl.textContent = this.editingWorkout.isNew ? 'Nuova Scheda' : 'Modifica Scheda';
      actionsEl.innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="App.cancelEditWorkout()">Annulla</button>
        <button class="btn btn-primary btn-sm" onclick="App.saveEditedWorkout()">Salva</button>
      `;
      container.innerHTML = this.renderWorkoutBuilder();
      return;
    }

    if (this.currentTab === 'workouts') {
      titleEl.textContent = 'I Miei Allenamenti';
      actionsEl.innerHTML = `
        <button class="btn btn-primary btn-sm" onclick="App.startNewWorkout()">+ Nuova Scheda</button>
      `;
      container.innerHTML = this.renderWorkoutsTab();
    } else if (this.currentTab === 'progress') {
      titleEl.textContent = 'Progressi & Carichi';
      container.innerHTML = this.renderProgressTab();
    } else if (this.currentTab === 'exercises') {
      titleEl.textContent = 'Libreria Esercizi';
      actionsEl.innerHTML = `
        <button class="btn btn-primary btn-sm" onclick="App.openAddExerciseModal()">+ Esercizio</button>
      `;
      container.innerHTML = this.renderExercisesTab();
    } else if (this.currentTab === 'settings') {
      titleEl.textContent = 'Impostazioni & Dati';
      container.innerHTML = this.renderSettingsTab();
    }
  },

  // ==========================================================================
  // TAB 1: LISTA SCHEDE DI ALLENAMENTO
  // ==========================================================================
  renderWorkoutsTab() {
    if (this.state.workouts.length === 0) {
      return `
        <div class="empty-state">
          <h3>Nessuna scheda salvata</h3>
          <p>Crea il tuo primo allenamento con esercizi singoli o circuiti.</p>
          <button class="btn btn-primary" onclick="App.startNewWorkout()">Crea Allenamento</button>
        </div>
      `;
    }

    return this.state.workouts
      .map((wk) => {
        const blocksHtml = wk.blocks
          .map((b) => {
            if (b.type === 'single') {
              const ex = this.getExerciseById(b.exerciseId);
              const target =
                b.mode === 'time'
                  ? `${b.sets} x ${b.durationSec}s`
                  : `${b.sets} x ${b.reps} rep ${b.weight > 0 ? `@ ${b.weight}kg` : ''}`;
              return `
                <div class="preview-item">
                  <span><strong>${this.escape(ex.name)}</strong> ${b.askRecordLog ? '<span class="badge badge-accent" style="margin-left:4px">Record</span>' : ''}</span>
                  <span>${target} • rec ${b.restSec}s</span>
                </div>
              `;
            } else {
              const items = b.exercises
                .map((ce) => {
                  const ex = this.getExerciseById(ce.exerciseId);
                  const t = ce.mode === 'time' ? `${ce.durationSec}s` : `${ce.reps} rep ${ce.weight > 0 ? `@ ${ce.weight}kg` : ''}`;
                  return `${this.escape(ex.name)} (${t})`;
                })
                .join(' → ');
              return `
                <div class="circuit-preview-box">
                  <div class="preview-item" style="margin-bottom:3px">
                    <span><strong>🔄 ${this.escape(b.name || 'Circuito')} (${b.rounds} giri)</strong></span>
                    <span>rec ${b.restBetweenExercisesSec}s / giro ${b.restBetweenRoundsSec}s</span>
                  </div>
                  <div style="font-size:0.78rem; color:var(--text-secondary)">${items}</div>
                </div>
              `;
            }
          })
          .join('');

        return `
          <div class="card">
            <div class="card-header">
              <div>
                <div class="card-title">${this.escape(wk.name)}</div>
                ${wk.description ? `<div class="card-subtitle">${this.escape(wk.description)}</div>` : ''}
              </div>
              <div style="display:flex; gap:6px">
                <button class="btn btn-secondary btn-sm" onclick="App.editWorkout('${wk.id}')">Modifica</button>
                <button class="btn btn-ghost btn-sm" onclick="App.deleteWorkout('${wk.id}')" title="Elimina">✕</button>
              </div>
            </div>
            <div class="workout-blocks-preview">
              ${blocksHtml || '<span style="font-size:0.84rem;color:var(--text-muted)">Nessun esercizio</span>'}
            </div>
            <button class="btn btn-primary btn-lg" onclick="App.launchLiveWorkout('${wk.id}')">
              ▶ Avvia Allenamento
            </button>
          </div>
        `;
      })
      .join('');
  },

  // ==========================================================================
  // BUILDER: CREAZIONE E MODIFICA SCHEDA (Esercizi Singoli + Circuiti)
  // ==========================================================================
  startNewWorkout() {
    this.editingWorkout = {
      id: uid('wk'),
      isNew: true,
      name: '',
      description: '',
      blocks: [
        {
          id: uid('blk'),
          type: 'single',
          exerciseId: this.state.exercises[0]?.id || '',
          sets: 3,
          mode: 'reps',
          reps: 5,
          durationSec: 60,
          weight: 60,
          restSec: 90,
          askRecordLog: true
        }
      ]
    };
    this.render();
  },

  editWorkout(id) {
    const found = this.state.workouts.find((w) => w.id === id);
    if (!found) return;
    this.editingWorkout = JSON.parse(JSON.stringify(found));
    this.editingWorkout.isNew = false;
    this.render();
  },

  cancelEditWorkout() {
    this.editingWorkout = null;
    this.render();
  },

  saveEditedWorkout() {
    const wk = this.editingWorkout;
    if (!wk) return;
    const missingEx = wk.blocks.some((b) =>
      b.type === 'single' ? !b.exerciseId : (b.exercises || []).some((ce) => !ce.exerciseId)
    );
    if (missingEx) {
      this.toast('Seleziona o crea un esercizio (+ Nuovo) per ogni blocco prima di salvare');
      return;
    }
    const name = wk.name.trim() || 'Allenamento Senza Nome';
    wk.name = name;
    delete wk.isNew;

    const idx = this.state.workouts.findIndex((w) => w.id === wk.id);
    if (idx >= 0) {
      this.state.workouts[idx] = wk;
    } else {
      this.state.workouts.unshift(wk);
    }
    this.saveData();
    this.editingWorkout = null;
    this.toast('Scheda salvata in locale');
    this.render();
  },

  deleteWorkout(id) {
    if (!confirm('Vuoi eliminare questa scheda di allenamento?')) return;
    this.state.workouts = this.state.workouts.filter((w) => w.id !== id);
    this.saveData();
    this.render();
  },

  addSingleBlock() {
    this.editingWorkout.blocks.push({
      id: uid('blk'),
      type: 'single',
      exerciseId: this.state.exercises[0]?.id || '',
      sets: 3,
      mode: 'reps',
      reps: 8,
      durationSec: 45,
      weight: 40,
      restSec: 90,
      askRecordLog: false
    });
    this.render();
  },

  addCircuitBlock() {
    this.editingWorkout.blocks.push({
      id: uid('blk'),
      type: 'circuit',
      name: 'Circuito',
      rounds: 3,
      restBetweenExercisesSec: 15,
      restBetweenRoundsSec: 60,
      exercises: [
        {
          id: uid('cex'),
          exerciseId: this.state.exercises[0]?.id || '',
          mode: 'time',
          reps: 10,
          durationSec: 45,
          weight: 0,
          askRecordLog: false
        }
      ]
    });
    this.render();
  },

  addExerciseToCircuit(blockIndex) {
    const blk = this.editingWorkout.blocks[blockIndex];
    if (!blk || blk.type !== 'circuit') return;
    blk.exercises.push({
      id: uid('cex'),
      exerciseId: this.state.exercises[0]?.id || '',
      mode: 'reps',
      reps: 10,
      durationSec: 45,
      weight: 0,
      askRecordLog: false
    });
    this.render();
  },

  removeBlock(index) {
    this.editingWorkout.blocks.splice(index, 1);
    this.render();
  },

  moveBlock(index, dir) {
    const target = index + dir;
    const arr = this.editingWorkout.blocks;
    if (target < 0 || target >= arr.length) return;
    const temp = arr[index];
    arr[index] = arr[target];
    arr[target] = temp;
    this.render();
  },

  removeCircuitExercise(blockIndex, exIndex) {
    const blk = this.editingWorkout.blocks[blockIndex];
    if (!blk || blk.exercises.length <= 1) {
      this.toast('Il circuito deve avere almeno un esercizio');
      return;
    }
    blk.exercises.splice(exIndex, 1);
    this.render();
  },

  renderExerciseOptions(selectedId) {
    if (this.state.exercises.length === 0) {
      return `<option value="">-- Crea prima un esercizio (+ Nuovo) --</option>`;
    }
    return this.state.exercises
      .map(
        (ex) =>
          `<option value="${ex.id}" ${ex.id === selectedId ? 'selected' : ''}>${this.escape(ex.name)} (${this.escape(ex.category)})</option>`
      )
      .join('');
  },

  renderWorkoutBuilder() {
    const wk = this.editingWorkout;
    const blocksHtml = wk.blocks
      .map((blk, bIdx) => {
        if (blk.type === 'single') {
          return `
            <div class="builder-block">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px">
                <span class="badge">Esercizio Singolo #${bIdx + 1}</span>
                <div style="display:flex; gap:4px">
                  <button class="btn btn-ghost btn-sm" onclick="App.moveBlock(${bIdx}, -1)">↑</button>
                  <button class="btn btn-ghost btn-sm" onclick="App.moveBlock(${bIdx}, 1)">↓</button>
                  <button class="btn btn-danger btn-sm" onclick="App.removeBlock(${bIdx})">✕</button>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label">Esercizio</label>
                <div style="display:flex; gap:8px">
                  <select class="select" onchange="App.editingWorkout.blocks[${bIdx}].exerciseId = this.value">
                    ${this.renderExerciseOptions(blk.exerciseId)}
                  </select>
                  <button class="btn btn-secondary btn-sm" onclick="App.openAddExerciseModal(${bIdx})">+ Nuovo</button>
                </div>
              </div>

              <div class="grid-3 form-group">
                <div>
                  <label class="form-label">Serie</label>
                  <input type="number" min="1" class="input" value="${blk.sets}"
                    oninput="App.editingWorkout.blocks[${bIdx}].sets = parseInt(this.value)||1" />
                </div>
                <div>
                  <label class="form-label">Tipo Esercizio</label>
                  <select class="select" onchange="App.editingWorkout.blocks[${bIdx}].mode = this.value; App.render()">
                    <option value="reps" ${blk.mode === 'reps' ? 'selected' : ''}>Ripetizioni</option>
                    <option value="time" ${blk.mode === 'time' ? 'selected' : ''}>A Tempo (Timer)</option>
                  </select>
                </div>
                <div>
                  ${
                    blk.mode === 'reps'
                      ? `<label class="form-label">Ripetizioni</label>
                         <input type="number" min="1" class="input" value="${blk.reps}"
                           oninput="App.editingWorkout.blocks[${bIdx}].reps = parseInt(this.value)||1" />`
                      : `<label class="form-label">Durata (sec)</label>
                         <input type="number" min="5" step="5" class="input" value="${blk.durationSec}"
                           oninput="App.editingWorkout.blocks[${bIdx}].durationSec = parseInt(this.value)||10" />`
                  }
                </div>
              </div>

              <div class="grid-2 form-group">
                <div>
                  <label class="form-label">Peso preimpostato (kg)</label>
                  <input type="number" step="0.5" min="0" class="input" value="${blk.weight}"
                    oninput="App.editingWorkout.blocks[${bIdx}].weight = parseFloat(this.value)||0" />
                </div>
                <div>
                  <label class="form-label">Recupero tra serie (sec)</label>
                  <input type="number" step="5" min="0" class="input" value="${blk.restSec}"
                    oninput="App.editingWorkout.blocks[${bIdx}].restSec = parseInt(this.value)||0" />
                </div>
              </div>

              <label class="toggle-row">
                <div class="toggle-info">
                  <span class="toggle-title">Chiedi salvataggio Record a fine serie</span>
                  <span class="toggle-desc">Mostra i 2 tasti (Salva Record / Scarta) con peso e rep modificabili</span>
                </div>
                <input type="checkbox" class="switch-input" ${blk.askRecordLog ? 'checked' : ''}
                  onchange="App.editingWorkout.blocks[${bIdx}].askRecordLog = this.checked" />
              </label>
            </div>
          `;
        } else {
          // Circuito
          const circuitExHtml = blk.exercises
            .map((cex, cIdx) => {
              return `
                <div class="circuit-subitem">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
                    <strong style="font-size:0.84rem; color:var(--accent)">Esercizio ${cIdx + 1} del circuito</strong>
                    <button class="btn btn-ghost btn-sm" onclick="App.removeCircuitExercise(${bIdx}, ${cIdx})">Rimuovi</button>
                  </div>
                  <div class="form-group" style="display:flex; gap:8px">
                    <select class="select" onchange="App.editingWorkout.blocks[${bIdx}].exercises[${cIdx}].exerciseId = this.value">
                      ${this.renderExerciseOptions(cex.exerciseId)}
                    </select>
                    <button class="btn btn-secondary btn-sm" onclick="App.openAddExerciseModal(${bIdx}, ${cIdx})">+ Nuovo</button>
                  </div>
                  <div class="grid-3 form-group">
                    <div>
                      <label class="form-label">Modalità</label>
                      <select class="select" onchange="App.editingWorkout.blocks[${bIdx}].exercises[${cIdx}].mode = this.value; App.render()">
                        <option value="reps" ${cex.mode === 'reps' ? 'selected' : ''}>Ripetizioni</option>
                        <option value="time" ${cex.mode === 'time' ? 'selected' : ''}>A Tempo</option>
                      </select>
                    </div>
                    <div>
                      ${
                        cex.mode === 'reps'
                          ? `<label class="form-label">Ripetizioni</label>
                             <input type="number" min="1" class="input" value="${cex.reps}"
                               oninput="App.editingWorkout.blocks[${bIdx}].exercises[${cIdx}].reps = parseInt(this.value)||1" />`
                          : `<label class="form-label">Durata (sec)</label>
                             <input type="number" min="5" step="5" class="input" value="${cex.durationSec}"
                               oninput="App.editingWorkout.blocks[${bIdx}].exercises[${cIdx}].durationSec = parseInt(this.value)||10" />`
                      }
                    </div>
                    <div>
                      <label class="form-label">Peso (kg)</label>
                      <input type="number" step="0.5" min="0" class="input" value="${cex.weight}"
                        oninput="App.editingWorkout.blocks[${bIdx}].exercises[${cIdx}].weight = parseFloat(this.value)||0" />
                    </div>
                  </div>
                  <label class="toggle-row">
                    <div class="toggle-info">
                      <span class="toggle-title">Chiedi salvataggio Record</span>
                    </div>
                    <input type="checkbox" class="switch-input" ${cex.askRecordLog ? 'checked' : ''}
                      onchange="App.editingWorkout.blocks[${bIdx}].exercises[${cIdx}].askRecordLog = this.checked" />
                  </label>
                </div>
              `;
            })
            .join('');

          return `
            <div class="builder-block circuit-block">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px">
                <span class="badge badge-accent">🔄 Circuito #${bIdx + 1}</span>
                <div style="display:flex; gap:4px">
                  <button class="btn btn-ghost btn-sm" onclick="App.moveBlock(${bIdx}, -1)">↑</button>
                  <button class="btn btn-ghost btn-sm" onclick="App.moveBlock(${bIdx}, 1)">↓</button>
                  <button class="btn btn-danger btn-sm" onclick="App.removeBlock(${bIdx})">✕</button>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label">Nome Circuito</label>
                <input type="text" class="input" value="${this.escape(blk.name || 'Circuito')}"
                  oninput="App.editingWorkout.blocks[${bIdx}].name = this.value" />
              </div>

              <div class="grid-3 form-group">
                <div>
                  <label class="form-label">N° Giri (Round)</label>
                  <input type="number" min="1" class="input" value="${blk.rounds}"
                    oninput="App.editingWorkout.blocks[${bIdx}].rounds = parseInt(this.value)||1" />
                </div>
                <div>
                  <label class="form-label">Rec. tra esercizi (s)</label>
                  <input type="number" min="0" step="5" class="input" value="${blk.restBetweenExercisesSec}"
                    oninput="App.editingWorkout.blocks[${bIdx}].restBetweenExercisesSec = parseInt(this.value)||0" />
                </div>
                <div>
                  <label class="form-label">Rec. fine giro (s)</label>
                  <input type="number" min="0" step="5" class="input" value="${blk.restBetweenRoundsSec}"
                    oninput="App.editingWorkout.blocks[${bIdx}].restBetweenRoundsSec = parseInt(this.value)||0" />
                </div>
              </div>

              ${circuitExHtml}

              <button class="btn btn-secondary btn-sm" style="width:100%; margin-top:10px" onclick="App.addExerciseToCircuit(${bIdx})">
                + Aggiungi esercizio al circuito
              </button>
            </div>
          `;
        }
      })
      .join('');

    return `
      <div class="card">
        <div class="form-group">
          <label class="form-label">Nome della Scheda</label>
          <input type="text" class="input" placeholder="Es. Giorno A — Forza Spinta & Core" value="${this.escape(wk.name)}"
            oninput="App.editingWorkout.name = this.value" />
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label">Note o descrizione (opzionale)</label>
          <input type="text" class="input" placeholder="Es. Focus carichi pesanti + circuito finale" value="${this.escape(wk.description || '')}"
            oninput="App.editingWorkout.description = this.value" />
        </div>
      </div>

      ${blocksHtml}

      <div class="grid-2" style="margin-top:14px; margin-bottom:24px">
        <button class="btn btn-secondary" onclick="App.addSingleBlock()">+ Esercizio Singolo</button>
        <button class="btn btn-secondary" onclick="App.addCircuitBlock()">+ Aggiungi Circuito</button>
      </div>

      <button class="btn btn-primary btn-lg" onclick="App.saveEditedWorkout()">Salva Scheda di Allenamento</button>
    `;
  },

  // ==========================================================================
  // LIVE WORKOUT PLAYER (Timer, Pausa, 3 Beep + Start, 2 Beep + Fine, Log Record)
  // ==========================================================================
  buildWorkoutSteps(workout) {
    const steps = [];
    workout.blocks.forEach((blk) => {
      if (blk.type === 'single') {
        const totalSets = Math.max(1, parseInt(blk.sets, 10) || 1);
        for (let s = 1; s <= totalSets; s++) {
          steps.push({
            exerciseId: blk.exerciseId,
            blockTitle: 'Esercizio Singolo',
            setLabel: `Serie ${s} di ${totalSets}`,
            setNumber: s,
            mode: blk.mode,
            reps: blk.reps,
            durationSec: blk.durationSec,
            weight: blk.weight,
            askRecordLog: !!blk.askRecordLog,
            restAfterSec: blk.restSec,
            restReason: s < totalSets ? `Recupero prima della Serie ${s + 1}` : 'Recupero fine esercizio'
          });
        }
      } else if (blk.type === 'circuit') {
        const rounds = Math.max(1, parseInt(blk.rounds, 10) || 1);
        const exList = blk.exercises || [];
        for (let r = 1; r <= rounds; r++) {
          exList.forEach((cex, idx) => {
            const isLastExInRound = idx === exList.length - 1;
            const isLastRound = r === rounds;
            let restAfter = blk.restBetweenExercisesSec;
            let restReason = 'Recupero cambio esercizio circuito';
            if (isLastExInRound) {
              restAfter = isLastRound ? blk.restBetweenRoundsSec : blk.restBetweenRoundsSec;
              restReason = isLastRound ? 'Fine Circuito' : `Recupero fine Giro ${r} di ${rounds}`;
            }
            steps.push({
              exerciseId: cex.exerciseId,
              blockTitle: `🔄 ${blk.name || 'Circuito'} • Giro ${r}/${rounds}`,
              setLabel: `Esercizio ${idx + 1} di ${exList.length}`,
              setNumber: r,
              mode: cex.mode,
              reps: cex.reps,
              durationSec: cex.durationSec,
              weight: cex.weight,
              askRecordLog: !!cex.askRecordLog,
              restAfterSec: restAfter,
              restReason
            });
          });
        }
      }
    });
    return steps;
  },

  launchLiveWorkout(workoutId) {
    const wk = this.state.workouts.find((w) => w.id === workoutId);
    if (!wk) return;
    const steps = this.buildWorkoutSteps(wk);
    if (steps.length === 0) {
      this.toast('Aggiungi almeno un esercizio alla scheda');
      return;
    }

    SoundEngine.init();
    if (this.state.settings.wakeLock) {
      WakeLockManager.request();
    }

    this.live = {
      workoutId: wk.id,
      workoutName: wk.name,
      steps,
      stepIndex: 0,
      // Fasi: 'PREP' (3s prima di esercizio a tempo), 'WORK_TIME', 'WORK_REPS', 'DECIDE_LOG', 'REST', 'FINISHED'
      phase: 'INIT',
      paused: false,
      remainingSec: 0,
      totalPhaseSec: 0,
      elapsedWorkoutSec: 0,
      lastBeepSecond: null,
      tempWeight: steps[0].weight,
      tempReps: steps[0].reps,
      savedLogsCount: 0
    };

    const overlay = document.getElementById('live-workout-overlay');
    overlay.classList.remove('hidden');

    this.enterStepExecution(0);
    this.startLiveTicker();
  },

  startLiveTicker() {
    if (this.liveInterval) clearInterval(this.liveInterval);
    let lastTick = performance.now();

    this.liveInterval = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;

      if (!this.live || this.live.phase === 'FINISHED') return;

      // Il tempo complessivo della scheda scorre dall'avvio fino al termine (si ferma se l'allenamento è in pausa)
      if (!this.live.paused) {
        this.live.elapsedWorkoutSec += dt;
        this.updateWorkoutElapsedDOM();
      }

      if (this.live.paused) return;

      if (this.live.phase === 'PREP' || this.live.phase === 'WORK_TIME' || this.live.phase === 'REST') {
        this.live.remainingSec -= dt;
        const ceilSec = Math.ceil(this.live.remainingSec);

        // Gestione segnali acustici
        if (ceilSec !== this.live.lastBeepSecond && ceilSec > 0) {
          if (this.live.phase === 'PREP' || this.live.phase === 'REST') {
            // Per iniziare l'esercizio: 3 beep negli ultimi 3 secondi (3, 2, 1)
            if (ceilSec === 3 || ceilSec === 2 || ceilSec === 1) {
              SoundEngine.playCountdownPip();
              this.live.lastBeepSecond = ceilSec;
            }
          } else if (this.live.phase === 'WORK_TIME') {
            // Per finire l'esercizio: 2 beep negli ultimi 2 secondi (2, 1)
            if (ceilSec === 2 || ceilSec === 1) {
              SoundEngine.playCountdownPip();
              this.live.lastBeepSecond = ceilSec;
            }
          }
        }

        if (this.live.remainingSec <= 0) {
          this.handlePhaseTimerComplete();
        } else {
          this.updateLiveTimerDOM();
        }
      }
    }, 100);
  },

  enterStepExecution(idx) {
    if (idx >= this.live.steps.length) {
      this.live.phase = 'FINISHED';
      this.renderLiveOverlay();
      return;
    }

    this.live.stepIndex = idx;
    const step = this.live.steps[idx];
    this.live.tempWeight = step.weight;
    this.live.tempReps = step.reps;
    this.live.lastBeepSecond = null;
    this.live.paused = false;

    if (step.mode === 'time') {
      // Avvia un breve conto alla rovescia di 3 secondi (con i 3 beep + beep di avvio)
      this.live.phase = 'PREP';
      this.live.remainingSec = 3;
      this.live.totalPhaseSec = 3;
      this.live.lastBeepSecond = 3;
      SoundEngine.playCountdownPip();
    } else {
      // Esercizio a ripetizioni senza tempo: beep di avvio immediato
      this.live.phase = 'WORK_REPS';
      SoundEngine.playStartCue();
    }
    this.renderLiveOverlay();
  },

  handlePhaseTimerComplete() {
    const step = this.live.steps[this.live.stepIndex];
    this.live.lastBeepSecond = null;

    if (this.live.phase === 'PREP') {
      // I 3 beep sono terminati -> Beep di AVVIO diverso dagli altri e parte il timer esercizio
      SoundEngine.playStartCue();
      this.live.phase = 'WORK_TIME';
      this.live.remainingSec = step.durationSec;
      this.live.totalPhaseSec = step.durationSec;
      this.renderLiveOverlay();
    } else if (this.live.phase === 'WORK_TIME') {
      // I 2 beep sono terminati -> Beep FINALE diverso dagli altri
      SoundEngine.playFinishCue();
      this.afterExerciseFinished();
    } else if (this.live.phase === 'REST') {
      // Fine recupero (ha già fatto i 3 beep negli ultimi 3s del recupero) -> passa al prossimo step
      const nextIndex = this.live.stepIndex + 1;
      if (nextIndex >= this.live.steps.length) {
        SoundEngine.playFinishCue();
        this.live.phase = 'FINISHED';
        this.renderLiveOverlay();
      } else {
        const nextStep = this.live.steps[nextIndex];
        this.live.stepIndex = nextIndex;
        this.live.tempWeight = nextStep.weight;
        this.live.tempReps = nextStep.reps;
        // Dato che il recupero ha già fatto i 3 beep negli ultimi 3s, diamo subito il Beep di AVVIO!
        SoundEngine.playStartCue();
        if (nextStep.mode === 'time') {
          this.live.phase = 'WORK_TIME';
          this.live.remainingSec = nextStep.durationSec;
          this.live.totalPhaseSec = nextStep.durationSec;
        } else {
          this.live.phase = 'WORK_REPS';
        }
        this.renderLiveOverlay();
      }
    }
  },

  // Chiamato quando l'utente finisce la serie a ripetizioni o quando scade il timer dell'esercizio a tempo
  afterExerciseFinished() {
    const step = this.live.steps[this.live.stepIndex];
    if (step.askRecordLog) {
      // L'utente ha scelto in creazione scheda di chiedere se salvare il record per questo esercizio
      this.live.phase = 'DECIDE_LOG';
      this.renderLiveOverlay();
    } else {
      this.startRestOrNext();
    }
  },

  // Scelta dei due tasti a fine serie: Salva come Record oppure Scarta e procedi
  confirmRecordDecision(saveToHistory) {
    const step = this.live.steps[this.live.stepIndex];
    if (saveToHistory) {
      const w = parseFloat(this.live.tempWeight) || 0;
      const r = parseInt(this.live.tempReps, 10) || 1;
      const eff1RM = calculateEffectiveLoad(w, r);
      this.state.logs.push({
        id: uid('log'),
        exerciseId: step.exerciseId,
        workoutName: this.live.workoutName,
        dateISO: new Date().toISOString(),
        weight: w,
        reps: r,
        effective1RM: eff1RM,
        setNumber: step.setNumber
      });
      // Aggiorna anche il peso preimpostato per le serie successive dello stesso esercizio in questa sessione
      step.weight = w;
      step.reps = r;
      this.live.savedLogsCount++;
      this.saveData();
      this.toast(`Record salvato: ${w}kg × ${r} rep (1RM: ${eff1RM}kg)`);
    }
    this.startRestOrNext();
  },

  startRestOrNext() {
    const step = this.live.steps[this.live.stepIndex];
    const isLastStep = this.live.stepIndex === this.live.steps.length - 1;

    if (isLastStep) {
      this.live.phase = 'FINISHED';
      this.renderLiveOverlay();
      return;
    }

    if (step.restAfterSec && step.restAfterSec > 0) {
      this.live.phase = 'REST';
      this.live.remainingSec = step.restAfterSec;
      this.live.totalPhaseSec = step.restAfterSec;
      this.live.lastBeepSecond = null;
      this.renderLiveOverlay();
    } else {
      this.enterStepExecution(this.live.stepIndex + 1);
    }
  },

  togglePauseLive() {
    if (!this.live) return;
    this.live.paused = !this.live.paused;
    this.renderLiveOverlay();
  },

  adjustLiveTime(deltaSec) {
    if (!this.live) return;
    this.live.remainingSec = Math.max(1, this.live.remainingSec + deltaSec);
    this.updateLiveTimerDOM();
  },

  adjustTempMetric(field, delta) {
    if (!this.live) return;
    if (field === 'weight') {
      this.live.tempWeight = Math.max(0, Math.round((this.live.tempWeight + delta) * 10) / 10);
    } else {
      this.live.tempReps = Math.max(1, this.live.tempReps + delta);
    }
    this.renderLiveOverlay();
  },

  promptEditMetric(field) {
    if (!this.live) return;
    const isWeight = field === 'weight';
    const currentVal = isWeight ? this.live.tempWeight : this.live.tempReps;
    const modal = document.getElementById('modal-overlay');
    modal.classList.remove('hidden');
    modal.innerHTML = `
      <div class="modal-card">
        <h3 style="margin-bottom:12px">${isWeight ? 'Modifica Peso (kg)' : 'Modifica Ripetizioni'}</h3>
        <input id="modal-metric-input" type="number" step="${isWeight ? '0.5' : '1'}" min="0" class="input"
          style="font-size:1.5rem; text-align:center; font-weight:700; margin-bottom:16px" value="${currentVal}" />
        <div class="grid-2">
          <button class="btn btn-ghost" onclick="App.closeModal()">Annulla</button>
          <button class="btn btn-primary" onclick="App.saveModalMetric('${field}')">Conferma</button>
        </div>
      </div>
    `;
    setTimeout(() => {
      const inp = document.getElementById('modal-metric-input');
      if (inp) {
        inp.focus();
        inp.select();
      }
    }, 50);
  },

  saveModalMetric(field) {
    const inp = document.getElementById('modal-metric-input');
    if (inp && this.live) {
      if (field === 'weight') {
        this.live.tempWeight = Math.max(0, parseFloat(inp.value) || 0);
      } else {
        this.live.tempReps = Math.max(1, parseInt(inp.value, 10) || 1);
      }
    }
    this.closeModal();
    this.renderLiveOverlay();
  },

  closeModal() {
    const modal = document.getElementById('modal-overlay');
    modal.classList.add('hidden');
    modal.innerHTML = '';
  },

  closeLiveWorkout(confirmAbort = false) {
    if (confirmAbort && this.live && this.live.phase !== 'FINISHED') {
      if (!confirm('Vuoi terminare anticipatamente l\'allenamento? I record già salvati resteranno in memoria.')) {
        return;
      }
    }
    if (this.liveInterval) {
      clearInterval(this.liveInterval);
      this.liveInterval = null;
    }
    WakeLockManager.release();
    this.live = null;
    document.getElementById('live-workout-overlay').classList.add('hidden');
    this.render();
  },

  updateLiveTimerDOM() {
    const digitsEl = document.getElementById('live-timer-digits');
    if (!digitsEl || !this.live) return;
    const ceilSec = Math.max(0, Math.ceil(this.live.remainingSec));
    digitsEl.textContent = formatSeconds(ceilSec);
    digitsEl.classList.toggle('countdown-warn', ceilSec <= 3);
  },

  updateWorkoutElapsedDOM() {
    const el = document.getElementById('live-workout-elapsed');
    if (!el || !this.live) return;
    el.textContent = formatDurationClock(this.live.elapsedWorkoutSec);
  },

  renderLiveOverlay() {
    const overlay = document.getElementById('live-workout-overlay');
    if (!this.live) return;

    if (this.live.phase === 'FINISHED') {
      const totalClock = formatDurationClock(this.live.elapsedWorkoutSec);
      const totalVerbose = formatDurationVerbose(this.live.elapsedWorkoutSec);
      overlay.innerHTML = `
        <div class="live-stage" style="justify-content:center; gap:18px">
          <div style="font-size:3.2rem">🏆</div>
          <h2 style="font-size:1.8rem">Allenamento Completato!</h2>
          <p style="color:var(--text-secondary)">
            Hai terminato <strong>${this.escape(this.live.workoutName)}</strong>.
          </p>
          <div class="grid-2" style="width:100%; margin:4px 0">
            <div class="card" style="margin-bottom:0; padding:14px">
              <div style="font-size:0.74rem; color:var(--text-secondary); text-transform:uppercase">Durata Scheda</div>
              <div style="font-size:1.45rem; font-weight:700; color:var(--accent); margin-top:4px; font-variant-numeric:tabular-nums">${totalClock}</div>
              <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:2px">${totalVerbose}</div>
            </div>
            <div class="card" style="margin-bottom:0; padding:14px">
              <div style="font-size:0.74rem; color:var(--text-secondary); text-transform:uppercase">Record Salvati</div>
              <div style="font-size:1.45rem; font-weight:700; color:var(--sage); margin-top:4px">${this.live.savedLogsCount}</div>
              <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:2px">serie nello storico</div>
            </div>
          </div>
          <button class="btn btn-primary btn-lg" onclick="App.closeLiveWorkout(false)">Torna alla Home</button>
        </div>
      `;
      return;
    }

    const step = this.live.steps[this.live.stepIndex];
    const ex = this.getExerciseById(step.exerciseId);
    const nextStep = this.live.steps[this.live.stepIndex + 1];
    const nextEx = nextStep ? this.getExerciseById(nextStep.exerciseId) : null;
    const progressPct = Math.round(((this.live.stepIndex + 1) / this.live.steps.length) * 100);

    let stageContent = '';

    // 1. FASE CONTO ALLA ROVESCIA PREPARAZIONE (3s prima di un esercizio a tempo)
    if (this.live.phase === 'PREP') {
      stageContent = `
        <div>
          <span class="live-phase-tag badge-accent">Preparati • 3 Beep</span>
          <div class="live-ex-title">${this.escape(ex.name)}</div>
          <div class="live-set-subtitle">${this.escape(step.blockTitle)} • ${step.setLabel}</div>
        </div>

        <div class="timer-display-box">
          <div id="live-timer-digits" class="timer-digits countdown-warn">${formatSeconds(this.live.remainingSec)}</div>
          <div class="timer-subtext">Inizio esercizio tra pochi istanti...</div>
        </div>

        <div style="display:flex; gap:10px">
          <button class="btn btn-secondary btn-lg" onclick="App.togglePauseLive()">
            ${this.live.paused ? '▶ Riprendi' : '⏸ Pausa'}
          </button>
        </div>
      `;
    }
    // 2. FASE ESERCIZIO A TEMPO (es. Plank 1 minuto)
    else if (this.live.phase === 'WORK_TIME') {
      stageContent = `
        <div>
          <span class="live-phase-tag badge-sage">Esercizio a Tempo</span>
          <div class="live-ex-title">${this.escape(ex.name)}</div>
          <div class="live-set-subtitle">${this.escape(step.blockTitle)} • ${step.setLabel}</div>
        </div>

        <div class="timer-display-box">
          <div id="live-timer-digits" class="timer-digits">${formatSeconds(this.live.remainingSec)}</div>
          <div class="timer-subtext">${this.live.paused ? 'IN PAUSA' : `Obiettivo: ${step.durationSec} secondi`}</div>
          <div style="display:flex; gap:8px; margin-top:14px">
            <button class="btn btn-ghost btn-sm" onclick="App.adjustLiveTime(-10)">-10s</button>
            <button class="btn btn-ghost btn-sm" onclick="App.adjustLiveTime(10)">+10s</button>
          </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:10px">
          <button class="btn btn-secondary btn-lg" onclick="App.togglePauseLive()">
            ${this.live.paused ? '▶ Riprendi Timer' : '⏸ Metti in Pausa'}
          </button>
          <button class="btn btn-primary btn-lg" onclick="SoundEngine.playFinishCue(); App.afterExerciseFinished()">
            ✓ Concludi Serie Ora
          </button>
        </div>
      `;
    }
    // 3. FASE ESERCIZIO A RIPETIZIONI (senza tempo: l'utente esegue e poi dà il via al recupero/decisione)
    else if (this.live.phase === 'WORK_REPS') {
      stageContent = `
        <div>
          <span class="live-phase-tag badge-accent">Esecuzione Serie</span>
          <div class="live-ex-title">${this.escape(ex.name)}</div>
          <div class="live-set-subtitle">${this.escape(step.blockTitle)} • ${step.setLabel}</div>
        </div>

        <div>
          <p style="font-size:0.84rem; color:var(--text-secondary); margin-bottom:8px">
            Tocca il valore per digitarlo o usa i tasti rapidi:
          </p>
          <div class="live-metrics-grid">
            <div class="metric-tap-card" onclick="App.promptEditMetric('weight')">
              <span class="metric-tap-label">Peso (kg) ✎</span>
              <span class="metric-tap-value">${this.live.tempWeight}</span>
              <div class="metric-stepper-row" onclick="event.stopPropagation()">
                <button class="stepper-btn" onclick="App.adjustTempMetric('weight', -2.5)">-2.5</button>
                <button class="stepper-btn" onclick="App.adjustTempMetric('weight', 2.5)">+2.5</button>
              </div>
            </div>
            <div class="metric-tap-card" onclick="App.promptEditMetric('reps')">
              <span class="metric-tap-label">Ripetizioni ✎</span>
              <span class="metric-tap-value">${this.live.tempReps}</span>
              <div class="metric-stepper-row" onclick="event.stopPropagation()">
                <button class="stepper-btn" onclick="App.adjustTempMetric('reps', -1)">-1</button>
                <button class="stepper-btn" onclick="App.adjustTempMetric('reps', 1)">+1</button>
              </div>
            </div>
          </div>
        </div>

        <button class="btn btn-primary btn-lg" style="padding:18px" onclick="App.afterExerciseFinished()">
          ✓ Serie Completata ${step.restAfterSec > 0 ? `(Avvia Recupero ${step.restAfterSec}s)` : '(Prossimo)'}
        </button>
      `;
    }
    // 4. FASE SCELTA SALVATAGGIO RECORD (solo per gli esercizi con l'opzione attiva)
    else if (this.live.phase === 'DECIDE_LOG') {
      const eff = calculateEffectiveLoad(this.live.tempWeight, this.live.tempReps);
      stageContent = `
        <div>
          <span class="live-phase-tag badge-accent">Fine Serie • Registra Carico?</span>
          <div class="live-ex-title">${this.escape(ex.name)}</div>
          <div class="live-set-subtitle">${step.setLabel} completata</div>
        </div>

        <div>
          <p style="font-size:0.84rem; color:var(--text-secondary); margin-bottom:8px">
            Verifica o clicca sui valori per modificarli prima di scegliere:
          </p>
          <div class="live-metrics-grid">
            <div class="metric-tap-card" onclick="App.promptEditMetric('weight')">
              <span class="metric-tap-label">Peso Sollevato (kg) ✎</span>
              <span class="metric-tap-value">${this.live.tempWeight}</span>
              <div class="metric-stepper-row" onclick="event.stopPropagation()">
                <button class="stepper-btn" onclick="App.adjustTempMetric('weight', -2.5)">-2.5</button>
                <button class="stepper-btn" onclick="App.adjustTempMetric('weight', 2.5)">+2.5</button>
              </div>
            </div>
            <div class="metric-tap-card" onclick="App.promptEditMetric('reps')">
              <span class="metric-tap-label">Ripetizioni Fatte ✎</span>
              <span class="metric-tap-value">${this.live.tempReps}</span>
              <div class="metric-stepper-row" onclick="event.stopPropagation()">
                <button class="stepper-btn" onclick="App.adjustTempMetric('reps', -1)">-1</button>
                <button class="stepper-btn" onclick="App.adjustTempMetric('reps', 1)">+1</button>
              </div>
            </div>
          </div>
          <div style="font-size:0.82rem; color:var(--sage); margin-top:4px">
            Carico Equivalente 1RM: <strong>${eff} kg</strong>
          </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:10px">
          <button class="btn btn-sage btn-lg" onclick="App.confirmRecordDecision(true)">
            💾 Salva Peso come Record e Procedi
          </button>
          <button class="btn btn-secondary btn-lg" onclick="App.confirmRecordDecision(false)">
            ⏭ Scarta Record e Procedi
          </button>
        </div>
      `;
    }
    // 5. FASE RECUPERO (Timer con Pausa, +15/-15s e 3 beep prima di ripartire)
    else if (this.live.phase === 'REST') {
      stageContent = `
        <div>
          <span class="live-phase-tag" style="background:var(--bg-elevated); color:var(--accent)">⏱ Tempo di Recupero</span>
          <div class="live-ex-title">Riposo</div>
          <div class="live-set-subtitle">${this.escape(step.restReason)}</div>
        </div>

        <div class="timer-display-box">
          <div id="live-timer-digits" class="timer-digits">${formatSeconds(this.live.remainingSec)}</div>
          <div class="timer-subtext">${this.live.paused ? 'TIMER IN PAUSA' : '3 beep ti avviseranno prima di ripartire'}</div>
          <div style="display:flex; gap:10px; margin-top:14px">
            <button class="btn btn-ghost btn-sm" onclick="App.adjustLiveTime(-15)">-15s</button>
            <button class="btn btn-ghost btn-sm" onclick="App.adjustLiveTime(15)">+15s</button>
          </div>
        </div>

        ${
          nextStep
            ? `<div class="next-up-card">
                 <div style="font-size:0.75rem; color:var(--text-secondary); text-transform:uppercase">Prossimo esercizio:</div>
                 <div style="font-weight:600; font-size:0.98rem; margin-top:2px">${this.escape(nextEx.name)} — ${nextStep.setLabel}</div>
                 <div style="font-size:0.83rem; color:var(--text-secondary)">
                   ${nextStep.mode === 'time' ? `Durata: ${nextStep.durationSec}s` : `${nextStep.reps} rep @ ${nextStep.weight}kg`}
                 </div>
               </div>`
            : ''
        }

        <div class="grid-2">
          <button class="btn btn-secondary btn-lg" onclick="App.togglePauseLive()">
            ${this.live.paused ? '▶ Riprendi' : '⏸ Pausa'}
          </button>
          <button class="btn btn-primary btn-lg" onclick="App.handlePhaseTimerComplete()">
            Salta Recupero ⏭
          </button>
        </div>
      `;
    }

    overlay.innerHTML = `
      <div class="live-top-bar">
        <div>
          <div style="font-size:0.78rem; color:var(--text-secondary)">${this.escape(this.live.workoutName)}</div>
          <div style="font-size:0.84rem; font-weight:600">Step ${this.live.stepIndex + 1} di ${this.live.steps.length}</div>
        </div>
        <div style="display:flex; align-items:center; gap:8px">
          <div class="badge badge-accent" style="font-variant-numeric:tabular-nums; padding:5px 10px; font-size:0.8rem" title="Durata scheda">
            ⏱ <span id="live-workout-elapsed">${formatDurationClock(this.live.elapsedWorkoutSec)}</span>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="App.closeLiveWorkout(true)">Chiudi ✕</button>
        </div>
      </div>
      <div class="live-progress-bar">
        <div class="live-progress-fill" style="width:${progressPct}%"></div>
      </div>
      <div class="live-stage">
        ${stageContent}
      </div>
    `;
  },

  // ==========================================================================
  // TAB 2: PROGRESSI (Grafico Intensità Carico 1RM + Tabella Storica)
  // ==========================================================================
  renderProgressTab() {
    if (this.state.exercises.length === 0) {
      return `
        <div class="empty-state">
          <h3>Nessun esercizio presente</h3>
          <p>Aggiungi i tuoi esercizi nella scheda "Esercizi" o creando un nuovo allenamento per monitorare i carichi nel tempo.</p>
          <button class="btn btn-primary" onclick="App.switchTab('exercises')">Vai a Esercizi</button>
        </div>
      `;
    }

    // Trova esercizi che hanno record oppure mostra tutti
    if (!this.selectedProgressExerciseId || !this.state.exercises.some((e) => e.id === this.selectedProgressExerciseId)) {
      this.selectedProgressExerciseId = this.state.exercises[0].id;
    }

    const exOptions = this.state.exercises
      .map((ex) => {
        const count = this.state.logs.filter((l) => l.exerciseId === ex.id).length;
        return `<option value="${ex.id}" ${ex.id === this.selectedProgressExerciseId ? 'selected' : ''}>
          ${this.escape(ex.name)} (${count} record)
        </option>`;
      })
      .join('');

    const logs = this.state.logs
      .filter((l) => l.exerciseId === this.selectedProgressExerciseId)
      .sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));

    let chartAndStatsHtml = '';
    if (logs.length === 0) {
      chartAndStatsHtml = `
        <div class="card empty-state">
          <p>Nessun record registrato per questo esercizio.</p>
          <button class="btn btn-secondary btn-sm" onclick="App.openManualLogModal()">+ Aggiungi Record Manuale</button>
        </div>
      `;
    } else {
      const bestLog = logs.reduce((best, cur) => (cur.effective1RM > best.effective1RM ? cur : best), logs[0]);
      const latestLog = logs[logs.length - 1];

      chartAndStatsHtml = `
        <div class="grid-2" style="margin-bottom:14px">
          <div class="card" style="margin-bottom:0; padding:12px">
            <div style="font-size:0.75rem; color:var(--text-secondary)">MIGLIOR CARICO (1RM)</div>
            <div style="font-size:1.35rem; font-weight:700; color:var(--accent); margin-top:2px">${bestLog.effective1RM} kg</div>
            <div style="font-size:0.8rem; color:var(--text-primary)">Fatto con <strong>${bestLog.weight}kg × ${bestLog.reps}</strong></div>
          </div>
          <div class="card" style="margin-bottom:0; padding:12px">
            <div style="font-size:0.75rem; color:var(--text-secondary)">ULTIMA SESSIONE</div>
            <div style="font-size:1.35rem; font-weight:700; color:var(--sage); margin-top:2px">${latestLog.effective1RM} kg</div>
            <div style="font-size:0.8rem; color:var(--text-primary)">Fatto con <strong>${latestLog.weight}kg × ${latestLog.reps}</strong></div>
          </div>
        </div>

        <div class="chart-container">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
            <div>
              <div style="font-size:0.9rem; font-weight:600">Andamento Intensità di Carico nel Tempo</div>
              <div style="font-size:0.74rem; color:var(--text-secondary)">
                Altezza punto = difficolt&agrave; reale (1RM stimato) • Etichetta = Peso × Rep
              </div>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="App.openManualLogModal()">+ Record</button>
          </div>
          ${this.buildSvgProgressChart(logs)}
        </div>

        <div class="card" style="padding:14px">
          <div style="font-size:0.92rem; font-weight:600; margin-bottom:8px">Storico Serie Registrate</div>
          <div style="overflow-x:auto">
            <table class="history-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Peso × Rep</th>
                  <th>Carico 1RM</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${logs
                  .slice()
                  .reverse()
                  .map((l) => {
                    const d = new Date(l.dateISO);
                    const dateStr = d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' });
                    return `
                      <tr>
                        <td>${dateStr}</td>
                        <td><strong>${l.weight} kg × ${l.reps}</strong></td>
                        <td><span class="badge badge-accent">${l.effective1RM} kg</span></td>
                        <td style="text-align:right">
                          <button class="btn btn-ghost btn-sm" style="padding:3px 7px" onclick="App.deleteLogEntry('${l.id}')">✕</button>
                        </td>
                      </tr>
                    `;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    return `
      <div class="form-group">
        <label class="form-label">Seleziona Esercizio</label>
        <select class="select" onchange="App.selectedProgressExerciseId = this.value; App.render()">
          ${exOptions}
        </select>
      </div>
      ${chartAndStatsHtml}
    `;
  },

  buildSvgProgressChart(logs) {
    const width = 480;
    const height = 220;
    const padLeft = 42;
    const padRight = 32;
    const padTop = 28;
    const padBottom = 34;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const values = logs.map((l) => l.effective1RM);
    let minVal = Math.min(...values);
    let maxVal = Math.max(...values);
    if (minVal === maxVal) {
      minVal = Math.max(0, minVal - 10);
      maxVal = maxVal + 10;
    } else {
      const span = maxVal - minVal;
      minVal = Math.max(0, Math.floor(minVal - span * 0.15));
      maxVal = Math.ceil(maxVal + span * 0.18);
    }

    const getX = (i) => {
      if (logs.length === 1) return padLeft + plotW / 2;
      return padLeft + (i / (logs.length - 1)) * plotW;
    };
    const getY = (val) => {
      return padTop + plotH - ((val - minVal) / (maxVal - minVal)) * plotH;
    };

    // Linee guida orizzontali
    const gridSteps = 4;
    let gridHtml = '';
    for (let i = 0; i <= gridSteps; i++) {
      const v = Math.round(minVal + ((maxVal - minVal) * i) / gridSteps);
      const y = getY(v);
      gridHtml += `
        <line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="#2d3039" stroke-dasharray="3 3" stroke-width="1" />
        <text x="${padLeft - 6}" y="${y + 4}" text-anchor="end" fill="#686864" font-size="10">${v}kg</text>
      `;
    }

    const pts = logs.map((l, idx) => ({
      x: getX(idx),
      y: getY(l.effective1RM),
      log: l
    }));

    const polylinePoints = pts.map((p) => `${p.x},${p.y}`).join(' ');
    const areaPoints = `${pts[0].x},${padTop + plotH} ${polylinePoints} ${pts[pts.length - 1].x},${padTop + plotH}`;

    const dotsHtml = pts
      .map((p) => {
        const d = new Date(p.log.dateISO);
        const dateLabel = d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
        return `
          <g>
            <circle cx="${p.x}" cy="${p.y}" r="5" fill="#d6c5b3" stroke="#121316" stroke-width="2" />
            <text x="${p.x}" y="${p.y - 10}" text-anchor="middle" fill="#f1efe9" font-size="10.5" font-weight="600">
              ${p.log.weight}×${p.log.reps}
            </text>
            <text x="${p.x}" y="${height - 10}" text-anchor="middle" fill="#9a9994" font-size="9.5">
              ${dateLabel}
            </text>
          </g>
        `;
      })
      .join('');

    return `
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}">
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#d6c5b3" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#d6c5b3" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        ${gridHtml}
        ${pts.length > 1 ? `<polygon points="${areaPoints}" fill="url(#chartGrad)" />` : ''}
        ${pts.length > 1 ? `<polyline fill="none" stroke="#d6c5b3" stroke-width="2.5" points="${polylinePoints}" />` : ''}
        ${dotsHtml}
      </svg>
    `;
  },

  deleteLogEntry(logId) {
    if (!confirm('Eliminare questo record dallo storico?')) return;
    this.state.logs = this.state.logs.filter((l) => l.id !== logId);
    this.saveData();
    this.render();
  },

  openManualLogModal() {
    const modal = document.getElementById('modal-overlay');
    modal.classList.remove('hidden');
    modal.innerHTML = `
      <div class="modal-card">
        <h3 style="margin-bottom:12px">Aggiungi Record Manuale</h3>
        <div class="grid-2 form-group">
          <div>
            <label class="form-label">Peso (kg)</label>
            <input id="man-weight" type="number" step="0.5" class="input" value="100" />
          </div>
          <div>
            <label class="form-label">Ripetizioni</label>
            <input id="man-reps" type="number" min="1" class="input" value="4" />
          </div>
        </div>
        <div class="grid-2">
          <button class="btn btn-ghost" onclick="App.closeModal()">Annulla</button>
          <button class="btn btn-primary" onclick="App.saveManualLog()">Salva Record</button>
        </div>
      </div>
    `;
  },

  saveManualLog() {
    const w = parseFloat(document.getElementById('man-weight')?.value) || 0;
    const r = parseInt(document.getElementById('man-reps')?.value, 10) || 1;
    if (this.selectedProgressExerciseId) {
      this.state.logs.push({
        id: uid('log'),
        exerciseId: this.selectedProgressExerciseId,
        workoutName: 'Inserimento Manuale',
        dateISO: new Date().toISOString(),
        weight: w,
        reps: r,
        effective1RM: calculateEffectiveLoad(w, r),
        setNumber: 1
      });
      this.saveData();
      this.toast('Record aggiunto');
    }
    this.closeModal();
    this.render();
  },

  // ==========================================================================
  // TAB 3: LIBRERIA ESERCIZI
  // ==========================================================================
  renderExercisesTab() {
    if (this.state.exercises.length === 0) {
      return `
        <div class="empty-state">
          <h3>Libreria esercizi vuota</h3>
          <p>Non ci sono esercizi preinseriti. Aggiungi qui i tuoi esercizi personalizzati.</p>
          <button class="btn btn-primary" onclick="App.openAddExerciseModal()">+ Aggiungi Esercizio</button>
        </div>
      `;
    }
    return this.state.exercises
      .map((ex) => {
        const logsCount = this.state.logs.filter((l) => l.exerciseId === ex.id).length;
        return `
          <div class="card" style="display:flex; justify-content:space-between; align-items:center; padding:13px 16px; margin-bottom:10px">
            <div>
              <div style="font-weight:600">${this.escape(ex.name)}</div>
              <div style="font-size:0.78rem; color:var(--text-secondary)">${this.escape(ex.category)} • ${logsCount} record salvati</div>
            </div>
            <div style="display:flex; gap:6px">
              <button class="btn btn-secondary btn-sm" onclick="App.selectedProgressExerciseId='${ex.id}'; App.switchTab('progress')">Grafico</button>
              <button class="btn btn-ghost btn-sm" onclick="App.deleteExercise('${ex.id}')">✕</button>
            </div>
          </div>
        `;
      })
      .join('');
  },

  openAddExerciseModal(assignToBlockIndex = null, assignToCircuitIndex = null) {
    const modal = document.getElementById('modal-overlay');
    modal.classList.remove('hidden');
    modal.innerHTML = `
      <div class="modal-card">
        <h3 style="margin-bottom:12px">Nuovo Esercizio</h3>
        <div class="form-group">
          <label class="form-label">Nome Esercizio</label>
          <input id="new-ex-name" type="text" class="input" placeholder="Es. Squat, Panca Piana, Plank..." />
        </div>
        <div class="form-group">
          <label class="form-label">Gruppo Muscolare / Categoria</label>
          <input id="new-ex-cat" type="text" class="input" placeholder="Es. Gambe, Petto, Core..." value="Generale" />
        </div>
        <div class="grid-2">
          <button class="btn btn-ghost" onclick="App.closeModal()">Annulla</button>
          <button class="btn btn-primary" onclick="App.saveNewExercise(${assignToBlockIndex}, ${assignToCircuitIndex})">Crea</button>
        </div>
      </div>
    `;
  },

  saveNewExercise(assignToBlockIndex = null, assignToCircuitIndex = null) {
    const name = (document.getElementById('new-ex-name')?.value || '').trim();
    const category = (document.getElementById('new-ex-cat')?.value || 'Generale').trim();
    if (!name) {
      this.toast('Inserisci un nome per l\'esercizio');
      return;
    }
    const newEx = { id: uid('ex'), name, category };
    this.state.exercises.push(newEx);
    this.saveData();

    if (assignToBlockIndex !== null && this.editingWorkout && this.editingWorkout.blocks[assignToBlockIndex]) {
      const blk = this.editingWorkout.blocks[assignToBlockIndex];
      if (blk.type === 'single') {
        blk.exerciseId = newEx.id;
      } else if (blk.type === 'circuit' && assignToCircuitIndex !== null && blk.exercises[assignToCircuitIndex]) {
        blk.exercises[assignToCircuitIndex].exerciseId = newEx.id;
      }
    }
    this.closeModal();
    this.toast(`Esercizio "${name}" aggiunto`);
    this.render();
  },

  deleteExercise(id) {
    if (!confirm('Rimuovere questo esercizio dalla libreria?')) return;
    this.state.exercises = this.state.exercises.filter((e) => e.id !== id);
    this.saveData();
    this.render();
  },

  // ==========================================================================
  // TAB 4: IMPOSTAZIONI, TEST AUDIO E BACKUP LOCALE (JSON)
  // ==========================================================================
  renderSettingsTab() {
    const s = this.state.settings;
    return `
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Audio, Timer & Schermo (S25 Ultra)</div>

        <label class="toggle-row" style="margin-bottom:10px">
          <div class="toggle-info">
            <span class="toggle-title">Segnali Sonori (Beep Timer)</span>
            <span class="toggle-desc">Inizio: 3 beep + tono avvio • Fine: 2 beep + tono finale</span>
          </div>
          <input type="checkbox" class="switch-input" ${s.sound ? 'checked' : ''}
            onchange="App.toggleSetting('sound', this.checked)" />
        </label>

        <label class="toggle-row" style="margin-bottom:10px">
          <div class="toggle-info">
            <span class="toggle-title">Vibrazione</span>
            <span class="toggle-desc">Feedback aptico sui cambi di fase del timer</span>
          </div>
          <input type="checkbox" class="switch-input" ${s.vibration ? 'checked' : ''}
            onchange="App.toggleSetting('vibration', this.checked)" />
        </label>

        <label class="toggle-row" style="margin-bottom:12px">
          <div class="toggle-info">
            <span class="toggle-title">Schermo Sempre Attivo (Wake Lock)</span>
            <span class="toggle-desc">Impedisce lo spegnimento dello schermo durante l'allenamento</span>
          </div>
          <input type="checkbox" class="switch-input" ${s.wakeLock ? 'checked' : ''}
            onchange="App.toggleSetting('wakeLock', this.checked)" />
        </label>

        <div class="grid-2">
          <button class="btn btn-secondary btn-sm" onclick="App.testStartSoundSequence()">🔊 Test 3 Beep + Avvio</button>
          <button class="btn btn-secondary btn-sm" onclick="App.testFinishSoundSequence()">🔊 Test 2 Beep + Fine</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:6px">Backup Locale & Ripristino</div>
        <p style="font-size:0.83rem; color:var(--text-secondary); margin-bottom:14px">
          Tutti i dati sono salvati in locale sul tuo telefono. Puoi esportare un file di sicurezza o importarlo in qualsiasi momento.
        </p>
        <div class="grid-2">
          <button class="btn btn-primary" onclick="App.exportBackup()">⬇ Esporta Backup</button>
          <label class="btn btn-secondary" style="cursor:pointer">
            ⬆ Importa File
            <input type="file" accept=".json" style="display:none" onchange="App.importBackup(event)" />
          </label>
        </div>
      </div>
    `;
  },

  toggleSetting(key, val) {
    this.state.settings[key] = val;
    SoundEngine.enabled = this.state.settings.sound;
    SoundEngine.vibrationEnabled = this.state.settings.vibration;
    this.saveData();
  },

  testStartSoundSequence() {
    SoundEngine.init();
    this.toast('Riproduzione: 3 beep + segnale di AVVIO...');
    SoundEngine.playCountdownPip();
    setTimeout(() => SoundEngine.playCountdownPip(), 650);
    setTimeout(() => SoundEngine.playCountdownPip(), 1300);
    setTimeout(() => SoundEngine.playStartCue(), 1950);
  },

  testFinishSoundSequence() {
    SoundEngine.init();
    this.toast('Riproduzione: 2 beep + segnale di FINE...');
    SoundEngine.playCountdownPip();
    setTimeout(() => SoundEngine.playCountdownPip(), 650);
    setTimeout(() => SoundEngine.playFinishCue(), 1300);
  },

  exportBackup() {
    const dataStr = JSON.stringify(this.state, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `palestra_backup_${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.toast('File di backup scaricato');
  },

  importBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (parsed.workouts && parsed.exercises) {
          this.state = parsed;
          this.saveData();
          this.toast('Backup importato con successo!');
          this.render();
        } else {
          this.toast('Formato file non valido');
        }
      } catch (err) {
        this.toast('Errore nella lettura del file');
      }
    };
    reader.readAsText(file);
  },

  escape(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
};

window.addEventListener('DOMContentLoaded', () => App.init());
