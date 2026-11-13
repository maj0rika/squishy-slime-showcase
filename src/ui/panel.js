import { COLOR_PRESETS, PAINT_PRESETS, getColor } from '../render/materials.js';
import { FEEL_PRESETS } from '../physics/presets.js';

const SLIDERS = [
  { key: 'firmness', label: '단단함', lo: '말랑', hi: '단단' },
  { key: 'recovery', label: '복원력', lo: '그대로', hi: '원래대로' },
  { key: 'damping', label: '감쇠', lo: '출렁', hi: '차분' },
];

const TEMPLATE = `
  <div class="panel__head">
    <p class="panel__title">컨트롤</p>
    <p class="panel__meta" id="panel-meta">슬라임 · 모찌 실리콘</p>
  </div>

  <div class="section">
    <span class="section__label">색</span>
    <p class="field__name">몸 색</p>
    <div class="swatches" id="swatches"></div>
    <p class="swatch__name" id="tint-name">딸기우유</p>
    <p class="field__name field__name--spaced">물감</p>
    <div class="swatches" id="paint-swatches"></div>
    <p class="paint-hint">물감을 넣고 주무르면 섞여요</p>
  </div>

  <div class="section">
    <span class="section__label">촉감</span>
    <div class="chips" id="feel-chips"></div>
    <div id="fields"></div>
  </div>

  <div class="section">
    <span class="section__label">동작</span>
    <div class="actions actions--grid">
      <button class="btn" id="btn-reset" type="button">초기화</button>
      <button class="btn" id="btn-pause" type="button" aria-pressed="false">일시정지</button>
      <button class="btn" id="btn-sound" type="button" aria-pressed="true">소리 켜짐</button>
      <button class="btn" id="btn-poke" type="button">톡 찌르기</button>
      <button class="btn" id="btn-drop" type="button">떨어뜨리기</button>
    </div>
  </div>

  <details class="disclosure" id="notes-disclosure">
    <summary>메모</summary>
    <div class="disclosure__body">
      <p class="notes">속을 사면체 격자로 채운 입체로 시뮬레이션하고, 매끄러운 표면은 그 격자에 박아(스키닝) 그립니다. 변 길이와 사면체 부피를 XPBD 제약으로 유지해서, 어느 한 곳을 눌러도 부피가 보존되어 옆으로 퍼지고, 늘리면 주변까지 끌려옵니다.</p>
      <p class="notes">접으면 닿은 부분이 서로 붙어(용접) 한 덩어리로 합쳐지고, 물감을 넣고 주무르면 색이 점점 섞입니다. 복원력을 낮추면(슬라임) 변형이 그대로 남고, 높이면(탱탱볼) 원래 모양으로 빠르게 돌아옵니다.</p>
    </div>
  </details>

  <details class="disclosure" id="debug-disclosure">
    <summary>디버그</summary>
    <div class="disclosure__body">
      <div class="checks">
        <label class="check"><input type="checkbox" id="dbg-wire" /> <span>와이어프레임</span></label>
        <label class="check"><input type="checkbox" id="dbg-points" checked /> <span>제어점</span></label>
        <label class="check"><input type="checkbox" id="dbg-contact" checked /> <span>바닥 접촉</span></label>
        <label class="check"><input type="checkbox" id="dbg-field" checked /> <span>잡기 범위</span></label>
      </div>
      <dl class="stats">
        <dt>노드 수</dt><dd id="st-nodes">—</dd>
        <dt>사면체 수</dt><dd id="st-tets">—</dd>
        <dt>표면 정점</dt><dd id="st-surface">—</dd>
        <dt>부피 유지율</dt><dd id="st-volume">—</dd>
        <dt>최대 늘어남</dt><dd id="st-stretch">—</dd>
        <dt>접촉 반경</dt><dd id="st-contact">—</dd>
        <dt>뒤집힌 사면체</dt><dd id="st-flipped">—</dd>
        <dt>용접(합쳐진 지점)</dt><dd id="st-welds">—</dd>
        <dt>렌더</dt><dd id="st-mode">—</dd>
        <dt>슬라임 표면 갱신 ms</dt><dd id="st-sync">—</dd>
        <dt>FPS</dt><dd id="st-fps">—</dd>
      </dl>
    </div>
  </details>

  <p class="panel__foot">three.js r170 · WebGL2 · XPBD</p>
`;

