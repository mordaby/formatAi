import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainToWorker, WorkerToMain } from '../src/worker/protocol';
import { Transfer } from '../src/worker/runtime';
import { loopback, loopbackWorker } from './helpers/loopback';
import {
  RpcAbortedError,
  RpcClient,
  RpcRemoteError,
  RpcTimeoutError,
  RpcWorkerError,
  type WorkerHandle,
} from '../src/worker/rpcClient';

/** A worker the test drives by hand: records what the client posts, lets the test emit replies. */
class FakeWorker implements WorkerHandle {
  posted: { message: MainToWorker; transfer: Transferable[] | undefined }[] = [];
  terminated = false;
  private handlers!: { message(data: WorkerToMain): void; error(message: string): void };

  post(message: MainToWorker, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  listen(handlers: { message(data: WorkerToMain): void; error(message: string): void }): void {
    this.handlers = handlers;
  }

  emit(message: WorkerToMain): void {
    this.handlers.message(message);
  }
  crash(message: string): void {
    this.handlers.error(message);
  }
  get calls(): Extract<MainToWorker, { type: 'call' }>[] {
    return this.posted.map((p) => p.message).filter((m): m is Extract<MainToWorker, { type: 'call' }> => m.type === 'call');
  }
  get hostResults(): Extract<MainToWorker, { type: 'hostResult' }>[] {
    return this.posted.map((p) => p.message).filter((m): m is Extract<MainToWorker, { type: 'hostResult' }> => m.type === 'hostResult');
  }
}

function setup(defaultTimeoutMs = 1000) {
  const workers: FakeWorker[] = [];
  const client = new RpcClient({
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    defaultTimeoutMs,
  });
  return { client, workers };
}

describe('RpcClient protocol', () => {
  it('spawns no worker until the first call', () => {
    const { workers } = setup();
    expect(workers).toHaveLength(0);
  });

  it('sends {id, method, args} and resolves with the worker result', async () => {
    const { client, workers } = setup();
    const p = client.call<string>('learn', { a: 1 });
    const w = workers[0]!;
    expect(w.calls).toEqual([{ type: 'call', id: expect.any(Number), method: 'learn', args: { a: 1 } }]);
    w.emit({ type: 'result', id: w.calls[0]!.id, value: 'ok' });
    await expect(p).resolves.toBe('ok');
  });

  it('gives every call its own id and matches replies to the right call', async () => {
    const { client, workers } = setup();
    const a = client.call<string>('m', 'a');
    const b = client.call<string>('m', 'b');
    const w = workers[0]!;
    const [ida, idb] = w.calls.map((c) => c.id);
    expect(ida).not.toBe(idb);
    w.emit({ type: 'result', id: idb!, value: 'B' });
    w.emit({ type: 'result', id: ida!, value: 'A' });
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
    expect(workers).toHaveLength(1); // one worker serves both
  });

  it('passes the transfer list to the worker (buffers move, not copy)', () => {
    const { client, workers } = setup();
    const buf = new ArrayBuffer(8);
    void client.call('learn', { bytes: buf }, { transfer: [buf] }).catch(() => {});
    expect(workers[0]!.posted[0]!.transfer).toEqual([buf]);
  });

  it('delivers progress events, in order, to onProgress', async () => {
    const { client, workers } = setup();
    const seen: unknown[] = [];
    const p = client.call('learn', null, { onProgress: (x) => seen.push(x) });
    const w = workers[0]!;
    const id = w.calls[0]!.id;
    w.emit({ type: 'progress', id, progress: { phase: 'reading' } });
    w.emit({ type: 'progress', id, progress: { phase: 'checking', fraction: 0.5 } });
    w.emit({ type: 'result', id, value: 1 });
    await p;
    expect(seen).toEqual([{ phase: 'reading' }, { phase: 'checking', fraction: 0.5 }]);
  });

  it('rethrows a worker error, keeping name, message and code', async () => {
    const { client, workers } = setup();
    const p = client.call('convert', null);
    const w = workers[0]!;
    w.emit({ type: 'error', id: w.calls[0]!.id, error: { name: 'UnsupportedFileTypeError', message: 'Unsupported file type', code: 'unsupportedFileType' } });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcRemoteError);
    expect((err as RpcRemoteError).message).toBe('Unsupported file type');
    expect((err as RpcRemoteError).code).toBe('unsupportedFileType');
    expect((err as RpcRemoteError).remoteName).toBe('UnsupportedFileTypeError');
  });

  it('ignores replies for calls that are not pending', () => {
    const { client, workers } = setup();
    void client.call('m', null).catch(() => {});
    expect(() => workers[0]!.emit({ type: 'result', id: 9999, value: 1 })).not.toThrow();
  });

  describe('host calls (the worker asks the main thread to do the HTTP call)', () => {
    it('runs the named host function and posts the answer back', async () => {
      const { client, workers } = setup();
      const callLearn = vi.fn(async (payload: { n: number }) => ({ rules: null, echo: payload.n }));
      const p = client.call('learn', null, { host: { callLearn } });
      const w = workers[0]!;
      const id = w.calls[0]!.id;
      w.emit({ type: 'host', id, cbId: 7, name: 'callLearn', args: [{ n: 42 }] });
      await vi.waitFor(() => expect(w.hostResults).toHaveLength(1));
      expect(callLearn).toHaveBeenCalledWith({ n: 42 });
      expect(w.hostResults[0]).toEqual({ type: 'hostResult', id, cbId: 7, ok: true, value: { rules: null, echo: 42 } });
      w.emit({ type: 'result', id, value: 'done' });
      await expect(p).resolves.toBe('done');
    });

    it('reports a failing host function as an error result, with its code', async () => {
      const { client, workers } = setup();
      const boom = Object.assign(new Error('rate limited'), { code: 'rateLimited' });
      void client.call('learn', null, { host: { callLearn: () => Promise.reject(boom) } }).catch(() => {});
      const w = workers[0]!;
      w.emit({ type: 'host', id: w.calls[0]!.id, cbId: 1, name: 'callLearn', args: [] });
      await vi.waitFor(() => expect(w.hostResults).toHaveLength(1));
      expect(w.hostResults[0]).toMatchObject({ ok: false, error: { name: 'Error', message: 'rate limited', code: 'rateLimited' } });
    });

    it('answers an unknown host function with an error instead of hanging', async () => {
      const { client, workers } = setup();
      void client.call('learn', null, { host: {} }).catch(() => {});
      const w = workers[0]!;
      w.emit({ type: 'host', id: w.calls[0]!.id, cbId: 1, name: 'nope', args: [] });
      await vi.waitFor(() => expect(w.hostResults).toHaveLength(1));
      expect(w.hostResults[0]).toMatchObject({ ok: false, error: { code: 'unknownHost' } });
    });
  });

  describe('timeout (SPEC 15)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('terminates the worker and rejects when a call runs past its timeout', async () => {
      const { client, workers } = setup(1000);
      const p = client.call('learn', null);
      const caught = p.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1001);
      const err = await caught;
      expect(err).toBeInstanceOf(RpcTimeoutError);
      expect((err as RpcTimeoutError).method).toBe('learn');
      expect(workers[0]!.terminated).toBe(true);
    });

    it('starts a fresh worker for the next call after a timeout', async () => {
      const { client, workers } = setup(1000);
      const first = client.call('learn', null).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1001);
      await first;
      expect(workers).toHaveLength(1);

      const second = client.call<string>('convert', null);
      expect(workers).toHaveLength(2);
      const w2 = workers[1]!;
      w2.emit({ type: 'result', id: w2.calls[0]!.id, value: 'fine' });
      await expect(second).resolves.toBe('fine');
      // A reply from the dead worker is ignored.
      expect(() => workers[0]!.emit({ type: 'result', id: 1, value: 'late' })).not.toThrow();
    });

    it('a per-call timeout overrides the default', async () => {
      const { client } = setup(10_000);
      const caught = client.call('learn', null, { timeoutMs: 50 }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(51);
      expect(await caught).toBeInstanceOf(RpcTimeoutError);
    });

    it('does not time out a call that answers in time', async () => {
      const { client, workers } = setup(1000);
      const p = client.call<string>('learn', null);
      await vi.advanceTimersByTimeAsync(900);
      const w = workers[0]!;
      w.emit({ type: 'result', id: w.calls[0]!.id, value: 'ok' });
      await expect(p).resolves.toBe('ok');
      await vi.advanceTimersByTimeAsync(5000);
      expect(w.terminated).toBe(false);
    });

    it('does not count time spent waiting for a host call (a slow LLM is not a hung parser)', async () => {
      const { client, workers } = setup(1000);
      let releaseHost!: () => void;
      const hostDone = new Promise<void>((r) => (releaseHost = r));
      const p = client.call('learn', null, { host: { callLearn: () => hostDone.then(() => 'answer') } });
      const caught = p.catch((e: unknown) => e);
      const w = workers[0]!;
      const id = w.calls[0]!.id;
      w.emit({ type: 'started', id });

      await vi.advanceTimersByTimeAsync(600); // worker busy for 600 ms
      w.emit({ type: 'host', id, cbId: 1, name: 'callLearn', args: [] });
      await vi.advanceTimersByTimeAsync(60_000); // a whole minute waiting for the server
      expect(w.terminated).toBe(false);

      releaseHost();
      await vi.advanceTimersByTimeAsync(0);
      expect(w.hostResults[0]).toMatchObject({ ok: true, value: 'answer' });

      await vi.advanceTimersByTimeAsync(300); // 600 + 300 busy = 900 < 1000
      expect(w.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(200); // now 1100 busy
      expect(await caught).toBeInstanceOf(RpcTimeoutError);
      expect(w.terminated).toBe(true);
    });

    it('a progress event may grant more busy time (`extraTimeOn`): added to what is left, asked of every event', async () => {
      const { client, workers } = setup(1000);
      const extraTimeOn = vi.fn((p: unknown) => (p as { grant?: number }).grant ?? 0);
      const onProgress = vi.fn();
      const caught = client.call('learn', null, { extraTimeOn, onProgress }).catch((e: unknown) => e);
      const w = workers[0]!;
      const id = w.calls[0]!.id;
      w.emit({ type: 'started', id });

      await vi.advanceTimersByTimeAsync(600);
      w.emit({ type: 'progress', id, progress: { grant: 2000 } }); // 400 left + 2000
      w.emit({ type: 'progress', id, progress: { step: 'no grant' } });
      expect(extraTimeOn).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2300); // 2900 busy of 3000
      expect(w.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(await caught).toBeInstanceOf(RpcTimeoutError);
    });

    it('a grant that arrives while a host call is in flight is there when the timer resumes', async () => {
      const { client, workers } = setup(1000);
      let releaseHost!: () => void;
      const hostDone = new Promise<void>((r) => (releaseHost = r));
      const caught = client
        .call('learn', null, { host: { callLearn: () => hostDone }, extraTimeOn: (p) => (p as { grant?: number }).grant ?? 0 })
        .catch((e: unknown) => e);
      const w = workers[0]!;
      const id = w.calls[0]!.id;
      w.emit({ type: 'started', id });
      await vi.advanceTimersByTimeAsync(800);
      w.emit({ type: 'host', id, cbId: 1, name: 'callLearn', args: [] });
      w.emit({ type: 'progress', id, progress: { grant: 1000 } });
      await vi.advanceTimersByTimeAsync(10_000); // waiting on the host: not counted
      releaseHost();
      await vi.advanceTimersByTimeAsync(1100); // 200 left + 1000 granted
      expect(w.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(await caught).toBeInstanceOf(RpcTimeoutError);
    });

    // The audit's case (C4): a round of AI code checks keeps the worker busy (it grants the learn its time), and a live check posted meanwhile
    // waits behind it - its timer must not run while it waits, or it "times out" and the restart kills the learn and the screen's example.
    it('a call\'s busy time counts from when the worker begins it: one queued behind a long call does not time out while it waits', async () => {
      const { client, workers } = setup(1000);
      const learn = client.call<string>('learn', null, { timeoutMs: 30_000 });
      const live = client.call<string>('liveCheck', null, { timeoutMs: 100 });
      const w = workers[0]!;
      const [learnId, liveId] = w.calls.map((c) => c.id);
      w.emit({ type: 'started', id: learnId! });
      await vi.advanceTimersByTimeAsync(20_000); // the learn works; the live check waits
      expect(w.terminated).toBe(false);
      w.emit({ type: 'result', id: learnId!, value: 'learned' });
      await expect(learn).resolves.toBe('learned');
      w.emit({ type: 'started', id: liveId! });
      await vi.advanceTimersByTimeAsync(50);
      w.emit({ type: 'result', id: liveId!, value: 'checked' });
      await expect(live).resolves.toBe('checked');
      expect(w.terminated).toBe(false);
    });

    it('... and once begun it has its own timeout: a call that hangs after it began is still caught', async () => {
      const { client, workers } = setup(1000);
      const caught = client.call('liveCheck', null, { timeoutMs: 100 }).catch((e: unknown) => e);
      const w = workers[0]!;
      await vi.advanceTimersByTimeAsync(60);
      w.emit({ type: 'started', id: w.calls[0]!.id });
      await vi.advanceTimersByTimeAsync(90); // 150 since posted, 90 since begun
      expect(w.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(await caught).toBeInstanceOf(RpcTimeoutError);
      expect(w.terminated).toBe(true);
    });

    it('a cancelled call that the worker never ends is caught by its timeout too (a hang is a hang)', async () => {
      const { client, workers } = setup(1000);
      const ac = new AbortController();
      const caught = client.call('convert', null, { signal: ac.signal, timeoutMs: 500 }).catch((e: unknown) => e);
      const w = workers[0]!;
      w.emit({ type: 'started', id: w.calls[0]!.id });
      ac.abort();
      expect(await caught).toBeInstanceOf(RpcAbortedError);
      expect(w.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(501);
      expect(w.terminated).toBe(true);
    });
  });

  describe('cancel (C5): giving up on one call never restarts the shared worker - what it holds for other screens stays', () => {
    it('a call the worker has not begun: rejects at once, the worker is left alone, and the call before it still answers', async () => {
      const { client, workers } = setup();
      const ac = new AbortController();
      const first = client.call<string>('liveCheck', null);
      const caught = client.call('learn', null, { signal: ac.signal }).catch((e: unknown) => e);
      const w = workers[0]!;
      w.emit({ type: 'started', id: w.calls[0]!.id });
      ac.abort();
      expect(await caught).toBeInstanceOf(RpcAbortedError);
      expect(w.terminated).toBe(false);
      w.emit({ type: 'result', id: w.calls[0]!.id, value: 'ok' });
      await expect(first).resolves.toBe('ok');
    });

    it('a call it has begun: rejects at once, the worker is told (`cancel`) and not restarted; what the call still asks of the main thread is refused, and its late answer goes nowhere', async () => {
      const { client, workers } = setup();
      const ac = new AbortController();
      const callLearn = vi.fn(async () => 'answer');
      const onProgress = vi.fn();
      const caught = client.call('learn', null, { signal: ac.signal, host: { callLearn }, onProgress }).catch((e: unknown) => e);
      const w = workers[0]!;
      const id = w.calls[0]!.id;
      w.emit({ type: 'started', id });
      ac.abort();
      expect(await caught).toBeInstanceOf(RpcAbortedError);
      expect(w.terminated).toBe(false);
      expect(w.posted.map((p) => p.message)).toContainEqual({ type: 'cancel', id });
      w.emit({ type: 'progress', id, progress: { phase: 'verifying' } });
      w.emit({ type: 'host', id, cbId: 1, name: 'callLearn', args: [] });
      await vi.waitFor(() => expect(w.hostResults).toHaveLength(1));
      expect(callLearn).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();
      expect(w.hostResults[0]).toMatchObject({ ok: false, error: { code: 'cancelled' } });
      w.emit({ type: 'error', id, error: { name: 'AbortError', message: 'The call was cancelled', code: 'cancelled' } });
      // The same worker serves the next call.
      const next = client.call<number>('liveCheck', null);
      expect(workers).toHaveLength(1);
      w.emit({ type: 'result', id: w.calls[1]!.id, value: 7 });
      await expect(next).resolves.toBe(7);
    });
  });

  it('an already-aborted signal rejects without touching the worker', async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(client.call('learn', null, { signal: ac.signal })).rejects.toBeInstanceOf(RpcAbortedError);
    expect(workers).toHaveLength(0);
  });

  it('a crashed worker (uncaught error, failed to load) rejects pending calls and is replaced', async () => {
    const { client, workers } = setup();
    const caught = client.call('learn', null).catch((e: unknown) => e);
    workers[0]!.crash('Failed to load worker script');
    const err = await caught;
    expect(err).toBeInstanceOf(RpcWorkerError);
    expect(workers[0]!.terminated).toBe(true);

    void client.call('convert', null).catch(() => {});
    expect(workers).toHaveLength(2);
  });

  it('terminate() rejects pending calls and the next call gets a new worker', async () => {
    const { client, workers } = setup();
    const caught = client.call('learn', null).catch((e: unknown) => e);
    client.terminate();
    expect(await caught).toBeInstanceOf(RpcWorkerError);
    void client.call('convert', null).catch(() => {});
    expect(workers).toHaveLength(2);
  });
});

