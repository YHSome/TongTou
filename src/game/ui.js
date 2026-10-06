/**
 * DOM screens: title, difficulty select, settings, help, pause, results.
 * Also owns the toast and the settings widgets bound to the settings object.
 */

import {
  defaultSettings, KEY_PRESETS, codeLabel, isReservedKey,
  normalizeKeys, presetFor, RENDER_SCALES,
} from './config.js';
import { DIFFICULTY_ORDER, difficultyLevel } from './chart.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function show(screenId) {
  // the tip modal belongs to the result screen; any other screen must not have
  // it hanging over the top (leaving via a keyboard shortcut would otherwise
  // strand it there)
  if (screenId !== 'result') closeSponsor();
  for (const el of $$('.screen')) el.classList.toggle('is-active', el.id === screenId);
  document.body.dataset.screen = screenId;
}

export function activeScreen() {
  return $('.screen.is-active')?.id || null;
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function setBootProgress(frac, note) {
  const fill = $('#boot-fill');
  if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  if (note) $('#boot-note').textContent = note;
}

/* ------------------------------------------------------------------------ */
/* settings widgets                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Describes every setting: how to read/write it and how to render its control.
 * Keeping this declarative means the settings screen and the "reset to
 * defaults" action always agree.
 */
/**
 * The whole settings screen.
 *
 * This is meant to be a small game, so everything a player does not need to
 * touch is a constant in `config.js` instead of a control.  What is left is the
 * handful that genuinely depends on the player: which keys they use, how fast
 * the notes fall, their audio offset, the two loudness controls, and the show
 * effect.  Keep this list short — there is a test that fails if it grows.
 */
export const SETTING_SPECS = [
  {
    key: 'laneKeys', label: '轨道键位', hint: '点击方框后按下你想用的键（Esc 取消）', type: 'keys',
  },
  {
    key: 'scrollSpeed', label: '下落速度', hint: '数值越大音符越快', type: 'range',
    min: 0.25, max: 4, step: 0.05, fmt: (v) => `${v.toFixed(2)}×`,
  },
  {
    key: 'offsetMs', label: '判定偏移', hint: '总觉得按早了就调大；调整时会显示实时偏差', type: 'range',
    min: -180, max: 180, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${v} ms`,
  },
  {
    key: 'volume', label: '音量', type: 'range',
    min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`,
  },
  { key: 'hitSound', label: '打击音效', hint: '每次成功判定的清脆音', type: 'bool' },
  { key: 'concertFx', label: '演出特效', hint: '高潮段落的全屏演出', type: 'bool' },
];

export function buildSettings(root, settings, onChange) {
  buildControls(root, settings, SETTING_SPECS, onChange);
}

/**
 * Everything that used to be a setting and was deliberately taken off the
 * player-facing screen.
 *
 * The rule stayed the same — a small game should not hand a player a wall of
 * knobs — but "not on the settings screen" turned out to mean "unreachable",
 * which is its own problem when you are the one tuning the thing.  So they live
 * here instead: same widgets, hidden behind developer mode.
 */
export const DEV_SPECS = [
  {
    group: '画面',
    key: 'renderScale', label: '渲染分辨率', hint: 'auto 已是「桌面 4K / 手机 2.4MP」的良好默认',
    type: 'select', options: RENDER_SCALES.map((r) => [r.id, r.label]), wide: true,
  },
  {
    group: '画面',
    key: 'layout', label: '界面布局', hint: 'auto 按设备自动判断',
    type: 'select',
    options: [['auto', '自动'], ['desktop', '桌面（BMS 竖条）'], ['handheld', '全宽四轨']],
  },
  { group: '画面', key: 'backgroundDim', label: '整体压暗', type: 'range', min: 0, max: 0.95, step: 0.01, fmt: (v) => v.toFixed(2) },
  { group: '画面', key: 'visualizer', label: '频谱可视化', type: 'bool' },
  { group: '画面', key: 'showKeyCues', label: '键位提示', type: 'bool' },
  { group: '画面', key: 'fullscreenOnStart', label: '开局全屏', hint: '默认关；开着时只对触屏设备生效', type: 'bool' },

  {
    group: '手感',
    key: 'noteTravel', label: '下落时长', hint: '速度 1.00× 时的下落秒数；与「下落速度」是同一件事',
    type: 'range', min: 0.3, max: 1.6, step: 0.02, fmt: (v) => `${v.toFixed(2)} s`,
  },
  {
    group: '手感',
    key: 'hitFx', label: '打击反馈', type: 'select',
    options: [['off', '关闭'], ['normal', '普通'], ['strong', '强烈']],
  },
  { group: '手感', key: 'showOffsetGuide', label: '实时判定偏差', hint: '拖动「判定偏移」时本来就会自动出现 4 秒', type: 'bool' },
  { group: '手感', key: 'noFail', label: '练习模式', hint: '血条归零也不会失败', type: 'bool' },

  {
    group: '音声',
    key: 'hitGain', label: '打击音效音量', hint: '相对主音量的比例，原来固定 0.7',
    type: 'range', min: 0, max: 1.5, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%`,
  },

  {
    group: '调试',
    key: 'autoPlay', label: '自动演奏（AUTO）', hint: 'F2 或画面顶部的指示条也能开，刷新后不会保留',
    type: 'bool',
  },
];

/** Build one control per spec.  Shared by the settings and developer screens. */
export function buildControls(root, settings, specs, onChange) {
  root.innerHTML = '';
  let lastGroup = null;

  for (const spec of specs) {
    if (spec.group && spec.group !== lastGroup) {
      lastGroup = spec.group;
      const head = document.createElement('div');
      head.className = 'setting-group';
      head.textContent = spec.group;
      root.appendChild(head);
    }

    const row = document.createElement('div');
    row.className = 'setting';
    if (spec.type === 'keys' || spec.wide) row.classList.add('setting-wide');

    const label = document.createElement('div');
    label.className = 'setting-label';
    label.innerHTML = `<span class="sl">${spec.label}</span>`
      + (spec.hint ? `<small>${spec.hint}</small>` : '');
    row.appendChild(label);

    const ctrl = document.createElement('div');
    ctrl.className = 'setting-control';

    if (spec.type === 'keys') {
      buildKeyBinder(ctrl, settings, onChange);
    } else if (spec.type === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = spec.min; input.max = spec.max; input.step = spec.step;
      input.value = settings[spec.key];
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = spec.fmt(Number(settings[spec.key]));

      input.addEventListener('input', () => {
        const v = Number(input.value);
        settings[spec.key] = v;
        val.textContent = spec.fmt(v);
        onChange(spec.key, v);
      });
      ctrl.append(input, val);
    } else if (spec.type === 'bool') {
      const sw = document.createElement('button');
      sw.className = 'switch';
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(!!settings[spec.key]));
      sw.addEventListener('click', () => {
        settings[spec.key] = !settings[spec.key];
        sw.setAttribute('aria-checked', String(!!settings[spec.key]));
        onChange(spec.key, settings[spec.key]);
      });
      ctrl.appendChild(sw);
    } else if (spec.type === 'select') {
      const sel = document.createElement('select');
      sel.className = 'sel';
      for (const [v, text] of spec.options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = text;
        sel.appendChild(o);
      }
      sel.value = String(settings[spec.key]);
      sel.addEventListener('change', () => {
        settings[spec.key] = sel.value;
        onChange(spec.key, sel.value);
      });
      ctrl.appendChild(sel);
    }

    row.appendChild(ctrl);
    root.appendChild(row);
  }
}

/* ------------------------------------------------------------------------ */
/* key binder                                                                */
/* ------------------------------------------------------------------------ */

/** Only one binder may listen at a time, across rebuilds of the panel. */
let activeCapture = null;

/**
 * Four rebindable lane slots plus a preset picker.
 *
 * Clicking a slot arms it; the next key press becomes the binding.  Because a
 * plain `keydown` listener would race the game's own input handling, the
 * capture runs in the capture phase and swallows the event entirely.
 */
function buildKeyBinder(host, settings, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'keybinder';

  const slots = document.createElement('div');
  slots.className = 'keyslots';

  const buttons = [0, 1, 2, 3].map((lane) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'keyslot';
    b.dataset.lane = String(lane);
    b.textContent = codeLabel(settings.laneKeys[lane]);
    b.addEventListener('click', () => arm(lane));
    slots.appendChild(b);
    return b;
  });

  const preset = document.createElement('select');
  preset.className = 'sel keypreset';
  for (const p of KEY_PRESETS) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label;
    preset.appendChild(o);
  }
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = '自定义';
  preset.appendChild(custom);
  preset.value = presetFor(settings.laneKeys);

  preset.addEventListener('change', () => {
    const p = KEY_PRESETS.find((x) => x.id === preset.value);
    if (!p) return;
    settings.laneKeys = p.codes.slice();
    paint();
    say(`已套用预设：${p.label}`);
    onChange('laneKeys', settings.laneKeys);
  });

  const status = document.createElement('span');
  status.className = 'keystatus';

  wrap.append(slots, preset, status);
  host.appendChild(wrap);

  /** Repaint the slots and preset from `settings`; leaves the message alone. */
  function paint() {
    settings.laneKeys.forEach((code, lane) => {
      buttons[lane].textContent = codeLabel(code);
      buttons[lane].classList.remove('armed');
    });
    preset.value = presetFor(settings.laneKeys);
  }

  function say(text, live = false) {
    status.textContent = text || '';
    status.classList.toggle('live', !!live);
  }

  function arm(lane) {
    if (activeCapture) activeCapture();
    paint();
    buttons[lane].classList.add('armed');
    buttons[lane].textContent = '按键…';
    say('按下要绑定的键 · Esc 取消', true);

    const stop = () => {
      activeCapture = null;
      window.removeEventListener('keydown', onKey, true);
    };

    const onKey = (e) => {
      // swallow the event entirely so the game's own handler never sees it
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;

      if (e.code === 'Escape') {
        stop();
        paint();
        say('');
        return;
      }

      if (isReservedKey(e.code)) {
        say(`${codeLabel(e.code)} 被系统功能占用，请换一个键`, true);
        return;
      }

      const next = settings.laneKeys.slice();
      const clash = next.indexOf(e.code);
      if (clash === lane) {
        stop();
        paint();
        say('');
        return;
      }

      let note;
      if (clash >= 0) {
        // swap rather than refuse — the player's intent is unambiguous
        const displaced = next[lane];
        next[clash] = displaced;
        next[lane] = e.code;
        note = `与轨道 ${clash + 1} 交换：${codeLabel(e.code)} ↔ ${codeLabel(displaced)}`;
      } else {
        next[lane] = e.code;
        note = `轨道 ${lane + 1} → ${codeLabel(e.code)}`;
      }
      settings.laneKeys = normalizeKeys(next);

      stop();
      paint();
      say(note);
      onChange('laneKeys', settings.laneKeys);
    };

    activeCapture = () => {
      stop();
      paint();
    };
    window.addEventListener('keydown', onKey, true);
  }
}

export function resetSettings(settings) {
  Object.assign(settings, defaultSettings());
  return settings;
}

/* ------------------------------------------------------------------------ */
/* difficulty cards                                                          */
/* ------------------------------------------------------------------------ */

export function renderDifficulties(root, charts, activeName, onPick) {
  root.innerHTML = '';
  const names = DIFFICULTY_ORDER.filter((n) => charts[n]).concat(
    Object.keys(charts).filter((n) => !DIFFICULTY_ORDER.includes(n)));

  for (const name of names) {
    const t = charts[name];
    const card = document.createElement('button');
    card.className = 'diff';
    card.type = 'button';
    card.dataset.d = name;
    card.setAttribute('aria-selected', String(name === activeName));

    const nps = t.total / Math.max(1, t.duration);
    card.innerHTML = `
      <div class="diff-name">${name.toUpperCase()}</div>
      <div class="diff-lv">${difficultyLevel(t)}</div>
      <div class="diff-meta">${t.total} NOTES · ${nps.toFixed(2)} NPS</div>`;

    card.addEventListener('click', () => onPick(name));
    root.appendChild(card);
  }
}

/* ------------------------------------------------------------------------ */
/* 赞赏                                                                       */
/* ------------------------------------------------------------------------ */

/**
 * A static tip dialog: a WeChat receive-money QR and a thank-you.
 *
 * There is no network request anywhere in here and nothing is persisted — it is
 * a picture in a box.  It is opened from the result screen only, and `show()`
 * closes it the moment the result screen goes away so a keyboard shortcut can
 * never strand it on top of the title screen.
 */
let sponsorOpen = false;
let sponsorBound = false;

export function isSponsorOpen() {
  return sponsorOpen;
}

function sponsorModal() {
  return $('#sponsor-modal');
}

function bindSponsorOnce() {
  if (sponsorBound) return;
  sponsorBound = true;

  const modal = sponsorModal();
  if (!modal) return;

  $('#sponsor-x')?.addEventListener('click', closeSponsor);
  $('#sponsor-ok')?.addEventListener('click', closeSponsor);
  // clicking the dimmed backdrop (but not the card itself) dismisses it
  modal.addEventListener('click', (e) => { if (e.target === modal) closeSponsor(); });
}

export function openSponsor() {
  bindSponsorOnce();
  const modal = sponsorModal();
  if (!modal) return false;
  sponsorOpen = true;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  return true;
}

export function closeSponsor() {
  if (!sponsorOpen) return false;
  sponsorOpen = false;
  const modal = sponsorModal();
  modal?.classList.remove('is-open');
  modal?.setAttribute('aria-hidden', 'true');
  // Otherwise focus stays on a button that was just hidden — and a stray Space
  // on the result screen would then re-open the dialog.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  return true;
}

/* ------------------------------------------------------------------------ */
/* results                                                                   */
/* ------------------------------------------------------------------------ */

export function renderResult(summary, timeline, difficulty) {
  $('#res-eyebrow').textContent = `${timeline.meta.title} · ${difficulty.toUpperCase()}`;
  const rank = $('#res-rank');
  rank.textContent = summary.rank;
  rank.dataset.r = summary.rank;

  $('#res-score').textContent = String(summary.score);
  $('#res-acc').textContent = `${(summary.accuracy * 100).toFixed(2)}%`;
  $('#res-combo').textContent = `MAX COMBO ${summary.maxCombo}`;
  $('#res-clear').textContent = summary.failed ? 'FAILED' : summary.clear ? 'CLEARED' : '—';
  $('#res-clear').style.color = summary.failed ? 'var(--bad)' : 'var(--great)';

  const pct = summary.maxBonus > 0
    ? Math.round((summary.bonus / summary.maxBonus) * 100)
    : 0;
  const cells = [
    ['PERFECT', summary.counts.perfect, '#ffe9a8'],
    ['GREAT', summary.counts.great, '#8ef2c4'],
    ['GOOD', summary.counts.good, '#7fc4ff'],
    ['BAD', summary.counts.bad, '#ff8fa3'],
    ['MISS', summary.counts.miss, '#8b93a8'],
    ['NOTES', summary.total, '#c9d8f5'],
    ['理论值', String(summary.bonus), '#ffd166'],
    ['满分', String(summary.maxScore), '#c9d8f5'],
  ];
  const grid = $('#res-grid');
  grid.innerHTML = '';
  for (const [label, value, color] of cells) {
    const d = document.createElement('div');
    d.className = 'rcell';
    d.innerHTML = `<p class="label">${label}</p><p class="num" style="color:${color}">${value}</p>`;
    if (label === '理论值') {
      d.querySelector('.label').textContent = `理论值 ${pct}%`;
      d.title = `命中越准，「理论值」越高：每个 PERFECT 得 ${summary.maxBonus / Math.max(1, summary.total)} - 偏差毫秒数`
        + `（本次 ${summary.bonus} / 满分 ${summary.maxBonus}）`;
    }
    grid.appendChild(d);
  }
}