export class Panel {
  constructor({
    root,
    onColor,
    onPaint,
    onFeel,
    onPhysics,
    onReset,
    onPause,
    onSound,
    onPoke,
    onDrop,
    onDebug,
  }) {
    this.root = root;
    this.onColor = onColor;
    this.onPaint = onPaint;
    this.onFeel = onFeel;
    this.onPhysics = onPhysics;
    this.onReset = onReset;
    this.onPause = onPause;
    this.onSound = onSound;
    this.onPoke = onPoke;
    this.onDrop = onDrop;
    this.onDebug = onDebug;
    this.soundOn = true;

    root.innerHTML = TEMPLATE;

    this.$ = (id) => root.querySelector(`#${id}`);
    this.refs = {
      meta: this.$('panel-meta'),
      swatches: this.$('swatches'),
      paintSwatches: this.$('paint-swatches'),
      tintName: this.$('tint-name'),
      feelChips: this.$('feel-chips'),
      fields: this.$('fields'),
      reset: this.$('btn-reset'),
      pause: this.$('btn-pause'),
      sound: this.$('btn-sound'),
      poke: this.$('btn-poke'),
      drop: this.$('btn-drop'),
      debug: this.$('debug-disclosure'),
      wire: this.$('dbg-wire'),
      points: this.$('dbg-points'),
      contact: this.$('dbg-contact'),
      field: this.$('dbg-field'),
      stNodes: this.$('st-nodes'),
      stTets: this.$('st-tets'),
      stSurface: this.$('st-surface'),
      stVolume: this.$('st-volume'),
      stStretch: this.$('st-stretch'),
      stContact: this.$('st-contact'),
      stFlipped: this.$('st-flipped'),
      stWelds: this.$('st-welds'),
      stMode: this.$('st-mode'),
      stSync: this.$('st-sync'),
      stFps: this.$('st-fps'),
    };

    this.buildSwatches();
    this.buildPaintSwatches();
    this.buildFeelChips();
    this.buildSliders();
    this.bind();
  }

  buildSwatches() {
    for (const preset of COLOR_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.dataset.color = preset.id;
      button.setAttribute('aria-label', preset.label);
      button.setAttribute('aria-pressed', 'false');
      button.title = preset.label;
      button.style.setProperty('--sw', preset.base);
      button.style.setProperty('--sw-deep', preset.deep);
      button.addEventListener('click', () => this.onColor(preset.id));
      this.refs.swatches.appendChild(button);
    }
  }

  buildPaintSwatches() {
    for (const preset of PAINT_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch swatch--paint';
      button.dataset.paint = preset.id;
      button.setAttribute('aria-label', preset.label);
      button.title = preset.label;
      button.style.setProperty('--sw', preset.hex);
      button.style.setProperty('--sw-deep', preset.hex);
      button.addEventListener('click', () => this.onPaint(preset.id));
      this.refs.paintSwatches.appendChild(button);
    }
  }

  buildFeelChips() {
    for (const preset of FEEL_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.dataset.feel = preset.id;
      button.setAttribute('aria-pressed', 'false');
      button.textContent = preset.label;
      button.addEventListener('click', () => this.onFeel(preset.id));
      this.refs.feelChips.appendChild(button);
    }
  }