describe('worker runtime <-> client (loopback with structured clone)', () => {
  it('the worker says when it begins a call, before anything else of it', async () => {
    const seen: string[] = [];
    const handle = loopbackWorker({ m: async (_: unknown, ctx) => void ctx.progress('p') });
    const client = new RpcClient({
      createWorker: () => ({
        ...handle,
        listen: (h) => handle.listen({ ...h, message: (data) => (seen.push(data.type), h.message(data)) }),
      }),
      defaultTimeoutMs: 5000,
    });
    await client.call('m', null);
    expect(seen).toEqual(['started', 'progress', 'result']);
  });

  it('a cancelled call\'s wait on the main thread is refused in the worker, so the method ends (and nothing else of it is asked)', async () => {
    let ended: unknown;
    const client = loopback({
      learnLike: async (_: unknown, ctx) => {
        try {
          await ctx.host('callLearn');
        } catch (e) {
          ended = e;
          // (a later ask is refused at once)
          await ctx.host('callLearn').catch((again: unknown) => (ended = [e, again]));
        }
        return 'ended';
      },
    });
    const ac = new AbortController();
    let release!: () => void;
    const callLearn = vi.fn(() => new Promise<void>((r) => (release = r)));
    const caught = client.call('learnLike', null, { signal: ac.signal, host: { callLearn } }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(callLearn).toHaveBeenCalledTimes(1));
    ac.abort();
    expect(await caught).toBeInstanceOf(RpcAbortedError);
    await vi.waitFor(() => expect(Array.isArray(ended)).toBe(true));
    expect(ended).toMatchObject([{ code: 'cancelled' }, { code: 'cancelled' }]);
    expect(callLearn).toHaveBeenCalledTimes(1);
    release();
  });

  it('runs a method, streams progress, and returns the result', async () => {
    const client = loopback({
      count: async (n: number, ctx) => {
        for (let i = 1; i <= n; i++) ctx.progress({ i });
        return n * 2;
      },
    });
    const seen: unknown[] = [];
    await expect(client.call('count', 3, { onProgress: (p) => seen.push(p) })).resolves.toBe(6);
    expect(seen).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
  });

  it('turns a thrown Error (sync or async) into an error result with its code', async () => {
    const client = loopback({
      syncThrow: () => {
        throw Object.assign(new Error('bad file'), { code: 'unsupportedFileType' });
      },
      asyncThrow: async () => {
        throw new TypeError('nope');
      },
    });
    const a = await client.call('syncThrow', null).catch((e: unknown) => e);
    expect(a).toBeInstanceOf(RpcRemoteError);
    expect(a).toMatchObject({ message: 'bad file', code: 'unsupportedFileType', remoteName: 'Error' });
    const b = await client.call('asyncThrow', null).catch((e: unknown) => e);
    expect(b).toMatchObject({ message: 'nope', remoteName: 'TypeError' });
  });

  it('answers an unknown method with an error', async () => {
    const client = loopback({});
    await expect(client.call('nothing', null)).rejects.toMatchObject({ code: 'unknownMethod' });
  });

  it('lets a method call back into the main thread and use the answer', async () => {
    const client = loopback({
      learnLike: async (_: unknown, ctx) => {
        const answer = await ctx.host<{ rules: string }>('callLearn', { payload: 'p' });
        return `worker got ${answer.rules}`;
      },
    });
    const callLearn = vi.fn(async (p: { payload: string }) => ({ rules: `rules-for-${p.payload}` }));
    await expect(client.call('learnLike', null, { host: { callLearn } })).resolves.toBe('worker got rules-for-p');
    expect(callLearn).toHaveBeenCalledWith({ payload: 'p' });
  });

  it('a host error reaches the worker method as a normal rejection (and can propagate)', async () => {
    const client = loopback({
      learnLike: async (_: unknown, ctx) => ctx.host('callLearn'),
    });
    const err = await client
      .call('learnLike', null, { host: { callLearn: () => Promise.reject(Object.assign(new Error('limit'), { code: 'limitHit' })) } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcRemoteError);
    expect(err).toMatchObject({ message: 'limit', code: 'limitHit' });
  });

  it('moves ArrayBuffers instead of copying them, in both directions', async () => {
    const client = loopback({
      double: async (args: { bytes: ArrayBuffer }) => {
        const out = new Uint8Array(args.bytes.byteLength * 2).fill(7);
        return new Transfer({ bytes: out.buffer as ArrayBuffer }, [out.buffer as ArrayBuffer]);
      },
    });
    const bytes = new ArrayBuffer(4);
    const result = await client.call<{ bytes: ArrayBuffer }>('double', { bytes }, { transfer: [bytes] });
    expect(bytes.byteLength).toBe(0); // detached: it moved to the worker
    expect(result.bytes.byteLength).toBe(8);
    expect(new Uint8Array(result.bytes)[0]).toBe(7);
  });
});
