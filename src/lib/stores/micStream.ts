/**
 * Shared microphone stream manager.
 *
 * `getUserMedia` is the slowest step of starting a recording (device
 * acquisition, often hundreds of ms on Windows), and open mic, recordings and
 * dictation all want the same device. So the app holds ONE live MediaStream
 * per device and hands out ref-counted leases: while open mic is listening,
 * the stream is already open and starting a recording attaches to it
 * instantly instead of re-acquiring the hardware.
 *
 * Consumers must NEVER stop the leased stream's tracks — call
 * `lease.release()` instead. Tracks are stopped only when the last lease is
 * gone, after a short linger (so back-to-back recordings stay warm even with
 * open mic off). The linger means the OS mic-in-use indicator stays lit
 * briefly after a recording ends.
 */

const RELEASE_LINGER_MS = 15_000;

export interface MicLease {
  stream: MediaStream;
  release: () => void;
}

interface Entry {
  key: string;
  stream: MediaStream;
  refs: number;
  lingerTimer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();
const pendingAcquires = new Map<string, Promise<MediaStream>>();

function keyFor(deviceId?: string): string {
  return deviceId || '__default__';
}

function isLive(stream: MediaStream): boolean {
  return stream.getAudioTracks().some((t) => t.readyState === 'live');
}

function dispose(entry: Entry) {
  if (entry.lingerTimer) {
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = null;
  }
  entries.delete(entry.key);
  entry.stream.getTracks().forEach((track) => track.stop());
}

function scheduleDispose(entry: Entry) {
  if (entry.lingerTimer) clearTimeout(entry.lingerTimer);
  entry.lingerTimer = setTimeout(() => {
    entry.lingerTimer = null;
    if (entry.refs <= 0) dispose(entry);
  }, RELEASE_LINGER_MS);
}

export async function acquireMicStream(deviceId?: string): Promise<MicLease> {
  const key = keyFor(deviceId);

  let entry = entries.get(key);
  // Device unplugged / tracks ended externally — drop the dead entry and re-acquire.
  if (entry && !isLive(entry.stream)) {
    dispose(entry);
    entry = undefined;
  }

  if (!entry) {
    // De-dupe concurrent acquires of the same device (e.g. open mic restarting
    // while a recording starts).
    let pending = pendingAcquires.get(key);
    if (!pending) {
      pending = navigator.mediaDevices
        .getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        })
        .finally(() => pendingAcquires.delete(key));
      pendingAcquires.set(key, pending);
    }
    const stream = await pending;
    // A concurrent await-er may have registered the entry first.
    entry = entries.get(key);
    if (!entry || entry.stream !== stream) {
      entry = { key, stream, refs: 0, lingerTimer: null };
      entries.set(key, entry);
    }
  }

  entry.refs++;
  if (entry.lingerTimer) {
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = null;
  }

  const owned = entry;
  let released = false;
  return {
    stream: owned.stream,
    release: () => {
      if (released) return;
      released = true;
      owned.refs--;
      if (owned.refs <= 0) scheduleDispose(owned);
    },
  };
}
