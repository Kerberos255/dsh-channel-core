// The SDK can hang before the READY event. These deadlines do not bypass its
// own reconnect/RESUME behavior once a healthy connection has been established.
export async function awaitDiscordStartup(client, token, signal, {
  loginTimeoutMs = 45_000, readyTimeoutMs = 15_000,
  timer = setTimeout, cancelTimer = clearTimeout,
} = {}) {
  const deadline = (promise, timeout, code) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error('Discord connection aborted'), { code: 'aborted' }));
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      cancelTimer(clock);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => done(Object.assign(new Error('Discord connection aborted'), { code: 'aborted' }));
    const clock = timer(() => done(Object.assign(new Error(code), { code })), timeout);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => done(null, value), done);
  });
  await deadline(Promise.resolve().then(() => client.login(token)), loginTimeoutMs, 'discord-login-timeout');
  if (typeof client.isReady === 'function' && !client.isReady()) {
    await deadline(new Promise((resolve, reject) => {
      const onReady = () => { clean(); resolve(); };
      const onError = err => { clean(); reject(err); };
      const clean = () => {
        client.off('clientReady', onReady);
        client.off('error', onError);
      };
      client.on('clientReady', onReady);
      client.on('error', onError);
      if (client.isReady()) onReady();
    }), readyTimeoutMs, 'discord-ready-timeout');
  }
}
