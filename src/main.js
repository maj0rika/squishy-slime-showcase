import { App } from './app.js';

const canvas = document.getElementById('scene');
const stageEl = document.getElementById('stage');
const panelEl = document.getElementById('panel');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const fallbackEl = document.getElementById('fallback');
const appEl = document.getElementById('app');

function webgl2Available() {
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2');
  if (!gl) return false;
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return true;
}

if (!webgl2Available()) {
  fallbackEl.hidden = false;
  appEl.classList.add('is-unsupported');
} else {
  const app = new App({ canvas, stageEl, panelEl, statusEl, statusTextEl });
  // The App reports a failed studio-HDR load in the status pill and rethrows;
  // the module evaluation rejects with that same error (no fallback).
  await app.init();
  window.__squishApp = app;
}
