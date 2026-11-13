/**
 * Touch audio: 24 short CC0 recordings turned into feedback for the body.
 *
 * Every one-shot is built on the same fixed graph:
 *   AudioBufferSourceNode → BiquadFilterNode (lowpass) → GainNode
 *   → master GainNode (0.6) → DynamicsCompressorNode → destination
 * and the six events (touch, squelch, stretch, impact, pop, peel) are plain
 * triggers. A real mochi squishy is nearly silent and muffled, so its samples
 * are quiet and heavily low-passed; slime is wet and loud. `update()` is a
 * no-op until `unlock()` resolves or while muted — that is the defined
 * "not started yet" state, not an error path.
 */

const MASTER_GAIN = 0.6;
/** Every one-shot fades in over this long so it never clicks. */
const ATTACK_SECONDS = 0.004;
/** Random playback-rate spread around the nominal rate (±8 %). */
const RATE_JITTER = 0.08;
/** Global cap on simultaneously live one-shots. */
const MAX_VOICES = 6;
/** Minimum spacing between two one-shots of the same event kind. */
const SAME_KIND_GAP_MS = 70;
/** Master mute ramp length. */
const ENABLE_RAMP_SECONDS = 0.03;

/** Sink units accumulated per `depthRate` unit and real second. */
const SINK_RATE_GAIN = 3;
/** Sink accumulated before a squelch fires. */
const SQUELCH_STEP = 0.14;
/** Drag distance accumulated before a stretch fires. */
const STRETCH_STEP = 0.4;
/** Release depth above which `grabEnd` fires a pop. */
const POP_DEPTH = 0.35;
/** `signals.impact` above which an impact fires. */
const IMPACT_THRESHOLD = 3;
/** Synthesized thump length and its release tail. */
const THUMP_SECONDS = 0.09;
const THUMP_RELEASE_SECONDS = 0.02;

const SQUISH_SAMPLES = [
  'squish_01',
  'squish_02',
  'squish_03',
  'squish_04',
  'squish_05',
  'squish_06',
];

const SLIME_SAMPLES = [
  'slime_01',
  'slime_02',
  'slime_03',
  'slime_04',
  'slime_05',
  'slime_06',
  'slime_07',
  'slime_08',
  'slime_09',
  'slime_10',
  'slime_11',
  'slime_12',
  'slime_13',
  'slime_14',
  'slime_15',
  'slime_16',
];

const GROUPS = { squish: SQUISH_SAMPLES, slime: SLIME_SAMPLES };

/** Every file fetched by `unlock()`, in load order. */
const ALL_SAMPLES = [...SQUISH_SAMPLES, 'pop', 'splat', ...SLIME_SAMPLES];