  buildSliders() {
    for (const slider of SLIDERS) {
      const field = document.createElement('label');
      field.className = 'field';

      const head = document.createElement('span');
      head.className = 'field__head';

      const name = document.createElement('span');
      name.className = 'field__name';
      name.textContent = slider.label;

      const value = document.createElement('span');
      value.className = 'field__value';
      value.textContent = '0';

      head.append(name, value);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.value = '0';
      input.dataset.key = slider.key;
      input.setAttribute('aria-label', slider.label);

      const ends = document.createElement('span');
      ends.className = 'field__ends';
      const lo = document.createElement('span');
      lo.textContent = slider.lo;
      const hi = document.createElement('span');
      hi.textContent = slider.hi;
      ends.append(lo, hi);

      input.addEventListener('input', () => {
        this.paintSlider(input, value);
        this.onPhysics({ [slider.key]: Number(input.value) / 100 });
      });

      field.append(head, input, ends);
      this.refs.fields.appendChild(field);
      input._output = value;
    }
  }

  paintSlider(input, output) {
    input.style.setProperty('--p', `${input.value}%`);
    output.textContent = input.value;
  }

  bind() {
    this.refs.reset.addEventListener('click', () => this.onReset());
    this.refs.pause.addEventListener('click', () => this.onPause());
    this.refs.sound.addEventListener('click', () => this.onSound(!this.soundOn));
    this.refs.poke.addEventListener('click', () => this.onPoke());
    this.refs.drop.addEventListener('click', () => this.onDrop());

    this.refs.debug.addEventListener('toggle', () => this.onDebug(this.refs.debug.open));
    this.refs.wire.addEventListener('change', () => this.onDebugToggle());
    this.refs.points.addEventListener('change', () => this.onDebugToggle());
    this.refs.contact.addEventListener('change', () => this.onDebugToggle());
    this.refs.field.addEventListener('change', () => this.onDebugToggle());
  }

  onDebugToggle() {
    this.onDebug(this.refs.debug.open);
  }

  debugState() {
    return {
      wireframe: this.refs.wire.checked,
      points: this.refs.points.checked,
      contact: this.refs.contact.checked,
      field: this.refs.field.checked,
    };
  }

  setColor(id) {
    const preset = getColor(id);
    this.refs.tintName.textContent = preset.label;
    for (const button of this.refs.swatches.children) {
      button.setAttribute('aria-pressed', String(button.dataset.color === id));
    }
  }

  setFeel(id) {
    for (const button of this.refs.feelChips.children) {
      button.setAttribute('aria-pressed', String(button.dataset.feel === id));
    }
  }

  setPhysics(values) {
    for (const input of this.refs.fields.querySelectorAll('input[type="range"]')) {
      const key = input.dataset.key;
      const pct = Math.round(values[key] * 100);
      input.value = String(pct);
      this.paintSlider(input, input._output);
    }
  }

  setPaused(paused) {
    this.refs.pause.textContent = paused ? '재개' : '일시정지';
    this.refs.pause.setAttribute('aria-pressed', String(paused));
  }

  setSound(on) {
    this.soundOn = on;
    this.refs.sound.textContent = on ? '소리 켜짐' : '소리 꺼짐';
    this.refs.sound.setAttribute('aria-pressed', String(on));
  }

  setMeta(shapeName, materialLabel) {
    this.refs.meta.textContent = `${shapeName} · ${materialLabel}`;
  }

  setStats({
    nodes,
    tets,
    surfaceVerts,
    volumeRatio,
    maxStretch,
    contactRadius,
    flipped,
    welds,
    mode,
    lastSyncMs,
    fps,
  }) {
    this.refs.stNodes.textContent = String(nodes);
    this.refs.stTets.textContent = String(tets);
    this.refs.stSurface.textContent = String(surfaceVerts);
    this.refs.stVolume.textContent = `${(volumeRatio * 100).toFixed(1)}%`;
    this.refs.stStretch.textContent = `${maxStretch.toFixed(2)}×`;
    this.refs.stContact.textContent = contactRadius.toFixed(2);
    this.refs.stFlipped.textContent = String(flipped);
    this.refs.stWelds.textContent = String(welds);
    this.refs.stMode.textContent = mode === 'implicit' ? '슬라임 표면' : '매끈 표면';
    this.refs.stSync.textContent =
      mode === 'implicit' ? lastSyncMs.toFixed(1) : '—';
    this.refs.stFps.textContent = `${fps} fps`;
  }
}
