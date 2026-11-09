// Shared React pieces of the VoiceDock design system, used by the popup and the
// settings page: <Icon>, <EngineStatus>, <EngineMono> and useEngines(), the
// live engine check. Styles live in extension/tokens.css (.vd-*).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ICONS } from './icons.js';
import {
  ENGINE_SEEN_KEY,
  engineDetail,
  engineInstalled,
  engineMono,
  engineState,
  fetchEngines,
  LOCAL_ENGINE_IDS,
  markEngineSeen,
  STATUS_LABEL,
  STATUS_SHORT,
} from './shared.js';

// size: 's' (14px), 'm' (16px, default) or 'l' (20px). Decorative unless a
// label is given.
export function Icon({ name, size = 'm', className = '', label, spin = false }) {
  const spec = ICONS[name];
  if (!spec) return null;
  const cls = ['i', size === 's' ? 's' : size === 'l' ? 'l' : '', spec.fill ? 'fill' : '', spin ? 'vd-spin' : '', className]
    .filter(Boolean).join(' ');
  return (
    <svg className={cls} viewBox={spec.view || '0 0 24 24'} aria-hidden={label ? undefined : 'true'} role={label ? 'img' : undefined} aria-label={label} focusable="false">
      {spec.shapes.map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

// The one status pill. variant: 'pill' (default), 'compact' (text and dot, no
// fill) or 'dot' (the dot alone, with the word as its tooltip). short uses
// "Not running" for "Installed but not running" where space is tight.
export function EngineStatus({ state, variant = 'pill', short = false, className = '' }) {
  const label = (short ? STATUS_SHORT : STATUS_LABEL)[state] || STATUS_LABEL.checking;
  const cls = ['vd-status', state, variant === 'pill' ? '' : variant, className].filter(Boolean).join(' ');
  if (variant === 'dot') return <span className={cls} title={STATUS_LABEL[state]} role="img" aria-label={STATUS_LABEL[state]} />;
  return <span className={cls} data-state={state}>{label}</span>;
}

export function EngineMono({ engine, small = false }) {
  return <span className={`vd-mono${small ? ' sm' : ''}`} aria-hidden="true">{engineMono(engine)}</span>;
}

// Asks the hub for every engine now and every pollMs while the page is
// visible (one GET /engines), and remembers which engines were ever set up,
// so while the hub is not running an engine reads as "Installed but not
// running" rather than "Not installed".
//   engines[id] = { state, entry, detail }   entry: the hub's own report
//   hub: what GET /engines said (undefined until it answers)
//   recheck() checks again now
export function useEngines({ pollMs = 0 } = {}) {
  const [hub, setHub] = useState(undefined);
  const [seen, setSeen] = useState(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [checking, setChecking] = useState(false);
  const seenRef = useRef(null);

  useEffect(() => {
    let disposed = false;
    chrome.storage.local.get(ENGINE_SEEN_KEY).then((stored) => {
      if (disposed) return;
      const map = stored?.[ENGINE_SEEN_KEY] || {};
      seenRef.current = { ...map, ...(seenRef.current || {}) };
      setSeen(seenRef.current);
    }).catch(() => { seenRef.current = seenRef.current || {}; setSeen(seenRef.current); });
    const onChanged = (changes, area) => {
      if (area === 'local' && changes[ENGINE_SEEN_KEY]) {
        seenRef.current = changes[ENGINE_SEEN_KEY].newValue || {};
        setSeen(seenRef.current);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => { disposed = true; chrome.storage.onChanged.removeListener(onChanged); };
  }, []);

  const recheck = useCallback(async () => {
    setChecking(true);
    const next = await fetchEngines();
    setHub(next);
    let nextSeen = seenRef.current;
    for (const id of LOCAL_ENGINE_IDS) {
      if (!engineInstalled(id, next)) continue;
      const marked = markEngineSeen(nextSeen, id);
      if (marked) nextSeen = marked;
    }
    if (nextSeen !== seenRef.current) {
      seenRef.current = nextSeen;
      setSeen(nextSeen);
      chrome.storage.local.set({ [ENGINE_SEEN_KEY]: nextSeen }).catch(() => {});
    }
    setCheckedAt(Date.now());
    setChecking(false);
    return next;
  }, []);

  useEffect(() => {
    recheck();
    if (!pollMs) return undefined;
    const timer = setInterval(() => { if (!document.hidden) recheck(); }, pollMs);
    return () => clearInterval(timer);
  }, [recheck, pollMs]);

  const engines = { browser: { state: 'ready', entry: null, detail: 'Built into Chrome.' } };
  for (const id of LOCAL_ENGINE_IDS) {
    // Until the remembered list loads, an engine the hub can't vouch for is
    // still "Checking", so it never flashes "Not installed" first.
    const waiting = hub === undefined || (seen === null && !hub.reachable);
    const state = waiting ? 'checking' : engineState(id, hub, seen?.[id]);
    engines[id] = { state, entry: hub?.engines?.[id] || null, detail: waiting ? '' : engineDetail(id, hub, state) };
  }
  return { engines, hub, recheck, checking, checkedAt };
}