const MATERIALS = ['squishy', 'slow', 'slime', 'bouncy'];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class SquishAudio {
  constructor({ baseUrl }) {
    this.baseUrl = baseUrl;
    this.context = null;
    this.master = null;
    this.compressor = null;
    this.buffers = null;

    this.readyFlag = false;
    this.enabled = true;
    this.material = 'squishy';

    /** Live one-shots (buffer sources and the synthesized thump). */
    this.voices = new Set();
    /** Last fire time per event kind, in AudioContext seconds. */
    this.lastFireAt = new Map();
    /** Last sample played per group, so it is never immediately reused. */
    this.lastSample = new Map();
    /** Sink and drag accumulators for the squelch/stretch triggers. */
    this.sinkAccum = 0;
    this.dragAccum = 0;

    this.stats = { touch: 0, squelch: 0, stretch: 0, impact: 0, pop: 0, peel: 0 };
  }

  get ready() {
    return this.readyFlag;
  }

  /**
   * Call from a user gesture. Creates and resumes the AudioContext, fetches
   * and decodes all 24 files, then builds the master graph. Any failure
   * rejects with the original error — there is no silent degradation.
   */
  async unlock() {
    if (this.readyFlag) return;

    const context = new window.AudioContext();
    this.context = context;
    await context.resume();

    const entries = await Promise.all(
      ALL_SAMPLES.map(async (name) => {
        const response = await fetch(`${this.baseUrl}${name}.mp3`);
        if (!response.ok) {
          throw new Error(`SquishAudio: ${name}.mp3 → HTTP ${response.status}`);
        }
        const data = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(data);
        return [name, buffer];
      })
    );
    this.buffers = new Map(entries);

    this.master = context.createGain();
    this.master.gain.value = this.enabled ? MASTER_GAIN : 0;
    this.compressor = context.createDynamicsCompressor();
    this.master.connect(this.compressor);
    this.compressor.connect(context.destination);

    this.readyFlag = true;
  }

  /** Master mute; ramps the master gain over 30 ms. */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.master) return;
    const now = this.context.currentTime;
    const target = this.enabled ? MASTER_GAIN : 0;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(target, now + ENABLE_RAMP_SECONDS);
  }

  setMaterial(id) {
    if (!MATERIALS.includes(id)) {
      throw new Error(`SquishAudio: unknown material '${id}'`);
    }
    this.material = id;
  }

  /** A finger touched the toy. */
  grabStart() {
    this._tryEvent('touch', () => {
      if (this._isSlime()) {
        return [{ name: this._pick('slime'), gain: 0.3, rate: 1.1, lowpass: 6000 }];
      }
      return [{ name: this._pick('squish'), gain: 0.12, rate: 1.2, lowpass: 1800 }];
    });
  }

  /** A finger left; `depth` is how deep it was pressed, in simulation units. */
  grabEnd(depth) {
    if (!(depth > POP_DEPTH)) return;
    this._tryEvent('pop', () => {
      if (this._isSlime()) {
        return [{ name: 'pop', gain: 0.4, rate: 0.9, lowpass: 7000 }];
      }
      const bouncy = this.material === 'bouncy';
      return [{ name: 'pop', gain: bouncy ? 0.3 : 0.18, rate: bouncy ? 1.0 : 0.8, lowpass: 1500 }];
    });
  }

  /**
   * Once per frame. `dt` is real seconds, `signals` is `body.signals`,
   * `dragTravel` is the total distance all dragging hands moved this frame in
   * simulation units.
   */
  update({ dt, signals, dragTravel }) {
    if (!this.readyFlag || !this.enabled) {
      this.sinkAccum = 0;
      this.dragAccum = 0;
      return;
    }

    this.sinkAccum += Math.max(0, signals.depthRate) * dt * SINK_RATE_GAIN;
    while (this.sinkAccum >= SQUELCH_STEP) {
      this.sinkAccum -= SQUELCH_STEP;
      this._tryEvent('squelch', () => this._squelchSounds(signals.depthRate));
    }

    this.dragAccum += dragTravel;
    while (this.dragAccum >= STRETCH_STEP) {
      this.dragAccum -= STRETCH_STEP;
      this._tryEvent('stretch', () => this._stretchSounds());
    }

    if (signals.impact > IMPACT_THRESHOLD) {
      this._tryEvent('impact', () => this._impactSounds(signals.impact));
    }

    if (this._isSlime() && signals.weldBreaks > 0) {
      this._tryEvent('peel', () => this._peelSounds(signals.weldBreaks));
    }
  }

  dispose() {
    this.readyFlag = false;
    this.voices.clear();
    this.lastFireAt.clear();
    this.lastSample.clear();
    this.buffers = null;
    if (this.context) {
      this.context.close();
      this.context = null;
      this.master = null;
      this.compressor = null;
    }
  }

  _isSlime() {
    return this.material === 'slime';
  }

  /** Random sample from a group, never the one played last from that group. */
  _pick(group) {
    const names = GROUPS[group];
    const last = this.lastSample.get(group);
    let index = Math.floor(Math.random() * names.length);
    if (names.length > 1 && names[index] === last) index = (index + 1) % names.length;
    const name = names[index];
    this.lastSample.set(group, name);
    return name;
  }

  _squelchSounds(depthRate) {
    if (this._isSlime()) {
      return [
        {
          name: this._pick('slime'),
          gain: clamp(depthRate / 4, 0.2, 0.8),
          rate: 0.95,
          lowpass: 8000,
        },
      ];
    }
    return [
      {
        name: this._pick('squish'),
        gain: clamp(depthRate / 6, 0.1, 0.45),
        rate: 0.9,
        lowpass: 1600,
      },
    ];
  }

  _stretchSounds() {
    if (this._isSlime()) {
      return [{ name: this._pick('slime'), gain: 0.45, rate: 1.15, lowpass: 9000 }];
    }
    return [{ name: this._pick('squish'), gain: 0.1, rate: 1.35, lowpass: 2200 }];
  }

  _impactSounds(impact) {
    const gain = clamp(impact / 20, 0.15, 0.7);
    if (this._isSlime()) {
      return [
        { name: 'splat', gain, rate: 0.9, lowpass: 5000 },
        { name: this._pick('slime'), gain: gain * 0.6, rate: 0.95, lowpass: 8000 },
      ];
    }
    return [
      { name: 'splat', gain, rate: 0.75, lowpass: 900 },
      { thump: true, gain },
    ];
  }

  _peelSounds(weldBreaks) {
    return [
      { name: 'slime_12', gain: clamp(weldBreaks / 40, 0.1, 0.5), rate: 1.4, lowpass: 9000 },
    ];
  }

  /**
   * Fire one event if it is allowed: ready, enabled, past the same-kind gap,
   * and there is room for every voice it needs. Only a real fire counts.
   */
  _tryEvent(kind, build) {
    if (!this.readyFlag || !this.enabled) return false;

    const now = this.context.currentTime;
    const last = this.lastFireAt.get(kind);
    if (last !== undefined && (now - last) * 1000 < SAME_KIND_GAP_MS) return false;

    const sounds = build();
    if (this.voices.size + sounds.length > MAX_VOICES) return false;

    for (const sound of sounds) {
      if (sound.thump) this._playThump(sound.gain);
      else this._playSample(sound.name, sound);
    }
    this.lastFireAt.set(kind, now);
    this.stats[kind] += 1;
    return true;
  }

  _playSample(name, { gain, rate, lowpass }) {
    const context = this.context;
    const source = context.createBufferSource();
    source.buffer = this.buffers.get(name);
    source.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * RATE_JITTER);

    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lowpass;

    const env = context.createGain();
    const now = context.currentTime;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + ATTACK_SECONDS);

    source.connect(filter).connect(env).connect(this.master);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      env.disconnect();
      this.voices.delete(source);
    };

    this.voices.add(source);
    source.start(now);
  }

  /** A short sine thump (110 → 55 Hz) that fattens an impact. */
  _playThump(gain) {
    const context = this.context;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(110, now);
    oscillator.frequency.exponentialRampToValueAtTime(55, now + THUMP_SECONDS);

    const env = context.createGain();
    const peak = gain * 0.8;
    const releaseAt = now + THUMP_SECONDS - THUMP_RELEASE_SECONDS;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + ATTACK_SECONDS);
    env.gain.setValueAtTime(peak, releaseAt);
    env.gain.linearRampToValueAtTime(0, now + THUMP_SECONDS);

    oscillator.connect(env).connect(this.master);
    oscillator.onended = () => {
      oscillator.disconnect();
      env.disconnect();
      this.voices.delete(oscillator);
    };

    this.voices.add(oscillator);
    oscillator.start(now);
    oscillator.stop(now + THUMP_SECONDS);
  }
}
