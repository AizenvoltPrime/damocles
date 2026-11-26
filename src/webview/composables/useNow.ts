import { onScopeDispose, ref } from 'vue';

const tick = ref(0);
let scopes = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
// whether a computed or a render read the time since the last tick
let read = false;

function stop(): void {
  clearTimeout(timer);
  timer = undefined;
}

// at the next whole second, so a mm:ss clock neither lags nor skips a second
function schedule(): void {
  timer = setTimeout(step, 1000 - (Date.now() % 1000));
}

// A tick reruns every reader still on screen, and each one that counts reads the time again; a tick that none read was the last.
function step(): void {
  if (!read) return stop();
  read = false;
  tick.value++;
  schedule();
}

function now(): number {
  read = true;
  if (timer === undefined) schedule();
  void tick.value;
  return Date.now();
}

/**
 * The current time, for text that counts down. Whatever reads it inside a computed or a render reruns each second; every
 * caller shares one timer, which runs only while some text still reads the time, and stops when the last caller's scope ends.
 */
export function useNow(): () => number {
  scopes++;
  onScopeDispose(() => {
    if (--scopes === 0) stop();
  });
  return now;
}
